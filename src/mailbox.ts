import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createLlm } from "./llm";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { refreshAccessToken } from "./auth";
import type { Env } from "./env";
import { fakeDigest, fakeJev, fakeSummary } from "./fake-jev";
import { scenarioByKey, SCENARIOS } from "./fake-data";
import { createFakeChat, FAKE_TABLES, FakeGmail, seedKnownContacts, type UserAct } from "./fake";
import {
  addressedTo,
  Gmail,
  isBulk,
  type MailApi,
  recipientAlias,
  senderDomain,
  senderEmail,
  streamKeys,
  type MailMessage,
} from "./gmail";
import { classify, DEFAULT_CATEGORIES, judge, type CategoryDef, type OnUsage } from "./jev";
import { push, pushoverConfigured, type Notification } from "./notify";
import {
  clampPoll,
  clampWeight,
  decide,
  DEFAULT_SETTINGS,
  resolveWeight,
  type Action,
  type Settings,
  type Signals,
  type WeightKeys,
} from "./policy";

const LABEL_ARCHIVED = "Agent/Archived";
const LABEL_DIGEST = "Agent/Digest";
const SELF_ID = "1";
const LEARN_EVERY_MS = 10 * 60_000;
const LEARN_AFTER_MS = 30 * 60_000;
const IGNORED_AFTER_MS = 72 * 3600_000;

export const DIMS = ["sender", "stream", "domain", "alias", "category", "kind"] as const;
export type Dim = (typeof DIMS)[number];
export type WeightSource = "vote" | "chat" | "manual" | "learned";

/** emails column that holds each dimension's key (used for counts and voting). */
const DIM_COLUMN: Record<Dim, string> = {
  sender: "sender_addr",
  stream: "stream",
  domain: "domain",
  alias: "alias",
  category: "category",
  kind: "kind",
};

export interface FeedRow {
  id: string;
  thread_id: string;
  sender: string;
  subject: string;
  summary: string | null;
  category: string;
  kind: string;
  attention: number;
  action: Action;
  reasons: string;
  weight: number;
  weight_parts: string;
  signals: string;
  stream: string | null;
  received_at: number;
  vote: number;
  undone: number;
  outcome: string | null;
}

interface UsageRow {
  stage: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  ms: number;
}

const text = (s: string) => ({ output: [{ type: "text" as const, text: s }] });
const dimSchema = Type.Union(DIMS.map((d) => Type.Literal(d)));

/**
 * One Durable Object per mailbox. Holds the Gmail tokens, taste weights, feed, activity log and
 * the chat agent, and runs the poll loop from its own schedule.
 */
export class Mailbox extends Agent<Env> {
  llm = createLlm(this.env);
  registry = createRegistry();
  /** Offline stand-ins, only when FAKE_MODE=1 (the worker refuses it off localhost). */
  fakeChat = this.env.FAKE_MODE === "1" ? createFakeChat() : null;

  harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "mailbox",
        sections: [
          {
            key: "role",
            tag: false,
            render: () =>
              [
                "You are the tuning assistant for a Gmail triage agent. The agent polls the inbox, ",
                "classifies each email, weights it, then archives, digests, keeps or alerts. ",
                "You do not read or send mail. Your job is to change the taste settings when the user ",
                "asks, using your tools, and to explain past decisions (use recent_decisions, which shows ",
                "which weights applied). Weights are multipliers: 1 neutral, 0.2 nearly always hidden, ",
                "3 strongly boosted. Dimensions: sender, stream (mailing list or notification stream), ",
                "domain, alias (which of the user's addresses it was sent to), category and kind. ",
                "Identity weights (sender > stream > domain) compete, the most specific wins; ",
                "category, kind and alias multiply. Prefer small changes and the narrowest dimension that ",
                "fits. Always confirm what you changed with old and new values. Never claim a change you ",
                "did not make with a tool.",
              ].join(""),
          },
          { key: "settings", render: () => JSON.stringify(this.settings(), null, 2) },
          { key: "categories", render: () => JSON.stringify(this.categories()) },
          { key: "rules", render: () => JSON.stringify(this.rules()) },
          { key: "today", render: () => new Date().toISOString() },
        ],
        tools: this.tools(),
      });
      let models = this.llm.models;
      if (this.fakeChat) {
        models = createModels();
        models.setProvider(this.fakeChat.provider);
      } else {
        await this.llm.ready;
      }
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: {
      model: this.fakeChat ? this.fakeChat.getModel() : { provider: "openai", id: this.env.CHAT_MODEL },
      thinkingLevel: "low",
    },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, thread_id TEXT, sender TEXT, sender_addr TEXT, domain TEXT, alias TEXT,
      stream TEXT, subject TEXT, snippet TEXT, summary TEXT, category TEXT, kind TEXT,
      importance REAL, needs_action REAL, urgent REAL, attention REAL, action TEXT, reasons TEXT,
      weight REAL, weight_parts TEXT, signals TEXT, flags TEXT, received_at INTEGER,
      processed_at INTEGER, vote INTEGER DEFAULT 0, undone INTEGER DEFAULT 0,
      outcome TEXT, digested_at INTEGER)`;
    this.sql`CREATE INDEX IF NOT EXISTS emails_received ON emails (received_at DESC)`;
    this.sql`CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY, description TEXT NOT NULL, protected INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS dim_weights (
      dim TEXT, key TEXT, weight REAL NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (dim, key))`;
    this.sql`CREATE TABLE IF NOT EXISTS weight_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, dim TEXT, key TEXT,
      before REAL, after REAL, source TEXT, reason TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, email_id TEXT, stage TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cost REAL, ms INTEGER)`;
    this.sql`CREATE INDEX IF NOT EXISTS calls_ts ON calls (ts DESC)`;
    this.sql`CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, dim TEXT, key TEXT, suggested REAL,
      reason TEXT, status TEXT NOT NULL DEFAULT 'pending')`;
    this.sql`CREATE TABLE IF NOT EXISTS contacts (
      email TEXT PRIMARY KEY, replied INTEGER NOT NULL, checked_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, title TEXT, body TEXT, priority INTEGER,
      click TEXT, status TEXT, error TEXT)`;

    if (this.fake) for (const ddl of FAKE_TABLES) this.ctx.storage.sql.exec(ddl);
    if (!this.sql<{ n: number }>`SELECT COUNT(*) n FROM categories`[0]?.n) {
      DEFAULT_CATEGORIES.forEach((c, i) => this.upsertCategory(c, i));
    }
    // One wake-up, set for exactly when the next poll or digest is due. This also removes the old
    // recurring 15-second heartbeat that earlier deployments saved on this object.
    await this.scheduleNext();
  }

  // ---- fake mode plumbing -----------------------------------------------

  private get fake(): boolean {
    return this.env.FAKE_MODE === "1";
  }

  /** Wall clock plus the demo offset, so the demo can fast-forward through learn and digest windows. */
  now(): number {
    return Date.now() + (this.fake ? Number(this.getKv("clock_offset") ?? 0) : 0);
  }

  private fakeGmail(): FakeGmail {
    return new FakeGmail(
      this.ctx.storage.sql,
      () => this.now(),
      this.getKv("account") ?? "demo@example.com",
      Number(this.getKv("fake_latency_ms") ?? 0),
    );
  }

  /**
   * One place every notification goes through. It is always recorded in the app, so nothing is
   * lost when Pushover isn't configured; Pushover is an optional delivery channel on top.
   * status: sent (Pushover accepted it), skipped (Pushover not configured), failed, or demo (fake mode).
   */
  private async notify(n: Notification) {
    let status: "sent" | "skipped" | "failed" | "demo" = "demo";
    let error: string | null = null;
    if (!this.fake) {
      try {
        status = await push(this.env, n);
      } catch (e) {
        status = "failed";
        error = e instanceof Error ? e.message : String(e);
        console.error("push failed", e);
      }
    }
    this.sql`INSERT INTO notifications (ts, title, body, priority, click, status, error)
      VALUES (${this.now()}, ${n.title}, ${n.body}, ${n.priority ?? 4}, ${n.click ?? null}, ${status}, ${error})`;
    this.notifyClients("activity");
  }

  notifications() {
    return this.sql`SELECT ts, title, body, priority, click, status, error FROM notifications
      ORDER BY id DESC LIMIT 50`;
  }

  // ---- kv / settings ----------------------------------------------------

  private getKv(key: string): string | undefined {
    return this.sql<{ value: string }>`SELECT value FROM kv WHERE key = ${key}`[0]?.value;
  }
  private setKv(key: string, value: string) {
    this.sql`INSERT INTO kv (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  settings(): Settings {
    const raw = this.getKv("settings");
    // POLL_SECONDS (wrangler config) sets the default; a value saved in the app overrides it.
    const base = { ...DEFAULT_SETTINGS };
    if (Number(this.env.POLL_SECONDS) > 0) base.pollSeconds = clampPoll(Number(this.env.POLL_SECONDS));
    return { ...base, ...(raw ? JSON.parse(raw) : {}) };
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    next.pollSeconds = clampPoll(next.pollSeconds);
    next.digestHours = [...new Set((next.digestHours ?? []).map(Number))]
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
      .sort((a, b) => a - b);
    this.setKv("settings", JSON.stringify(next));
    this.notifyClients("settings");
    this.kickSchedule();
    return next;
  }
  rules(): string[] {
    return this.sql<{ text: string }>`SELECT text FROM rules ORDER BY id`.map((r) => r.text);
  }
  addRule(rule: string) {
    this.sql`INSERT INTO rules (text) VALUES (${rule})`;
    this.notifyClients("weights");
    return this.rules();
  }
  removeRule(rule: string) {
    this.sql`DELETE FROM rules WHERE text = ${rule}`;
    this.notifyClients("weights");
    return this.rules();
  }

  // ---- categories -------------------------------------------------------

  categories(): CategoryDef[] {
    return this.sql<{ name: string; description: string; protected: number }>`
      SELECT name, description, protected FROM categories ORDER BY sort, name`.map((c) => ({
      name: c.name,
      description: c.description,
      protected: !!c.protected,
    }));
  }
  upsertCategory(c: CategoryDef, sort?: number) {
    const name = c.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!name) throw new Error("category name required");
    const order = sort ?? this.sql<{ n: number }>`SELECT COALESCE(MAX(sort), 0) + 1 n FROM categories`[0]!.n;
    this.sql`INSERT INTO categories (name, description, protected, sort)
      VALUES (${name}, ${c.description}, ${c.protected ? 1 : 0}, ${order})
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, protected = excluded.protected`;
    this.notifyClients("weights");
    return this.categories();
  }
  removeCategory(name: string) {
    if (name === "other") throw new Error("'other' is the fallback and can't be removed");
    this.sql`DELETE FROM categories WHERE name = ${name}`;
    this.notifyClients("weights");
    return this.categories();
  }

  // ---- weights ----------------------------------------------------------

  getWeight(dim: string, key: string): number | undefined {
    return this.sql<{ weight: number }>`SELECT weight FROM dim_weights WHERE dim = ${dim} AND key = ${key}`[0]
      ?.weight;
  }

  setWeight(dim: Dim, key: string, weight: number, source: WeightSource, reason = ""): number {
    const k = key.trim().toLowerCase();
    const w = clampWeight(weight);
    const before = this.getWeight(dim, k) ?? null;
    this.sql`INSERT INTO dim_weights (dim, key, weight, source, updated_at)
      VALUES (${dim}, ${k}, ${w}, ${source}, ${this.now()})
      ON CONFLICT(dim, key) DO UPDATE SET weight = excluded.weight, source = excluded.source,
        updated_at = excluded.updated_at`;
    this.sql`INSERT INTO weight_log (ts, dim, key, before, after, source, reason)
      VALUES (${this.now()}, ${dim}, ${k}, ${before}, ${w}, ${source}, ${reason})`;
    this.notifyClients("weights");
    return w;
  }

  clearWeight(dim: Dim, key: string, source: WeightSource, reason = "") {
    const k = key.trim().toLowerCase();
    const before = this.getWeight(dim, k) ?? null;
    if (before === null) return;
    this.sql`DELETE FROM dim_weights WHERE dim = ${dim} AND key = ${k}`;
    this.sql`INSERT INTO weight_log (ts, dim, key, before, after, source, reason)
      VALUES (${this.now()}, ${dim}, ${k}, ${before}, ${null}, ${source}, ${reason})`;
    this.notifyClients("weights");
  }

  /** Every key we've seen or weighted for a dimension, with how often it occurs. */
  weightsFor(dim: Dim) {
    const col = DIM_COLUMN[dim];
    const seen = this.ctx.storage.sql
      .exec<{ k: string; n: number; last: number }>(
        `SELECT ${col} AS k, COUNT(*) AS n, MAX(received_at) AS last FROM emails
         WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY n DESC LIMIT 300`,
      )
      .toArray();
    const set = new Map(
      this.sql<{ key: string; weight: number; source: string; updated_at: number }>`
        SELECT key, weight, source, updated_at FROM dim_weights WHERE dim = ${dim}`.map((r) => [r.key, r]),
    );
    const rows = seen.map((s) => ({
      key: s.k,
      emails: s.n,
      lastSeen: s.last,
      weight: set.get(s.k)?.weight ?? null,
      source: set.get(s.k)?.source ?? null,
      updatedAt: set.get(s.k)?.updated_at ?? null,
    }));
    for (const [key, r] of set) {
      if (!seen.some((s) => s.k === key)) {
        rows.push({ key, emails: 0, lastSeen: 0, weight: r.weight, source: r.source, updatedAt: r.updated_at });
      }
    }
    // Categories and kinds with no mail yet should still be tunable.
    if (dim === "category") {
      for (const c of this.categories()) {
        if (!rows.some((r) => r.key === c.name)) {
          rows.push({ key: c.name, emails: 0, lastSeen: 0, weight: null, source: null, updatedAt: null });
        }
      }
    }
    return rows.sort((a, b) => Number(b.weight !== null) - Number(a.weight !== null) || b.emails - a.emails);
  }

  weightLog(limit = 50) {
    return this.sql`SELECT ts, dim, key, before, after, source, reason FROM weight_log
      ORDER BY id DESC LIMIT ${limit}`;
  }

  // ---- gmail access -----------------------------------------------------

  /** Called by the worker after the allowlisted user completes OAuth. */
  linkAccount(email: string, refreshToken: string) {
    this.setKv("account", email);
    this.setKv("refresh_token", refreshToken);
    this.setKv("access_token", "");
    this.setKv("history_id", "");
    this.kickSchedule(); // first poll soon after sign-in
  }

  private async gmail(): Promise<MailApi> {
    if (this.fake) return this.fakeGmail();
    const exp = Number(this.getKv("access_expires") ?? 0);
    let token = this.getKv("access_token");
    if (!token || exp < this.now() + 60_000) {
      const rt = this.getKv("refresh_token");
      if (!rt) throw new Error("not connected");
      const r = await refreshAccessToken(this.env, rt);
      token = r.access_token;
      this.setKv("access_token", token);
      this.setKv("access_expires", String(this.now() + r.expires_in * 1000));
    }
    return new Gmail(token);
  }

  // ---- poll loop --------------------------------------------------------

  /** Fires every 15s; each job runs only when due, so the intervals stay tunable. */
  async tick() {
    try {
      if (!this.getKv("refresh_token")) return;
      if (this.fake && this.getKv("fake_auto") === "0") return;
      const s = this.settings();
      const now = this.now();
      // 1s of slack: the wake-up is rounded up to whole seconds
      if (now - Number(this.getKv("last_poll") ?? 0) >= s.pollSeconds * 1000 - 1000) {
        await this.poll().catch((e) => this.setKv("last_error", String(e)));
      }
      // learning piggybacks on the poll cadence (it only needs to run every 10 minutes or so)
      if (now - Number(this.getKv("last_learn") ?? 0) >= LEARN_EVERY_MS) {
        await this.learn().catch((e) => console.error("learn failed", e));
      }
      await this.digestIfDue().catch((e) => console.error("digest failed", e));
    } finally {
      // always line up the next wake-up, even if this one failed, or the chain would stop
      await this.scheduleNext().catch((e) => console.error("scheduleNext failed", e));
    }
  }

  // ---- scheduling -------------------------------------------------------

  private scheduleChain: Promise<unknown> = Promise.resolve();

  /** Fire-and-forget, for the synchronous places that change what's due (settings, sign-in, demo clock). */
  private kickSchedule() {
    this.ctx.waitUntil(this.scheduleNext().catch((e) => console.error("scheduleNext failed", e)));
  }

  /**
   * Keep exactly one pending "tick", set for the moment something is next due. There is no fixed
   * heartbeat: with a 10-minute interval the object wakes about 6 times an hour, not 240.
   * Calls are serialised so two changes at once can't leave two schedules behind.
   */
  scheduleNext(): Promise<void> {
    const run = this.scheduleChain.then(() => this.scheduleNextNow());
    this.scheduleChain = run.catch(() => {});
    return run;
  }

  private async scheduleNextNow() {
    const delay = this.secondsUntilNextWork();
    const wantAt = Math.floor(Date.now() / 1000) + delay;
    const ticks = (await this.listSchedules()).filter((s) => s.callback === "tick");
    // Already exactly one one-shot at about the right time: leave it alone.
    const only = ticks.length === 1 ? ticks[0]! : null;
    if (only && (only.type === "delayed" || only.type === "scheduled") && Math.abs(only.time - wantAt) <= 2) return;
    for (const t of ticks) await this.cancelSchedule(t.id); // includes any legacy recurring heartbeat
    await this.schedule(delay, "tick");
  }

  /** Seconds until the poll or the digest is next due, kept between 5 seconds and 1 hour. */
  private secondsUntilNextWork(): number {
    if (!this.getKv("refresh_token")) return 3600; // signing in reschedules straight away
    if (this.fake && this.getKv("fake_auto") === "0") return 3600; // turning auto back on reschedules
    const s = this.settings();
    const now = this.now();
    const pollIn = Number(this.getKv("last_poll") ?? 0) + s.pollSeconds * 1000 - now;
    const ms = Math.min(pollIn, this.msUntilDigest(s, now));
    return Math.min(3600, Math.max(5, Math.ceil(ms / 1000)));
  }

  /** Milliseconds until the next configured digest hour begins (0 if this hour's digest hasn't gone out). */
  private msUntilDigest(s: Settings, now: number): number {
    if (!s.digestHours.length) return Infinity;
    const slot = this.localSlot(s.timezone);
    if (s.digestHours.includes(slot.hour) && this.getKv("last_digest") !== slot.key) return 0;
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric", minute: "numeric", second: "numeric", hour12: false, timeZone: s.timezone,
    }).formatToParts(new Date(now));
    const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const toNextHour = (3600 - num("minute") * 60 - num("second")) * 1000;
    for (let k = 1; k <= 24; k++) {
      if (s.digestHours.includes((slot.hour + k) % 24)) return toNextHour + (k - 1) * 3600_000;
    }
    return Infinity;
  }

  /** The poll currently running, if any. Polls are slow (several network calls per email), so they overlap easily. */
  private pollInFlight: Promise<{ processed: number }> | null = null;
  private learnInFlight: Promise<void> | null = null;

  /**
   * One poll at a time. A poll that starts while another is running joins it instead of starting a
   * second one, which would re-read the same inbox and pay to process the same emails twice.
   */
  poll(): Promise<{ processed: number }> {
    if (this.pollInFlight) return this.pollInFlight;
    const p = this.pollOnce().finally(() => {
      this.pollInFlight = null;
    });
    this.pollInFlight = p;
    return p;
  }

  private async pollOnce(): Promise<{ processed: number }> {
    this.setKv("last_poll", String(this.now()));
    const gmail = await this.gmail();
    let ids: string[];
    let historyId = this.getKv("history_id") ?? "";
    if (!historyId) {
      ids = await gmail.recentInbox();
      historyId = (await gmail.profile()).historyId;
    } else {
      const r = await gmail.newInboxIds(historyId);
      if (!r.historyId) {
        historyId = (await gmail.profile()).historyId; // history expired: resync
        ids = [];
      } else {
        ids = r.ids;
        historyId = r.historyId;
      }
    }

    const seen = new Set(
      this.sql<{ id: string }>`SELECT id FROM emails ORDER BY received_at DESC LIMIT 500`.map((r) => r.id),
    );
    let processed = 0;
    for (const id of ids.filter((i) => !seen.has(i))) {
      try {
        await this.process(gmail, await gmail.get(id));
        processed++;
      } catch (e) {
        console.error("process failed", id, e);
        // do not advance the cursor past a failure we can retry
        this.setKv("last_error", String(e));
        return { processed };
      }
    }
    this.setKv("history_id", historyId);
    this.setKv("last_error", "");
    if (processed) this.notifyClients("feed");
    return { processed };
  }

  private async signalsFor(gmail: MailApi, m: MailMessage, sender: string, account: string | null): Promise<Signals> {
    const c = this.sql<{ replied: number; checked_at: number }>`
      SELECT replied, checked_at FROM contacts WHERE email = ${sender}`[0];
    let replied = !!c?.replied;
    if (!c || this.now() - c.checked_at > 7 * 86400_000) {
      replied = await gmail.repliedBefore(sender);
      this.sql`INSERT INTO contacts (email, replied, checked_at) VALUES (${sender}, ${replied ? 1 : 0}, ${this.now()})
        ON CONFLICT(email) DO UPDATE SET replied = excluded.replied, checked_at = excluded.checked_at`;
    }
    return {
      repliedBefore: replied,
      threadJoined: await gmail.threadJoined(m.threadId),
      toMe: addressedTo(m.headers, account),
      bulk: isBulk(m.headers),
    };
  }

  private async process(gmail: MailApi, m: MailMessage) {
    // Already handled (by an earlier poll or a racing one): do nothing, and spend nothing.
    if (this.sql<{ n: number }>`SELECT COUNT(*) n FROM emails WHERE id = ${m.id}`[0]?.n) return;
    const s = this.settings();
    const account = this.getKv("account") ?? null;
    const sender = senderEmail(m.from);
    const domain = senderDomain(m.from);
    const streams = streamKeys(m.headers);
    const alias = recipientAlias(m.headers, account);
    const usage: UsageRow[] = [];
    const onUsage: OnUsage = (stage, u) =>
      usage.push({ stage, model: "jev-latest", input: u.inputTokens, output: u.outputTokens, cost: u.cost, ms: u.ms });

    const signals = await this.signalsFor(gmail, m, sender, account);
    const mail = { from: m.from, subject: m.subject, snippet: m.snippet, body: m.body };
    const categories = this.categories();

    // Stage 1: facets, with no weights or taste in the prompt.
    const facets = await classify(this.env.TYPESAFE_API_KEY, mail, categories, onUsage, this.fake ? fakeJev : undefined);

    // Weights from the facets plus identity derived in code.
    const keys: WeightKeys = { sender, streams, domain, alias, category: facets.category, kind: facets.kind };
    const resolved = resolveWeight((d, k) => this.getWeight(d, k), keys);

    // Stage 2: judge, with weights, rules, signals and corrections in the prompt.
    // A heavily down-weighted email only gets the cheap urgency check.
    const fast = resolved.weight <= s.fastPathWeight && !signals.repliedBefore && !signals.threadJoined;
    const judged = await judge(
      this.env.TYPESAFE_API_KEY,
      {
        ...mail,
        facets: { category: facets.category, kind: facets.kind, automated: facets.automated >= 0.5 },
        signals: { ...signals },
        weight: resolved.weight,
        rules: this.rules(),
        taste_examples: this.tasteExamples(),
      },
      fast,
      onUsage,
      this.fake ? fakeJev : undefined,
    );

    const d = decide(
      {
        facets,
        judged,
        signals,
        weight: resolved.weight,
        protectedCategory: !!categories.find((c) => c.name === facets.category)?.protected,
      },
      s,
    );
    if (fast) d.reasons.push("fast path: heavily down-weighted");

    // Luna only reads what stays in the inbox.
    let summary: string | null = null;
    if (d.action === "keep" || d.action === "alert") {
      summary = await this.summarise(m, usage).catch(() => null);
    }

    if (d.action === "archive") {
      await gmail.modify(m.id, [await gmail.ensureLabel(LABEL_ARCHIVED)], ["INBOX"]);
    } else if (d.action === "digest") {
      await gmail.modify(m.id, [await gmail.ensureLabel(LABEL_DIGEST)], ["INBOX"]);
    } else if (d.action === "alert") {
      await this.notify({
        title: m.subject || "(no subject)",
        body: `${m.from}\n${summary ?? m.snippet}`,
        click: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`,
        priority: judged.urgent >= s.urgentAbove ? 5 : 4,
      }).catch((e) => console.error("push failed", e));
    }

    const flags = { hasDeadline: facets.hasDeadline, involvesMoney: facets.involvesMoney, replyExpected: facets.replyExpected };
    this.sql`INSERT OR REPLACE INTO emails
      (id, thread_id, sender, sender_addr, domain, alias, stream, subject, snippet, summary, category, kind,
       importance, needs_action, urgent, attention, action, reasons, weight, weight_parts, signals, flags,
       received_at, processed_at)
      VALUES (${m.id}, ${m.threadId}, ${m.from}, ${sender}, ${domain}, ${alias}, ${streams[0] ?? null},
       ${m.subject}, ${m.snippet}, ${summary}, ${facets.category}, ${facets.kind}, ${judged.importance},
       ${judged.needsAction}, ${judged.urgent}, ${d.attention}, ${d.action}, ${JSON.stringify(d.reasons)},
       ${resolved.weight}, ${JSON.stringify(resolved.parts)}, ${JSON.stringify(signals)},
       ${JSON.stringify(flags)}, ${m.date}, ${this.now()})`;
    for (const u of usage) this.logCall(m.id, u);
    this.notifyClients("activity");
  }

  private tasteExamples() {
    return this.sql<{ sender: string; subject: string; vote: number; undone: number; outcome: string | null }>`
      SELECT sender, subject, vote, undone, outcome FROM emails
      WHERE vote != 0 OR undone = 1 OR outcome = 'rescued' ORDER BY processed_at DESC LIMIT 8`.map((r) => ({
      from: r.sender,
      subject: r.subject,
      verdict:
        r.undone || r.outcome === "rescued"
          ? "should NOT have been hidden"
          : r.vote > 0
            ? "wanted more of this"
            : "wanted less of this",
    }));
  }

  private logCall(emailId: string | null, u: UsageRow) {
    this.sql`INSERT INTO calls (ts, email_id, stage, model, input_tokens, output_tokens, cost, ms)
      VALUES (${this.now()}, ${emailId}, ${u.stage}, ${u.model}, ${u.input}, ${u.output}, ${u.cost}, ${u.ms})`;
  }

  private async luna(
    system: string,
    user: string,
    stage: string,
    usage: UsageRow[] | null,
    emailId: string | null,
    fakeOut?: () => string,
  ) {
    if (this.fake) {
      const out = fakeOut ? fakeOut() : user.slice(0, 120);
      const input = Math.ceil((system.length + user.length) / 4);
      const output = Math.ceil(out.length / 4);
      const row: UsageRow = {
        stage, model: "fake-luna", input, output, cost: (input * 0.1 + output * 0.4) / 1e6, ms: 1,
      };
      if (usage) usage.push(row);
      else this.logCall(emailId, row);
      return out;
    }
    const started = this.now();
    await this.llm.ready;
    const reply = await this.llm.models.completeSimple(
      this.llm.model(this.env.SUMMARY_MODEL),
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: this.now() }] },
      { reasoning: "low", maxTokens: 1500 },
    );
    const row: UsageRow = {
      stage,
      model: this.env.SUMMARY_MODEL,
      input: reply.usage?.input ?? 0,
      output: reply.usage?.output ?? 0,
      cost: reply.usage?.cost?.total ?? 0,
      ms: this.now() - started,
    };
    if (usage) usage.push(row);
    else this.logCall(emailId, row);
    // A failed or empty reply must not be stored as a summary or sent as a digest.
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      const msg = reply.errorMessage || `OpenAI call ${reply.stopReason}`;
      this.setKv("llm_error", msg.slice(0, 500));
      this.notifyClients("settings");
      throw new Error(msg);
    }
    const out = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    if (!out) throw new Error("OpenAI returned no text");
    if (this.getKv("llm_error")) {
      this.setKv("llm_error", "");
      this.notifyClients("settings");
    }
    return out;
  }

  private summarise(m: MailMessage, usage: UsageRow[]) {
    return this.luna(
      "Summarise this email in one or two plain sentences. Lead with what the reader needs to know or do. No preamble.",
      `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`,
      "summary",
      usage,
      m.id,
      () => fakeSummary(m.from, m.subject, m.body),
    );
  }

  // ---- digest -----------------------------------------------------------

  private localSlot(tz: string): { hour: number; key: string } {
    const now = new Date(this.now());
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: tz }).format(now)) % 24;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    return { hour, key: `${day}T${hour}` };
  }

  async digestIfDue() {
    const s = this.settings();
    const slot = this.localSlot(s.timezone);
    if (!s.digestHours.includes(slot.hour) || this.getKv("last_digest") === slot.key) return;
    this.setKv("last_digest", slot.key);
    await this.sendDigest();
  }

  async sendDigest(): Promise<{ items: number }> {
    const rows = this.sql<{ id: string; sender: string; subject: string; snippet: string; category: string }>`
      SELECT id, sender, subject, snippet, category FROM emails
      WHERE action = 'digest' AND digested_at IS NULL AND undone = 0 ORDER BY received_at LIMIT 60`;
    if (!rows.length) return { items: 0 };
    const list = rows
      .map((r, i) => `${i + 1}. [${r.category}] ${r.sender} — ${r.subject}\n   ${r.snippet}`)
      .join("\n");
    const body = await this.luna(
      "You write a short digest of emails the reader chose not to see individually. Group related items, one line each, most useful first. Plain text, no preamble, under 900 characters.",
      list,
      "digest",
      null,
      null,
      () => fakeDigest(rows),
    );
    await this.notify({ title: `Inbox digest (${rows.length})`, body, priority: 3 });
    const now = this.now();
    for (const r of rows) this.sql`UPDATE emails SET digested_at = ${now} WHERE id = ${r.id}`;
    this.notifyClients("activity");
    return { items: rows.length };
  }

  // ---- implicit feedback ------------------------------------------------

  /**
   * Watches what happens to emails after we act, and proposes weight changes.
   * Proposals are never applied automatically; the user accepts or rejects them.
   */
  learn(): Promise<void> {
    if (this.learnInFlight) return this.learnInFlight;
    const p = this.learnOnce().finally(() => {
      this.learnInFlight = null;
    });
    this.learnInFlight = p;
    return p;
  }

  private async learnOnce() {
    this.setKv("last_learn", String(this.now()));
    const now = this.now();
    const rows = this.sql<{ id: string; thread_id: string; sender_addr: string; action: Action; processed_at: number }>`
      SELECT id, thread_id, sender_addr, action, processed_at FROM emails
      WHERE outcome IS NULL AND processed_at < ${now - LEARN_AFTER_MS}
        AND processed_at > ${now - 7 * 86400_000} ORDER BY processed_at LIMIT 20`;
    if (!rows.length) return;
    const gmail = await this.gmail();
    for (const r of rows) {
      const labels = await gmail.labels(r.id);
      if (labels === null) {
        this.setOutcome(r.id, "gone");
        continue;
      }
      const inInbox = labels.includes("INBOX");
      const unread = labels.includes("UNREAD");
      const hidden = r.action === "archive" || r.action === "digest";
      if (hidden && (inInbox || labels.includes("STARRED"))) {
        this.setOutcome(r.id, "rescued");
        this.propose("sender", r.sender_addr, 1.3, "You moved a hidden email back to your inbox or starred it");
      } else if (hidden) {
        this.setOutcome(r.id, "hidden-ok");
      } else if (!inInbox && unread) {
        this.setOutcome(r.id, "dismissed");
        this.proposeIfRepeated(r.sender_addr, "dismissed", 3, 0.7, "You archived 3+ of its emails without reading them");
      } else if (!unread) {
        this.setOutcome(r.id, "engaged");
      } else if (now - r.processed_at > IGNORED_AFTER_MS) {
        this.setOutcome(r.id, "ignored");
        this.proposeIfRepeated(r.sender_addr, "ignored", 5, 0.8, "5+ of its emails sat unread for 3 days");
      } // else: still recent and unread, check again next cycle
    }
    this.notifyClients("weights");
  }

  private setOutcome(id: string, outcome: string) {
    this.sql`UPDATE emails SET outcome = ${outcome} WHERE id = ${id}`;
  }

  private proposeIfRepeated(sender: string, outcome: string, min: number, factor: number, reason: string) {
    const n = this.sql<{ n: number }>`
      SELECT COUNT(*) n FROM emails WHERE sender_addr = ${sender} AND outcome = ${outcome}`[0]?.n ?? 0;
    if (n >= min) this.propose("sender", sender, factor, reason);
  }

  /** `factor` multiplies the sender's current explicit weight (or 1). */
  private propose(dim: Dim, key: string, factor: number, reason: string) {
    const k = key.toLowerCase();
    const dup = this.sql<{ n: number }>`
      SELECT COUNT(*) n FROM proposals WHERE dim = ${dim} AND key = ${k} AND status = 'pending'`[0]?.n;
    if (dup) return;
    const suggested = clampWeight((this.getWeight(dim, k) ?? 1) * factor);
    this.sql`INSERT INTO proposals (ts, dim, key, suggested, reason) VALUES (${this.now()}, ${dim}, ${k}, ${suggested}, ${reason})`;
  }

  proposals() {
    return this.sql<{ id: number; ts: number; dim: string; key: string; suggested: number; reason: string }>`
      SELECT id, ts, dim, key, suggested, reason FROM proposals WHERE status = 'pending' ORDER BY id DESC`;
  }

  resolveProposal(id: number, accept: boolean) {
    const p = this.sql<{ dim: Dim; key: string; suggested: number }>`
      SELECT dim, key, suggested FROM proposals WHERE id = ${id} AND status = 'pending'`[0];
    if (!p) return null;
    if (accept) this.setWeight(p.dim, p.key, p.suggested, "learned", "accepted proposal");
    this.sql`UPDATE proposals SET status = ${accept ? "accepted" : "rejected"} WHERE id = ${id}`;
    this.notifyClients("weights");
    return { ok: true };
  }

  // ---- feed and explicit feedback ---------------------------------------

  feed(limit = 100): FeedRow[] {
    return this.sql<FeedRow>`SELECT id, thread_id, sender, subject, summary, category, kind, attention,
      action, reasons, weight, weight_parts, signals, stream, received_at, vote, undone, outcome
      FROM emails ORDER BY received_at DESC LIMIT ${limit}`;
  }

  /**
   * dir > 0: show more; dir < 0: show less. `scope` picks the dimension, default sender.
   * The factor applies to that dimension's own weight (or 1), not the combined weight.
   */
  vote(id: string, dir: 1 | -1, scope: Dim = "sender") {
    const col = DIM_COLUMN[scope];
    const row = this.ctx.storage.sql
      .exec<{ k: string | null }>(`SELECT ${col} AS k FROM emails WHERE id = ?`, id)
      .toArray()[0];
    if (!row?.k) return null;
    const key = row.k.toLowerCase();
    const w = this.setWeight(scope, key, (this.getWeight(scope, key) ?? 1) * (dir > 0 ? 1.2 : 0.8), "vote", `card vote on ${id}`);
    this.sql`UPDATE emails SET vote = ${dir} WHERE id = ${id}`;
    this.notifyClients("feed");
    return { dim: scope, key, weight: w };
  }

  /** Presets: vip = 3, normal = no explicit weight, ignore = 0.2. */
  preset(dim: Dim, key: string, preset: "vip" | "normal" | "ignore") {
    if (preset === "normal") this.clearWeight(dim, key, "manual", "preset normal");
    else this.setWeight(dim, key, preset === "vip" ? 3 : 0.2, "manual", `preset ${preset}`);
    return { ok: true };
  }

  async undo(id: string) {
    const row = this.sql<{ sender_addr: string; action: Action }>`SELECT sender_addr, action FROM emails WHERE id = ${id}`[0];
    if (!row) return null;
    if (row.action === "archive" || row.action === "digest") {
      await (await this.gmail()).unarchive(id);
      this.setWeight("sender", row.sender_addr, (this.getWeight("sender", row.sender_addr) ?? 1) * 1.3, "vote", `undo on ${id}`);
    }
    this.sql`UPDATE emails SET undone = 1 WHERE id = ${id}`;
    this.notifyClients("feed");
    return { ok: true };
  }

  // ---- activity ---------------------------------------------------------

  activity(limit = 150) {
    const calls = this.sql`SELECT c.ts, c.email_id, c.stage, c.model, c.input_tokens, c.output_tokens,
      c.cost, c.ms, e.subject FROM calls c LEFT JOIN emails e ON e.id = c.email_id
      ORDER BY c.id DESC LIMIT ${limit}`;
    const byStage = this.sql`SELECT stage, COUNT(*) n, SUM(cost) cost, SUM(input_tokens) input_tokens,
      SUM(output_tokens) output_tokens FROM calls GROUP BY stage ORDER BY cost DESC`;
    const day = this.now() - 86400_000;
    const totals = this.sql<{ today: number; all: number }>`SELECT
      COALESCE(SUM(CASE WHEN ts > ${day} THEN cost END), 0) today, COALESCE(SUM(cost), 0) "all" FROM calls`[0];
    return { calls, byStage, totals };
  }

  /** The chat agent's tool calls and token spend, read from its transcript. */
  async chatActivity() {
    const entries = (await this.harness.session(SELF_ID).messages()) as unknown as {
      model?: Record<string, any>[];
    }[];
    const out: { kind: string; name?: string; args?: unknown; result?: string; isError?: boolean; cost?: number; tokens?: number }[] = [];
    for (const e of entries) {
      for (const msg of e.model ?? []) {
        if (msg.role === "assistant") {
          const calls = Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "toolCall") : [];
          out.push({
            kind: "model",
            cost: msg.usage?.cost?.total ?? 0,
            tokens: msg.usage?.totalTokens ?? 0,
          });
          for (const c of calls) out.push({ kind: "tool", name: c.name, args: c.arguments });
        } else if (msg.role === "toolResult") {
          const t = Array.isArray(msg.content)
            ? msg.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
            : String(msg.content ?? "");
          out.push({ kind: "result", name: msg.toolName, result: t.slice(0, 600), isError: !!msg.isError });
        }
      }
    }
    return out.slice(-200);
  }

  // ---- chat -------------------------------------------------------------

  private tools(): ToolRegistration<any>[] {
    const tool = (t: ToolRegistration<any>) => t;
    return [
      tool({
        name: "update_settings",
        description:
          "Change tuning settings. archiveBelow < digestBelow < alertAbove are attention thresholds in 0..1. urgentAbove/minConfidence 0..1; pollSeconds 15..3600 (300 = every 5 minutes); digestHours are local hours 0..23; timezone is IANA.",
        parameters: Type.Object({
          archiveBelow: Type.Optional(Type.Number()),
          digestBelow: Type.Optional(Type.Number()),
          alertAbove: Type.Optional(Type.Number()),
          urgentAbove: Type.Optional(Type.Number()),
          minConfidence: Type.Optional(Type.Number()),
          fastPathWeight: Type.Optional(Type.Number()),
          pollSeconds: Type.Optional(Type.Number()),
          digestHours: Type.Optional(Type.Array(Type.Number())),
          timezone: Type.Optional(Type.String()),
        }),
        replay: "safe",
        execute: async (args: Partial<Settings>) => {
          const before = this.settings();
          return text(JSON.stringify({ before, after: this.updateSettings(args) }));
        },
      }),
      tool({
        name: "set_weight",
        description:
          "Set a weight (multiplier) for a sender (full address), stream (list id), domain, alias, category or kind. 1 neutral, 0.2 nearly always hidden, 3 strongly boosted. Use the narrowest dimension that fits.",
        parameters: Type.Object({
          dim: dimSchema,
          key: Type.String(),
          weight: Type.Number(),
          reason: Type.Optional(Type.String()),
        }),
        replay: "safe",
        execute: async (a: { dim: Dim; key: string; weight: number; reason?: string }) => {
          const before = this.getWeight(a.dim, a.key.toLowerCase()) ?? null;
          const after = this.setWeight(a.dim, a.key, a.weight, "chat", a.reason ?? "");
          return text(JSON.stringify({ before, after }));
        },
      }),
      tool({
        name: "clear_weight",
        description: "Remove an explicit weight so the key goes back to neutral.",
        parameters: Type.Object({ dim: dimSchema, key: Type.String() }),
        replay: "safe",
        execute: async (a: { dim: Dim; key: string }) => {
          this.clearWeight(a.dim, a.key, "chat");
          return text("cleared");
        },
      }),
      tool({
        name: "list_weights",
        description: "List the keys seen for a dimension with their weights and email counts.",
        parameters: Type.Object({ dim: dimSchema }),
        replay: "safe",
        execute: async ({ dim }: { dim: Dim }) => text(JSON.stringify(this.weightsFor(dim).slice(0, 40))),
      }),
      tool({
        name: "upsert_category",
        description:
          "Add or update a category. The description is what Jev reads to decide membership, so make it concrete. protected=true means mail in it is never hidden.",
        parameters: Type.Object({
          name: Type.String(),
          description: Type.String(),
          protected: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        execute: async (a: { name: string; description: string; protected?: boolean }) =>
          text(JSON.stringify(this.upsertCategory({ name: a.name, description: a.description, protected: !!a.protected }))),
      }),
      tool({
        name: "remove_category",
        description: "Remove a category. Not allowed for 'other'.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "safe",
        execute: async ({ name }: { name: string }) => text(JSON.stringify(this.removeCategory(name))),
      }),
      tool({
        name: "add_rule",
        description:
          "Add a standing plain-English rule Jev follows when judging every email, e.g. 'Invoices from suppliers are always important'.",
        parameters: Type.Object({ rule: Type.String() }),
        replay: "unsafe",
        execute: async ({ rule }: { rule: string }) => text(JSON.stringify(this.addRule(rule))),
      }),
      tool({
        name: "remove_rule",
        description: "Remove a standing rule by its exact text.",
        parameters: Type.Object({ rule: Type.String() }),
        replay: "safe",
        execute: async ({ rule }: { rule: string }) => text(JSON.stringify(this.removeRule(rule))),
      }),
      tool({
        name: "recent_decisions",
        description: "List recent triage decisions with reasons and which weights applied. Use to explain or audit behaviour.",
        parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
        replay: "safe",
        execute: async ({ limit }: { limit?: number }) =>
          text(
            JSON.stringify(
              this.feed(Math.min(50, limit ?? 15)).map((r) => ({
                id: r.id,
                from: r.sender,
                subject: r.subject,
                category: r.category,
                kind: r.kind,
                action: r.action,
                attention: r.attention,
                weight: r.weight,
                weightParts: JSON.parse(r.weight_parts),
                reasons: JSON.parse(r.reasons),
              })),
            ),
          ),
      }),
      tool({
        name: "unarchive",
        description: "Move an archived or digested email back to the inbox and boost its sender.",
        parameters: Type.Object({ id: Type.String() }),
        replay: "unsafe",
        execute: async ({ id }: { id: string }) => text(JSON.stringify(await this.undo(id))),
      }),
    ];
  }

  async chat(message: string): Promise<{ operationId: string }> {
    const receipt = await this.harness.session(SELF_ID).submit(message);
    // fire-and-forget: tell clients when the agent has answered
    this.ctx.waitUntil(
      this.harness
        .session(SELF_ID)
        .wait(receipt.operationId)
        .then(() => this.notifyClients("chat"))
        .catch(() => this.notifyClients("chat")),
    );
    this.notifyClients("chat");
    return { operationId: receipt.operationId };
  }

  async chatLog(): Promise<{ role: string; text: string }[]> {
    const entries = await this.harness.session(SELF_ID).messages();
    const out: { role: string; text: string }[] = [];
    for (const e of entries as unknown as { model?: { role: string; content: unknown; stopReason?: string; errorMessage?: string }[] }[]) {
      for (const msg of e.model ?? []) {
        if (msg.role === "assistant" && msg.stopReason === "error") {
          out.push({ role: "error", text: msg.errorMessage || "The model call failed." });
          continue;
        }
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const t = Array.isArray(msg.content)
          ? msg.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("")
          : String(msg.content ?? "");
        if (t.trim()) out.push({ role: msg.role, text: t });
      }
    }
    return out;
  }

  // ---- fake mode controls -----------------------------------------------

  /** Link the pretend mailbox and seed the people the user has "written to". Idempotent. */
  fakeStart(account: string) {
    this.setKv("account", account);
    this.setKv("refresh_token", "fake");
    if (this.getKv("fake_seeded") !== "1") {
      seedKnownContacts(this.fakeGmail());
      this.setKv("fake_seeded", "1");
    }
    this.notifyClients("feed");
    return { ok: true, account };
  }

  fakeDeliver(opts: { scenario?: string; all?: boolean; count?: number }): { ids: string[]; keys: string[] } {
    const g = this.fakeGmail();
    const picks = opts.all
      ? SCENARIOS
      : opts.scenario
        ? [scenarioByKey(opts.scenario)].filter((x): x is NonNullable<typeof x> => !!x)
        : Array.from({ length: Math.min(20, Math.max(1, opts.count ?? 1)) }, () => {
            const n = Number(this.getKv("fake_cursor") ?? 0);
            this.setKv("fake_cursor", String(n + 1));
            return SCENARIOS[n % SCENARIOS.length]!;
          });
    if (opts.scenario && !picks.length) throw new Error(`unknown scenario '${opts.scenario}'`);
    const ids = picks.map((p) => g.deliver(p));
    return { ids, keys: picks.map((p) => p.key) };
  }

  fakeAct(id: string, what: UserAct) {
    const labels = this.fakeGmail().act(id, what);
    if (!labels) throw new Error(`no such message ${id}`);
    return { id, labels };
  }

  fakeClock(advanceMs: number) {
    this.setKv("clock_offset", String(Number(this.getKv("clock_offset") ?? 0) + Math.max(0, advanceMs)));
    this.notifyClients("settings");
    this.kickSchedule();
    return { now: this.now() };
  }

  async fakeRun(job: string) {
    switch (job) {
      case "poll": return this.poll();
      case "learn": await this.learn(); return { ok: true };
      case "digest": await this.digestIfDue(); return { ok: true };
      case "tick": await this.tick(); return { ok: true };
      default: throw new Error(`unknown job '${job}'`);
    }
  }

  fakeMessages() {
    return this.sql`SELECT id, thread_id, from_hdr, subject, labels FROM fake_messages
      WHERE labels NOT LIKE '%"SENT"%' ORDER BY date DESC, id DESC LIMIT 100`.map((r) => ({
      ...r,
      labels: JSON.parse(String(r.labels)),
    }));
  }

  /** Wipe everything the app has learned and every pretend email. Keeps the account link. */
  fakeReset() {
    for (const t of ["emails", "calls", "dim_weights", "weight_log", "proposals", "contacts", "rules", "categories", "notifications"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    }
    for (const k of ["history_id", "last_poll", "last_learn", "last_digest", "last_error", "settings", "clock_offset", "fake_seeded", "fake_cursor"]) {
      this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", k);
    }
    DEFAULT_CATEGORIES.forEach((c, i) => this.upsertCategory(c, i));
    this.fakeGmail().reset();
    seedKnownContacts(this.fakeGmail());
    this.setKv("fake_seeded", "1");
    this.notifyClients("feed");
    this.notifyClients("weights");
    this.kickSchedule();
    return { ok: true };
  }

  // ---- transport --------------------------------------------------------

  private notifyClients(what: "feed" | "settings" | "chat" | "weights" | "activity") {
    this.broadcast(JSON.stringify({ type: what }));
  }

  async status() {
    const s = this.settings();
    const connected = !!this.getKv("refresh_token");
    const ticks = (await this.listSchedules()).filter((x) => x.callback === "tick");
    return {
      /** when the next check is due (ms), and what's actually scheduled: exactly one one-shot, no heartbeat */
      nextPoll: connected ? Number(this.getKv("last_poll") ?? 0) + s.pollSeconds * 1000 : null,
      schedules: ticks.map((t) => ({ type: t.type, at: t.time * 1000 })),
      account: this.getKv("account") ?? null,
      connected: !!this.getKv("refresh_token"),
      lastPoll: Number(this.getKv("last_poll") ?? 0) || null,
      lastError: this.getKv("last_error") || null,
      llmError: this.getKv("llm_error") || null,
      pendingProposals: this.proposals().length,
      push: { configured: pushoverConfigured(this.env) },
      costToday: this.activity(0).totals?.today ?? 0,
      fake: this.fake
        ? {
            auto: this.getKv("fake_auto") !== "0",
            offsetMs: Number(this.getKv("clock_offset") ?? 0),
            now: this.now(),
            scenarios: SCENARIOS.map((x) => ({ key: x.key, subject: x.subject })),
          }
        : null,
    };
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const path = url.pathname.replace(/^.*\/api/, "");
    const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json<any>().catch(() => ({}));
    if (path.startsWith("/fake/") && !this.fake) return json({ error: "not found" }, 404);
    const dim = (v: unknown): Dim | null => (DIMS as readonly string[]).includes(String(v)) ? (v as Dim) : null;

    try {
      switch (`${req.method} ${path}`) {
        case "GET /status":
          return json({ ...(await this.status()), settings: this.settings() });
        case "GET /feed":
          return json(this.feed());
        case "PUT /settings":
          return json(this.updateSettings(body));
        case "POST /vote":
          return json(this.vote(body.id, body.dir > 0 ? 1 : -1, dim(body.scope) ?? "sender"));
        case "POST /undo":
          return json(await this.undo(body.id));
        case "POST /poll":
          return json(await this.poll());
        case "POST /digest":
          return json(await this.sendDigest());

        case "GET /weights": {
          const d = dim(url.searchParams.get("dim"));
          return d ? json(this.weightsFor(d)) : json({ error: "bad dim" }, 400);
        }
        case "PUT /weights": {
          const d = dim(body.dim);
          if (!d || !body.key) return json({ error: "dim and key required" }, 400);
          return json({ weight: this.setWeight(d, body.key, Number(body.weight), "manual", body.reason ?? "") });
        }
        case "DELETE /weights": {
          const d = dim(url.searchParams.get("dim"));
          const k = url.searchParams.get("key");
          if (!d || !k) return json({ error: "dim and key required" }, 400);
          this.clearWeight(d, k, "manual");
          return json({ ok: true });
        }
        case "POST /weights/preset": {
          const d = dim(body.dim);
          if (!d || !body.key || !["vip", "normal", "ignore"].includes(body.preset)) return json({ error: "bad request" }, 400);
          return json(this.preset(d, body.key, body.preset));
        }
        case "GET /weights/log":
          return json(this.weightLog());

        case "GET /categories":
          return json(this.categories());
        case "PUT /categories":
          return json(this.upsertCategory({ name: body.name, description: body.description, protected: !!body.protected }));
        case "DELETE /categories":
          return json(this.removeCategory(url.searchParams.get("name") ?? ""));

        case "GET /rules":
          return json(this.rules());
        case "POST /rules":
          return json(this.addRule(String(body.rule)));
        case "DELETE /rules":
          return json(this.removeRule(url.searchParams.get("rule") ?? ""));

        case "GET /notifications":
          return json(this.notifications());
        case "GET /proposals":
          return json(this.proposals());
        case "POST /proposals/resolve":
          return json(this.resolveProposal(Number(body.id), !!body.accept));

        case "GET /activity":
          return json(this.activity());
        case "GET /activity/chat":
          return json(await this.chatActivity());

        case "GET /chat":
          return json(await this.chatLog());
        case "POST /chat":
          return json(await this.chat(String(body.message ?? "")));
        case "POST /fake/start":
          return json(this.fakeStart(body.account ?? "demo@example.com"));
        case "POST /fake/deliver":
          return json(this.fakeDeliver(body));
        case "POST /fake/act":
          return json(this.fakeAct(body.id, body.act));
        case "POST /fake/clock":
          return json(this.fakeClock(Number(body.advanceMs)));
        case "POST /fake/run":
          return json(await this.fakeRun(String(body.job)));
        case "POST /fake/latency":
          this.setKv("fake_latency_ms", String(Math.max(0, Math.min(2000, Number(body.ms) || 0))));
          return json({ ms: Number(this.getKv("fake_latency_ms")) });
        case "POST /fake/legacy-heartbeat":
          // Recreates what earlier deployments saved on the object: a recurring 15-second tick.
          await this.scheduleEvery(15, "tick");
          return json({ ok: true });
        case "POST /fake/auto":
          this.setKv("fake_auto", body.on ? "1" : "0");
          await this.scheduleNext();
          return json({ auto: !!body.on });
        case "GET /fake/messages":
          return json(this.fakeMessages());
        case "POST /fake/reset":
          return json(this.fakeReset());

        case "POST /internal/connect":
          this.linkAccount(body.email, body.refreshToken);
          return json({ ok: true });
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  }
}
