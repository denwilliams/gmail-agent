import type { Env } from "./env";

export interface Notification {
  title: string;
  body: string;
  click?: string;
  /** 5 urgent, 4 normal, 3 digest. Mapped onto Pushover's -2..2 scale. */
  priority?: 3 | 4 | 5;
}

/** urgent -> high (bypasses quiet hours), normal -> normal, digest -> quiet (no sound). */
export const PUSHOVER_PRIORITY = { 5: 1, 4: 0, 3: -1 } as const;

const ENDPOINT = "https://api.pushover.net/1/messages.json";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pushover needs both an app token and a user key. */
export const pushoverConfigured = (env: Env): boolean => !!(env.PUSHOVER_APP_TOKEN && env.PUSHOVER_USER_KEY);

/**
 * Push via Pushover when it's configured. Returns "skipped" (and does nothing) when it isn't, so
 * callers never need to care. Limits: title 250, message 1024, url 512.
 */
export async function push(env: Env, n: Notification): Promise<"sent" | "skipped"> {
  if (!pushoverConfigured(env)) return "skipped";
  const form = new URLSearchParams({
    token: env.PUSHOVER_APP_TOKEN!,
    user: env.PUSHOVER_USER_KEY!,
    title: clip(n.title || "Inbox Agent", 250),
    message: clip(n.body || n.title || "(empty)", 1024),
    priority: String(PUSHOVER_PRIORITY[n.priority ?? 4]),
  });
  if (env.PUSHOVER_DEVICE) form.set("device", env.PUSHOVER_DEVICE);
  if (n.click) {
    form.set("url", clip(n.click, 512));
    form.set("url_title", "Open in Gmail");
  }
  const res = await fetch(ENDPOINT, { method: "POST", body: form });
  if (!res.ok) {
    // Pushover explains itself: {"status":0,"errors":["user identifier is invalid"]}
    throw new Error(`pushover ${res.status}: ${clip(await res.text(), 300)}`);
  }
  return "sent";
}
