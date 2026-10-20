import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { push, pushoverConfigured } from "../src/notify";

const env = { PUSHOVER_APP_TOKEN: "app", PUSHOVER_USER_KEY: "usr" } as Env;

function stubFetch(status = 200, body = '{"status":1}') {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const sent = (fn: ReturnType<typeof stubFetch>) => new URLSearchParams(String(fn.mock.calls[0]![1].body));

afterEach(() => vi.unstubAllGlobals());

describe("pushover is optional", () => {
  it("is not configured without both credentials", () => {
    expect(pushoverConfigured({} as Env)).toBe(false);
    expect(pushoverConfigured({ PUSHOVER_APP_TOKEN: "a" } as Env)).toBe(false);
    expect(pushoverConfigured({ PUSHOVER_USER_KEY: "u" } as Env)).toBe(false);
    expect(pushoverConfigured({ PUSHOVER_APP_TOKEN: "", PUSHOVER_USER_KEY: "" } as Env)).toBe(false);
    expect(pushoverConfigured(env)).toBe(true);
  });

  it("skips quietly, with no network call, when not configured", async () => {
    const f = stubFetch();
    expect(await push({} as Env, { title: "t", body: "b" })).toBe("skipped");
    expect(await push({ PUSHOVER_APP_TOKEN: "a" } as Env, { title: "t", body: "b" })).toBe("skipped");
    expect(f).not.toHaveBeenCalled();
  });

  it("reports sent when configured", async () => {
    stubFetch();
    expect(await push(env, { title: "t", body: "b" })).toBe("sent");
  });
});

describe("pushover", () => {
  it("posts credentials, title, message and a link to Gmail", async () => {
    const f = stubFetch();
    await push(env, { title: "Invoice due", body: "Pay by Friday", click: "https://mail.google.com/x" });
    expect(f.mock.calls[0]![0]).toBe("https://api.pushover.net/1/messages.json");
    const p = sent(f);
    expect(Object.fromEntries(p)).toMatchObject({
      token: "app", user: "usr", title: "Invoice due", message: "Pay by Friday",
      url: "https://mail.google.com/x", url_title: "Open in Gmail",
    });
  });

  it("maps our priorities onto Pushover's scale", async () => {
    for (const [ours, theirs] of [[5, "1"], [4, "0"], [3, "-1"]] as const) {
      const f = stubFetch();
      await push(env, { title: "t", body: "b", priority: ours });
      expect(sent(f).get("priority")).toBe(theirs);
      vi.unstubAllGlobals();
    }
  });

  it("defaults to normal priority and omits the link and device when absent", async () => {
    const f = stubFetch();
    await push(env, { title: "t", body: "b" });
    const p = sent(f);
    expect(p.get("priority")).toBe("0");
    expect(p.has("url")).toBe(false);
    expect(p.has("device")).toBe(false);
  });

  it("targets one device when configured", async () => {
    const f = stubFetch();
    await push({ ...env, PUSHOVER_DEVICE: "iphone" } as Env, { title: "t", body: "b" });
    expect(sent(f).get("device")).toBe("iphone");
  });

  it("clips to Pushover's limits", async () => {
    const f = stubFetch();
    await push(env, { title: "t".repeat(400), body: "m".repeat(2000) });
    const p = sent(f);
    expect(p.get("title")!.length).toBe(250);
    expect(p.get("message")!.length).toBe(1024);
    expect(p.get("title")!.endsWith("…")).toBe(true);
  });

  it("never sends an empty message", async () => {
    const f = stubFetch();
    await push(env, { title: "", body: "" });
    expect(sent(f).get("message")).toBeTruthy();
    expect(sent(f).get("title")).toBe("Inbox Agent");
  });

  it("surfaces Pushover's own error text", async () => {
    stubFetch(400, '{"status":0,"errors":["user identifier is invalid"]}');
    await expect(push(env, { title: "t", body: "b" })).rejects.toThrow(/400.*user identifier is invalid/);
  });
});
