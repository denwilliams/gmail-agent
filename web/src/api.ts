export type Action = "alert" | "keep" | "digest" | "archive";
export const DIMS = ["sender", "stream", "domain", "alias", "category", "kind"] as const;
export type Dim = (typeof DIMS)[number];

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

export interface Settings {
  archiveBelow: number;
  digestBelow: number;
  alertAbove: number;
  urgentAbove: number;
  minConfidence: number;
  fastPathWeight: number;
  pollSeconds: number;
  digestHours: number[];
  timezone: string;
}

export interface WeightRow {
  key: string;
  emails: number;
  lastSeen: number;
  weight: number | null;
  source: string | null;
  updatedAt: number | null;
}
export interface Category { name: string; description: string; protected: boolean }
export interface Proposal { id: number; ts: number; dim: Dim; key: string; suggested: number; reason: string }
export interface LogRow { ts: number; dim: string; key: string; before: number | null; after: number | null; source: string; reason: string }
export interface CallRow {
  ts: number; email_id: string | null; stage: string; model: string;
  input_tokens: number; output_tokens: number; cost: number; ms: number; subject: string | null;
}
export interface Activity {
  calls: CallRow[];
  byStage: { stage: string; n: number; cost: number; input_tokens: number; output_tokens: number }[];
  totals: { today: number; all: number };
}
export interface ChatStep {
  kind: "model" | "tool" | "result"; name?: string; args?: unknown; result?: string;
  isError?: boolean; cost?: number; tokens?: number;
}

export interface FakeInfo {
  auto: boolean;
  offsetMs: number;
  now: number;
  scenarios: { key: string; subject: string }[];
}
export interface AppNotification {
  ts: number; title: string; body: string; priority: number; click: string | null;
  status: "sent" | "skipped" | "failed" | "demo"; error: string | null;
}
export interface FakeMessage { id: string; from_hdr: string; subject: string; labels: string[] }
export type UserAct = "read" | "star" | "rescue" | "archive" | "reply";

export interface Status {
  /** when the next check is due (ms), or null if not connected */
  nextPoll: number | null;
  schedules: { type: string; at: number }[];
  fake: FakeInfo | null;
  push: { configured: boolean };
  account: string | null;
  connected: boolean;
  lastPoll: number | null;
  lastError: string | null;
  llmError: string | null;
  pendingProposals: number;
  costToday: number;
  settings: Settings;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  if (res.status === 401) throw new Error("unauthorized");
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`);
  return body as T;
}
const post = <T,>(path: string, body: unknown = {}) =>
  req<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  me: () => fetch("/api/me").then((r) => r.json() as Promise<{ email: string | null }>),
  status: () => req<Status>("/status"),
  feed: () => req<FeedRow[]>("/feed"),
  saveSettings: (s: Partial<Settings>) => req<Settings>("/settings", { method: "PUT", body: JSON.stringify(s) }),
  vote: (id: string, dir: 1 | -1, scope: Dim) => post("/vote", { id, dir, scope }),
  undo: (id: string) => post("/undo", { id }),
  pollNow: () => post<{ processed: number }>("/poll"),
  weights: (dim: Dim) => req<WeightRow[]>(`/weights?dim=${dim}`),
  setWeight: (dim: Dim, key: string, weight: number) =>
    req("/weights", { method: "PUT", body: JSON.stringify({ dim, key, weight }) }),
  clearWeight: (dim: Dim, key: string) =>
    req(`/weights?dim=${dim}&key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  preset: (dim: Dim, key: string, preset: "vip" | "normal" | "ignore") => post("/weights/preset", { dim, key, preset }),
  weightLog: () => req<LogRow[]>("/weights/log"),
  categories: () => req<Category[]>("/categories"),
  saveCategory: (c: Category) => req<Category[]>("/categories", { method: "PUT", body: JSON.stringify(c) }),
  deleteCategory: (name: string) => req<Category[]>(`/categories?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
  rules: () => req<string[]>("/rules"),
  addRule: (rule: string) => post<string[]>("/rules", { rule }),
  deleteRule: (rule: string) => req<string[]>(`/rules?rule=${encodeURIComponent(rule)}`, { method: "DELETE" }),
  proposals: () => req<Proposal[]>("/proposals"),
  resolveProposal: (id: number, accept: boolean) => post("/proposals/resolve", { id, accept }),
  activity: () => req<Activity>("/activity"),
  chatActivity: () => req<ChatStep[]>("/activity/chat"),
  sendDigest: () => post<{ items: number }>("/digest"),
  fakeDeliver: (b: { scenario?: string; all?: boolean; count?: number }) => post<{ ids: string[]; keys: string[] }>("/fake/deliver", b),
  fakeAct: (id: string, act: UserAct) => post("/fake/act", { id, act }),
  fakeClock: (advanceMs: number) => post("/fake/clock", { advanceMs }),
  fakeRun: (job: "poll" | "learn" | "digest" | "tick") => post("/fake/run", { job }),
  fakeAuto: (on: boolean) => post("/fake/auto", { on }),
  fakeReset: () => post("/fake/reset"),
  notifications: () => req<AppNotification[]>("/notifications"),
  fakeMessages: () => req<FakeMessage[]>("/fake/messages"),
  chatLog: () => req<{ role: string; text: string }[]>("/chat"),
  send: (message: string) => post("/chat", { message }),
};

/** Reconnecting socket; the server only says *what* changed, clients refetch. */
export function connect(onEvent: (type: string) => void): () => void {
  let ws: WebSocket;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data).type);
      } catch {}
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws.close();
  };
}
