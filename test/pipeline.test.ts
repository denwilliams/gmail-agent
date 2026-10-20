import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCENARIOS } from "../src/fake-data";

/**
 * End-to-end pipeline tests. They start the real Worker + Durable Object under `wrangler dev` in
 * FAKE_MODE (stub Gmail, Jev, models and push) and drive it over HTTP, so the SQLite storage, the
 * scheduler and the Pi harness are all the real thing.
 */

let proc: ChildProcess;
let base = "";
let cookie = "";
let dir = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function raw(method: string, path: string, body?: unknown, withCookie = true) {
  return fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, `/api${path}`, body);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}
const get = <T = any>(p: string) => api<T>("GET", p);
const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);

const deliver = (scenario: string) => post<{ ids: string[] }>("/fake/deliver", { scenario }).then((r) => r.ids[0]!);
const poll = () => post<{ processed: number }>("/poll");
const feed = () => get<any[]>("/feed");
const bySubject = async (subject: string) => (await feed()).find((r) => r.subject === subject);
const sc = (key: string) => SCENARIOS.find((s) => s.key === key)!;
const advance = (ms: number) => post("/fake/clock", { advanceMs: ms });
const MIN = 60_000;
const HOUR = 3600_000;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gmail-agent-test-"));
  const port = await freePort();
  base = `http://localhost:${port}`;
  const vars = {
    FAKE_MODE: "1",
    ALLOWED_EMAILS: "demo@example.com",
    SESSION_SECRET: "test-secret",
    TYPESAFE_API_KEY: "fake",
    GOOGLE_CLIENT_ID: "fake",
    GOOGLE_CLIENT_SECRET: "fake",
  };
  proc = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(port), "--persist-to", dir,
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ],
    { cwd: process.cwd(), detached: true, stdio: "ignore" },
  );
  await until(async () => {
    try {
      return (await fetch(`${base}/api/me`)).ok;
    } catch {
      return false;
    }
  }, 90_000);

  // the fake sign-in flow, exactly as the browser does it
  const login = await raw("GET", "/auth/login", undefined, false);
  expect(login.status).toBe(302);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toMatch(/^ga_session=/);
});

afterAll(() => {
  try {
    if (proc?.pid) process.kill(-proc.pid, "SIGKILL");
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await post("/fake/auto", { on: false }); // tests drive every job themselves
  await post("/fake/reset");
  await put("/settings", { timezone: "UTC", digestHours: [] });
});

describe("access", () => {
  it("rejects requests without a session", async () => {
    expect((await raw("GET", "/api/feed", undefined, false)).status).toBe(401);
    expect((await raw("POST", "/api/fake/reset", {}, false)).status).toBe(401);
  });
  it("never exposes the internal connect route", async () => {
    expect((await raw("POST", "/api/internal/connect", {})).status).toBe(404);
  });
  it("reports fake mode and a connected mailbox", async () => {
    const st = await get("/status");
    expect(st.connected).toBe(true);
    expect(st.fake.scenarios.length).toBe(SCENARIOS.length);
  });
});

describe("poll", () => {
  it("applies the expected action to every sample email", async () => {
    await post("/fake/deliver", { all: true });
    expect((await poll()).processed).toBe(SCENARIOS.length);
    const rows = await feed();
    expect(rows).toHaveLength(SCENARIOS.length);
    for (const s of SCENARIOS) {
      const row = rows.find((r) => r.subject === s.subject)!;
      expect(row.action, `${s.key}: ${row.reasons}`).toBe(s.expect);
    }
  });

  it("is incremental: a second poll only sees new mail", async () => {
    await deliver("promo");
    expect((await poll()).processed).toBe(1);
    expect((await poll()).processed).toBe(0);
    await deliver("newsletter");
    expect((await poll()).processed).toBe(1);
  });

  it("archives and digests in Gmail, and leaves kept and alerted mail in the inbox", async () => {
    await post("/fake/deliver", { all: true });
    await poll();
    const msgs = await get<any[]>("/fake/messages");
    const labelsFor = (key: string) => msgs.find((m) => m.subject === sc(key).subject).labels as string[];
    expect(labelsFor("promo")).not.toContain("INBOX");
    expect(labelsFor("promo")).toContain("Label_agent_archived");
    expect(labelsFor("ci")).not.toContain("INBOX");
    expect(labelsFor("ci")).toContain("Label_agent_digest");
    expect(labelsFor("invoice")).toContain("INBOX");
    expect(labelsFor("outage")).toContain("INBOX");
  });

  it("summarises only what stays in the inbox", async () => {
    await post("/fake/deliver", { all: true });
    await poll();
    const rows = await feed();
    for (const r of rows) {
      if (r.action === "keep" || r.action === "alert") expect(r.summary, r.subject).toBeTruthy();
      else expect(r.summary, r.subject).toBeNull();
    }
  });

  it("records notifications in the app even though Pushover isn't configured", async () => {
    expect((await get("/status")).push.configured).toBe(false);
    await deliver("outage");
    await poll();
    const [n] = await get<any[]>("/notifications");
    expect(n).toMatchObject({ title: expect.stringContaining("Production API is down"), priority: 5, status: "demo", error: null });
    expect(n.click).toContain("mail.google.com");
  });

  it("pushes an alert for an outage and nothing for quiet mail", async () => {
    await deliver("promo");
    await deliver("outage");
    await poll();
    const pushes = await get<any[]>("/notifications");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toContain("Production API is down");
    expect(pushes[0].priority).toBe(5);
  });
});

describe("poll interval", () => {
  it("defaults to every 10 minutes", async () => {
    expect((await get("/status")).settings.pollSeconds).toBe(600);
  });

  it("has one scheduled wake-up and no fixed heartbeat", async () => {
    await post("/fake/auto", { on: true });
    try {
      await put("/settings", { pollSeconds: 600 });
      await poll();
      await put("/settings", { pollSeconds: 900 }); // changing it must not leave a second schedule behind
      await put("/settings", { pollSeconds: 600 });
      const st = await get("/status");
      expect(st.schedules).toHaveLength(1);
      expect(st.schedules[0].type).not.toBe("interval");
      // the wake-up is for when the poll is due (about 10 minutes after the last one), not seconds away
      const inMs = st.schedules[0].at - Date.now();
      expect(inMs).toBeGreaterThan(8 * MIN);
      expect(inMs).toBeLessThanOrEqual(10 * MIN + 5_000);
      expect(st.nextPoll).toBe(st.lastPoll + 600_000);
    } finally {
      await post("/fake/auto", { on: false });
    }
  });

  it("removes the old recurring 15-second heartbeat that earlier deployments saved", async () => {
    await post("/fake/auto", { on: true });
    try {
      await post("/fake/legacy-heartbeat");
      const before = await get("/status");
      expect(before.schedules.some((s: any) => s.type === "interval")).toBe(true);

      await put("/settings", { pollSeconds: 600 }); // any change re-runs the scheduler, as a restart does
      const after = await until(async () => {
        const st = await get("/status");
        return !st.schedules.some((s: any) => s.type === "interval") && st;
      });
      expect(after.schedules).toHaveLength(1);
      expect(after.schedules[0].type).not.toBe("interval");
    } finally {
      await post("/fake/auto", { on: false });
    }
  });

  it("wakes at the next digest hour when that comes before the next poll", async () => {
    await post("/fake/auto", { on: true });
    try {
      await put("/settings", { pollSeconds: 3600, timezone: "UTC", digestHours: [] });
      await poll();
      const { now } = (await get("/status")).fake;
      const nextHour = (new Date(now).getUTCHours() + 1) % 24;
      await put("/settings", { digestHours: [nextHour] });
      const st = await get("/status");
      expect(st.schedules).toHaveLength(1);
      const inMs = st.schedules[0].at - Date.now();
      expect(inMs).toBeGreaterThan(0);
      expect(inMs).toBeLessThanOrEqual(3600_000 + 5_000); // top of the next hour, never later than the poll
    } finally {
      await post("/fake/auto", { on: false });
    }
  });

  it("sleeps for an hour when auto-run is off, with nothing to do", async () => {
    const st = await get("/status");
    expect(st.schedules).toHaveLength(1);
    expect(st.schedules[0].at - Date.now()).toBeGreaterThan(50 * MIN);
  });

  it("is saved, and clamped to 15 seconds .. 1 hour", async () => {
    expect((await put("/settings", { pollSeconds: 600 })).pollSeconds).toBe(600);
    expect((await put("/settings", { pollSeconds: 5 })).pollSeconds).toBe(15);
    expect((await put("/settings", { pollSeconds: 999999 })).pollSeconds).toBe(3600);
    expect((await get("/status")).settings.pollSeconds).toBe(3600);
  });

  it("waits for the interval before checking again", async () => {
    await put("/settings", { pollSeconds: 300 });
    await post("/fake/auto", { on: true });
    try {
      await deliver("friend");
      await post("/fake/run", { job: "tick" }); // first ever check: nothing to wait for
      expect(await feed()).toHaveLength(1);

      await deliver("promo");
      await advance(4 * MIN);
      await post("/fake/run", { job: "tick" }); // 4 minutes: not due yet
      expect(await feed()).toHaveLength(1);

      await advance(61_000);
      await post("/fake/run", { job: "tick" }); // 5 minutes 1 second: due
      expect(await feed()).toHaveLength(2);
    } finally {
      await post("/fake/auto", { on: false });
    }
  });
});

describe("overlapping polls", () => {
  const stageCount = async (stage: string) =>
    ((await get("/activity")).byStage.find((s: any) => s.stage === stage)?.n ?? 0) as number;

  it("never process, pay for or notify about the same email twice", async () => {
    await post("/fake/latency", { ms: 15 }); // real Gmail calls take time; this lets polls interleave
    try {
      await deliver("outage");
      for (const k of ["promo", "newsletter", "friend", "invoice", "receipt"]) await deliver(k);
      await Promise.all([poll(), poll(), poll()]);
      expect(await feed()).toHaveLength(6);
      expect(await stageCount("classify")).toBe(6);
      expect(await stageCount("judge")).toBe(6);
      expect(await get<any[]>("/notifications")).toHaveLength(1); // the outage alert, once
    } finally {
      await post("/fake/latency", { ms: 0 });
    }
  });

  it("a poll started while another is running joins it instead of starting a second", async () => {
    await post("/fake/latency", { ms: 15 });
    try {
      for (const k of ["promo", "newsletter", "friend"]) await deliver(k);
      const [a, b] = await Promise.all([poll(), poll()]);
      expect(a).toEqual(b);
      expect(a.processed).toBe(3);
      expect(await stageCount("classify")).toBe(3); // one poll's worth, not two
    } finally {
      await post("/fake/latency", { ms: 0 });
    }
  });
});

describe("weights change outcomes", () => {
  it("a sender boost rescues an email from the archive", async () => {
    await put("/weights", { dim: "sender", key: "newsletter@weeklybyte.io", weight: 3 });
    await deliver("newsletter");
    await poll();
    expect((await bySubject(sc("newsletter").subject)).action).toBe("keep");
  });

  it("a heavy down-weight takes the fast path: Jev is only asked about urgency", async () => {
    await put("/weights", { dim: "sender", key: "orders@ubereats.com", weight: 0.2 });
    await deliver("receipt");
    await poll();
    const row = await bySubject(sc("receipt").subject);
    expect(row.action).toBe("archive");
    expect(row.reasons).toContain("fast path");
    const { calls } = await get("/activity");
    const stages = calls.filter((c: any) => c.subject === sc("receipt").subject).map((c: any) => c.stage);
    expect(stages).toContain("judge-fast");
    expect(stages).not.toContain("judge");
  });

  it("a down-weighted sender can still break through when it is urgent", async () => {
    await put("/weights", { dim: "sender", key: "alerts@pagerduty.com", weight: 0.2 });
    await deliver("outage");
    await poll();
    expect((await bySubject(sc("outage").subject)).action).toBe("alert");
  });

  it("sender beats stream beats domain, and the card says which one applied", async () => {
    await put("/weights", { dim: "domain", key: "github.com", weight: 0.5 });
    await put("/weights", { dim: "stream", key: "api.acme.github.com", weight: 2 });
    await deliver("ci");
    await poll();
    const row = await bySubject(sc("ci").subject);
    const parts = JSON.parse(row.weight_parts);
    expect(row.weight).toBe(2);
    expect(parts.find((p: any) => p.dim === "stream").applied).toBe(true);
    expect(parts.find((p: any) => p.dim === "domain").applied).toBe(false);
  });

  it("category and kind weights multiply", async () => {
    await put("/weights", { dim: "category", key: "notification", weight: 0.5 });
    await put("/weights", { dim: "kind", key: "digest", weight: 0.5 });
    await deliver("ci");
    await poll();
    expect((await bySubject(sc("ci").subject)).weight).toBeCloseTo(0.25);
  });
});

describe("guards", () => {
  it("never hides mail from someone you've replied to, even when down-weighted", async () => {
    await put("/weights", { dim: "sender", key: "jordan@conference-co.com", weight: 0.2 });
    await deliver("promo-known");
    await poll();
    const row = await bySubject(sc("promo-known").subject);
    expect(row.action).toBe("keep");
    expect(row.reasons).toContain("replied to this sender");
  });

  it("never hides a protected category", async () => {
    await put("/weights", { dim: "category", key: "security", weight: 0.2 });
    await deliver("security");
    await poll();
    expect((await bySubject(sc("security").subject)).action).toBe("keep");
  });
});

describe("categories grow", () => {
  it("unknown mail lands in 'other' and is kept; a new category claims the next one", async () => {
    await deliver("school");
    await poll();
    const first = await bySubject(sc("school").subject);
    expect(first.category).toBe("other");
    expect(first.action).toBe("keep");

    await put("/categories", { name: "school", description: "Notices, forms and excursions from the kids' school" });
    await deliver("school");
    await poll();
    const rows = (await feed()).filter((r) => r.subject === sc("school").subject);
    expect(rows).toHaveLength(2);
    expect(rows[0].category).toBe("school"); // newest first
  });
});

describe("explicit feedback", () => {
  it("a vote moves the weight of the dimension you pick", async () => {
    const id = await deliver("ci");
    await poll();
    await post("/vote", { id, dir: -1, scope: "stream" });
    const streams = await get<any[]>("/weights?dim=stream");
    const w = streams.find((r) => r.key === "api.acme.github.com|ci_activity");
    expect(w.weight).toBeCloseTo(0.8);
    expect(w.source).toBe("vote");
    await deliver("ci");
    await poll();
    const newest = (await feed())[0];
    expect(newest.weight).toBeCloseTo(0.8);
  });

  it("undoing an archive puts the mail back and boosts the sender", async () => {
    const id = await deliver("promo");
    await poll();
    expect((await bySubject(sc("promo").subject)).action).toBe("archive");
    await post("/undo", { id });
    const labels = (await get<any[]>("/fake/messages")).find((m) => m.id === id).labels;
    expect(labels).toContain("INBOX");
    const w = (await get<any[]>("/weights?dim=sender")).find((r) => r.key === "hello@shoeco.com");
    expect(w.weight).toBeCloseTo(1.3);
  });

  it("every change is logged with its source", async () => {
    await put("/weights", { dim: "domain", key: "x.com", weight: 2, reason: "test" });
    await post("/weights/preset", { dim: "domain", key: "x.com", preset: "ignore" });
    const log = await get<any[]>("/weights/log");
    expect(log[0]).toMatchObject({ dim: "domain", key: "x.com", before: 2, after: 0.2, source: "manual" });
  });
});

describe("digest", () => {
  it("sends one digest of everything held back, then nothing", async () => {
    await deliver("ci");
    await deliver("receipt");
    await poll();
    expect(await post("/digest")).toEqual({ items: 2 });
    const pushes = await get<any[]>("/notifications");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toBe("Inbox digest (2)");
    expect(pushes[0].priority).toBe(3);
    expect(await post("/digest")).toEqual({ items: 0 });
    expect(await get<any[]>("/notifications")).toHaveLength(1);
  });

  it("fires at the configured hour, once per slot", async () => {
    await deliver("ci");
    await poll();
    const hour = (now: number) => new Date(now).getUTCHours();
    const { now } = (await get("/status")).fake;
    await put("/settings", { timezone: "UTC", digestHours: [hour(now)] });

    await post("/fake/run", { job: "digest" });
    expect(await get<any[]>("/notifications")).toHaveLength(1);

    await deliver("receipt");
    await poll();
    await post("/fake/run", { job: "digest" }); // same hour: must not fire again
    expect(await get<any[]>("/notifications")).toHaveLength(1);

    await advance(HOUR);
    const next = (await get("/status")).fake.now;
    await put("/settings", { digestHours: [hour(next)] });
    await post("/fake/run", { job: "digest" });
    const pushes = await get<any[]>("/notifications");
    expect(pushes).toHaveLength(2);
    expect(pushes[0].title).toBe("Inbox digest (1)");
  });

  it("does not fire outside the configured hours", async () => {
    await deliver("ci");
    await poll();
    const { now } = (await get("/status")).fake;
    await put("/settings", { timezone: "UTC", digestHours: [(new Date(now).getUTCHours() + 5) % 24] });
    await post("/fake/run", { job: "digest" });
    expect(await get<any[]>("/notifications")).toHaveLength(0);
  });
});

describe("learning from what you do", () => {
  it("proposes boosting a sender when you rescue its archived mail", async () => {
    const id = await deliver("promo");
    await poll();
    await post("/fake/act", { id, act: "rescue" });

    await post("/fake/run", { job: "learn" });
    expect(await get<any[]>("/proposals")).toHaveLength(0); // too soon: we wait 30 minutes

    await advance(31 * MIN);
    await post("/fake/run", { job: "learn" });
    const proposals = await get<any[]>("/proposals");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ dim: "sender", key: "hello@shoeco.com" });
    expect(proposals[0].suggested).toBeCloseTo(1.3);
    expect((await bySubject(sc("promo").subject)).outcome).toBe("rescued");

    // nothing changes until accepted
    expect((await get<any[]>("/weights?dim=sender")).find((r) => r.key === "hello@shoeco.com").weight).toBeNull();
    await post("/proposals/resolve", { id: proposals[0].id, accept: true });
    const w = (await get<any[]>("/weights?dim=sender")).find((r) => r.key === "hello@shoeco.com");
    expect(w.weight).toBeCloseTo(1.3);
    expect(w.source).toBe("learned");
    expect(await get<any[]>("/proposals")).toHaveLength(0);
  });

  it("a rejected proposal changes nothing and is not re-proposed immediately", async () => {
    const id = await deliver("promo");
    await poll();
    await post("/fake/act", { id, act: "star" });
    await advance(31 * MIN);
    await post("/fake/run", { job: "learn" });
    const [p] = await get<any[]>("/proposals");
    await post("/proposals/resolve", { id: p.id, accept: false });
    expect(await get<any[]>("/proposals")).toHaveLength(0);
    expect((await get<any[]>("/weights?dim=sender")).find((r) => r.key === "hello@shoeco.com").weight).toBeNull();
  });

  it("proposes lowering a sender after you archive three of its emails unread", async () => {
    const ids = [await deliver("review"), await deliver("review"), await deliver("review")];
    await poll();
    expect((await feed()).every((r) => r.action === "keep")).toBe(true);
    for (const id of ids) await post("/fake/act", { id, act: "archive" });
    await advance(31 * MIN);
    await post("/fake/run", { job: "learn" });
    const [p] = await get<any[]>("/proposals");
    expect(p).toMatchObject({ dim: "sender", key: "notifications@github.com" });
    expect(p.suggested).toBeCloseTo(0.7);
  });

  it("does not propose on fewer than three dismissals", async () => {
    const ids = [await deliver("review"), await deliver("review")];
    await poll();
    for (const id of ids) await post("/fake/act", { id, act: "archive" });
    await advance(31 * MIN);
    await post("/fake/run", { job: "learn" });
    expect(await get<any[]>("/proposals")).toHaveLength(0);
  });

  it("proposes lowering a sender whose mail sits unread for days", async () => {
    for (let i = 0; i < 5; i++) await deliver("review");
    await poll();
    await advance(73 * HOUR);
    await post("/fake/run", { job: "learn" });
    const [p] = await get<any[]>("/proposals");
    expect(p).toMatchObject({ dim: "sender", key: "notifications@github.com" });
    expect(p.suggested).toBeCloseTo(0.8);
    expect((await feed()).every((r) => r.outcome === "ignored")).toBe(true);
  });

  it("treats mail you read or replied to as engaged, with no proposal", async () => {
    const a = await deliver("friend");
    await poll();
    await post("/fake/act", { id: a, act: "read" });
    await advance(31 * MIN);
    await post("/fake/run", { job: "learn" });
    expect((await bySubject(sc("friend").subject)).outcome).toBe("engaged");
    expect(await get<any[]>("/proposals")).toHaveLength(0);
  });
});

describe("activity and cost", () => {
  it("logs every Jev and Luna call with tokens and cost", async () => {
    await post("/fake/deliver", { all: true });
    await poll();
    const a = await get("/activity");
    const stages = a.byStage.map((s: any) => s.stage);
    expect(stages).toEqual(expect.arrayContaining(["classify", "judge", "summary"]));
    expect(a.byStage.find((s: any) => s.stage === "classify").n).toBe(SCENARIOS.length);
    expect(a.totals.all).toBeGreaterThan(0);
    expect(a.calls.every((c: any) => c.cost >= 0 && c.model)).toBe(true);
    expect((await get("/status")).costToday).toBeGreaterThan(0);
  });
});

describe("chat agent (real PiHarness, scripted model)", () => {
  it("runs a tool end to end and the change is visible in the weights", async () => {
    await post("/chat", { message: "treat boss@acme.com as important" });
    const w = await until(async () =>
      (await get<any[]>("/weights?dim=sender")).find((r) => r.key === "boss@acme.com" && r.weight !== null),
    );
    expect(w.weight).toBe(3);
    expect(w.source).toBe("chat");

    // the conversation shows a final answer, and the transcript shows the tool call and its result
    const log = await until(async () => {
      const l = await get<{ role: string; text: string }[]>("/chat");
      return l.some((m) => m.role === "assistant" && m.text.startsWith("Done.")) && l;
    });
    expect(log[0]).toMatchObject({ role: "user" });

    const steps = await until(async () => {
      const s = await get<any[]>("/activity/chat");
      return s.some((x) => x.kind === "result") && s;
    });
    const tool = steps.find((s) => s.kind === "tool");
    expect(tool).toMatchObject({ name: "set_weight" });
    expect(steps.find((s) => s.kind === "result").isError).toBe(false);
  });

  it("can add a category from chat, and the next email uses it", async () => {
    await post("/chat", { message: "add a category for school: notices and forms from the school" });
    await until(async () => (await get<any[]>("/categories")).some((c) => c.name === "school"));
    await deliver("school");
    await poll();
    expect((await bySubject(sc("school").subject)).category).toBe("school");
  });
});
