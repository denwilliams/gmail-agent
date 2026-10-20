import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { MailApi, MailMessage } from "./gmail";
import { senderEmail } from "./gmail";
import { SCENARIOS, type Scenario } from "./fake-data";

type Bind = string | number | null;
export type UserAct = "read" | "star" | "rescue" | "archive" | "reply";

/** DDL for everything the fake mode stores. Created only when FAKE_MODE is on. */
export const FAKE_TABLES = [
  `CREATE TABLE IF NOT EXISTS fake_messages (
    id TEXT PRIMARY KEY, thread_id TEXT, from_hdr TEXT, to_hdr TEXT, subject TEXT, snippet TEXT,
    body TEXT, headers TEXT, labels TEXT, date INTEGER)`,
  `CREATE TABLE IF NOT EXISTS fake_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS fake_labels (name TEXT PRIMARY KEY, id TEXT)`,
];

/** An in-memory-ish Gmail that lives in the Durable Object's SQLite. */
export class FakeGmail implements MailApi {
  constructor(
    private sql: SqlStorage,
    private now: () => number,
    private account: string,
    /** pretend network latency per call, so polls can interleave like they do against the real API */
    private latencyMs = 0,
  ) {}

  private async lag() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private rows<T extends Record<string, SqlStorageValue>>(q: string, ...p: Bind[]): T[] {
    return this.sql.exec<T>(q, ...p).toArray();
  }
  private run(q: string, ...p: Bind[]) {
    this.sql.exec(q, ...p);
  }
  private labelsOf(id: string): string[] | null {
    const r = this.rows<{ labels: string }>("SELECT labels FROM fake_messages WHERE id = ?", id)[0];
    return r ? (JSON.parse(r.labels) as string[]) : null;
  }
  private setLabels(id: string, labels: string[]) {
    this.run("UPDATE fake_messages SET labels = ? WHERE id = ?", JSON.stringify([...new Set(labels)]), id);
  }

  // -- the MailApi surface --------------------------------------------------

  async profile() {
    const seq = this.rows<{ m: number | null }>("SELECT MAX(seq) m FROM fake_history")[0]?.m ?? 0;
    return { emailAddress: this.account, historyId: String(seq) };
  }

  async recentInbox(max = 25) {
    return this.rows<{ id: string }>(
      `SELECT id FROM fake_messages WHERE labels LIKE '%"INBOX"%' ORDER BY date DESC LIMIT ?`,
      max,
    ).map((r) => r.id);
  }

  async newInboxIds(startHistoryId: string) {
    const rows = this.rows<{ seq: number; message_id: string }>(
      "SELECT seq, message_id FROM fake_history WHERE seq > ? ORDER BY seq",
      Number(startHistoryId) || 0,
    );
    return {
      ids: rows.map((r) => r.message_id),
      historyId: String(rows.at(-1)?.seq ?? startHistoryId),
    };
  }

  async get(id: string): Promise<MailMessage> {
    await this.lag();
    const r = this.rows<{
      id: string; thread_id: string; from_hdr: string; subject: string; snippet: string;
      body: string; headers: string; labels: string; date: number; to_hdr: string;
    }>("SELECT * FROM fake_messages WHERE id = ?", id)[0];
    if (!r) throw Object.assign(new Error(`fake gmail: no message ${id}`), { status: 404 });
    return {
      id: r.id,
      threadId: r.thread_id,
      from: r.from_hdr,
      subject: r.subject,
      snippet: r.snippet,
      body: r.body,
      date: r.date,
      labelIds: JSON.parse(r.labels),
      headers: { to: r.to_hdr, ...JSON.parse(r.headers) },
    };
  }

  async modify(id: string, add: string[], remove: string[]) {
    const cur = this.labelsOf(id);
    if (!cur) throw Object.assign(new Error("not found"), { status: 404 });
    this.setLabels(id, [...cur.filter((l) => !remove.includes(l)), ...add]);
  }

  unarchive(id: string) {
    return this.modify(id, ["INBOX"], []);
  }

  async ensureLabel(name: string) {
    const hit = this.rows<{ id: string }>("SELECT id FROM fake_labels WHERE name = ?", name)[0];
    if (hit) return hit.id;
    const id = `Label_${name.toLowerCase().replace(/\W+/g, "_")}`;
    this.run("INSERT INTO fake_labels (name, id) VALUES (?, ?)", name, id);
    return id;
  }

  async labels(id: string) {
    return this.labelsOf(id);
  }

  async repliedBefore(addr: string) {
    await this.lag();
    return (
      this.rows(
        `SELECT 1 FROM fake_messages WHERE labels LIKE '%"SENT"%' AND lower(to_hdr) LIKE ? LIMIT 1`,
        `%${addr.toLowerCase()}%`,
      ).length > 0
    );
  }

  async threadJoined(threadId: string) {
    await this.lag();
    return (
      this.rows(
        `SELECT 1 FROM fake_messages WHERE thread_id = ? AND labels LIKE '%"SENT"%' LIMIT 1`,
        threadId,
      ).length > 0
    );
  }

  // -- the demo surface -----------------------------------------------------

  private nextId() {
    const n = this.rows<{ n: number }>("SELECT COUNT(*) n FROM fake_messages")[0]!.n + 1;
    return `fake-${String(n).padStart(4, "0")}`;
  }

  /** Put a message in the inbox (and the history feed the poller reads). */
  deliver(s: Pick<Scenario, "from" | "subject" | "body" | "headers"> & { thread?: string }): string {
    const id = this.nextId();
    this.run(
      `INSERT INTO fake_messages (id, thread_id, from_hdr, to_hdr, subject, snippet, body, headers, labels, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.thread ?? `thread-${id}`,
      s.from,
      this.account,
      s.subject,
      s.body.replace(/\s+/g, " ").slice(0, 120),
      s.body,
      JSON.stringify(s.headers ?? {}),
      JSON.stringify(["INBOX", "UNREAD"]),
      this.now(),
    );
    this.run("INSERT INTO fake_history (message_id) VALUES (?)", id);
    return id;
  }

  /** The user has written to this address before. */
  seedSent(addr: string) {
    const id = this.nextId();
    this.run(
      `INSERT INTO fake_messages (id, thread_id, from_hdr, to_hdr, subject, snippet, body, headers, labels, date)
       VALUES (?, ?, ?, ?, 'Re: earlier', '', '', '{}', ?, ?)`,
      id, `thread-${id}`, this.account, addr, JSON.stringify(["SENT"]), this.now() - 30 * 86400_000,
    );
  }

  /** Simulates what a person does in Gmail, so `learn()` has something to observe. */
  act(id: string, what: UserAct): string[] | null {
    const cur = this.labelsOf(id);
    if (!cur) return null;
    switch (what) {
      case "read": this.setLabels(id, cur.filter((l) => l !== "UNREAD")); break;
      case "star": this.setLabels(id, [...cur, "STARRED"]); break;
      case "rescue": this.setLabels(id, [...cur, "INBOX"]); break;
      case "archive": this.setLabels(id, cur.filter((l) => l !== "INBOX")); break;
      case "reply": {
        const m = this.rows<{ thread_id: string; from_hdr: string }>(
          "SELECT thread_id, from_hdr FROM fake_messages WHERE id = ?", id)[0]!;
        const rid = this.nextId();
        this.run(
          `INSERT INTO fake_messages (id, thread_id, from_hdr, to_hdr, subject, snippet, body, headers, labels, date)
           VALUES (?, ?, ?, ?, 'Re:', '', '', '{}', ?, ?)`,
          rid, m.thread_id, this.account, senderEmail(m.from_hdr), JSON.stringify(["SENT"]), this.now(),
        );
        this.setLabels(id, cur.filter((l) => l !== "UNREAD"));
        break;
      }
    }
    return this.labelsOf(id);
  }

  reset() {
    for (const t of ["fake_messages", "fake_history", "fake_labels"]) this.run(`DELETE FROM ${t}`);
  }
}

/** Seed the people the user "has written to", so the replied-before guard has something to find. */
export function seedKnownContacts(g: FakeGmail) {
  for (const s of SCENARIOS) if (s.knownContact) g.seedSent(senderEmail(s.from));
}

// ---- scripted chat model -----------------------------------------------------

type Call = { name: string; args: Record<string, unknown> };

/** Turn a chat message into tool calls. Deliberately simple: it exists to drive the real tool path offline. */
export function planChat(msg: string): { calls: Call[]; say: string } | null {
  const m = msg.trim();
  let r: RegExpMatchArray | null;

  const target = (t: string): { dim: string; key: string } => {
    const k = t.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (k.includes("@")) return { dim: "sender", key: k };
    if (k.includes(".")) return { dim: "domain", key: k };
    return { dim: "category", key: k };
  };

  if ((r = m.match(/^(?:treat|mark)\s+(.+?)\s+as\s+(?:important|vip)/i))) {
    const t = target(r[1]!);
    return { calls: [{ name: "set_weight", args: { ...t, weight: 3, reason: "chat: treat as important" } }], say: `Boosted ${t.dim} ${t.key}.` };
  }
  if ((r = m.match(/^(?:ignore|mute|hide|stop (?:alerting me about|showing me))\s+(.+)/i))) {
    const t = target(r[1]!);
    return { calls: [{ name: "set_weight", args: { ...t, weight: 0.2, reason: "chat: ignore" } }], say: `Turned down ${t.dim} ${t.key}.` };
  }
  if ((r = m.match(/^add (?:a )?rule[:\s]+(.+)/i))) {
    return { calls: [{ name: "add_rule", args: { rule: r[1]!.trim() } }], say: "Added the rule." };
  }
  if ((r = m.match(/^add (?:a )?category (?:for|called)?\s*([\w -]+?)(?:\s*[:,-]\s*(.+))?$/i))) {
    const name = r[1]!.trim().split(/\s+/)[0]!.toLowerCase();
    const description = r[2]?.trim() || `Emails about ${r[1]!.trim()}`;
    return { calls: [{ name: "upsert_category", args: { name, description } }], say: `Added the ${name} category.` };
  }
  if ((r = m.match(/poll every (\d+)/i))) {
    return { calls: [{ name: "update_settings", args: { pollSeconds: Number(r[1]) } }], say: "Updated the poll interval." };
  }
  if (/\b(why|explain)\b/i.test(m)) {
    return { calls: [{ name: "recent_decisions", args: { limit: 5 } }], say: "Here are the latest decisions." };
  }
  if ((r = m.match(/list (sender|stream|domain|alias|category|kind) weights/i))) {
    return { calls: [{ name: "list_weights", args: { dim: r[1]!.toLowerCase() } }], say: "Here are the weights." };
  }
  return null;
}

type Msg = { role: string; content?: unknown };
const textOf = (c: unknown) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "";

/** A chat model that runs on the real PiHarness but needs no network. */
export function createFakeChat() {
  const faux = fauxProvider({ models: [{ id: "fake-chat", name: "Fake chat" }] });
  const respond: FauxResponseFactory = (ctx) => {
    faux.appendResponses([respond]); // answer every call, not just one
    // Pi can append system messages (prompt and tool changes); respond to the last real turn.
    const messages = ((ctx as unknown as { messages: Msg[] }).messages ?? []).filter((m) => m.role !== "system");
    const last = messages.at(-1);
    if (last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText(`Done. ${textOf(last.content).slice(0, 300)}`)]);
    }
    const plan = planChat(textOf(last?.content));
    if (!plan) {
      return fauxAssistantMessage([
        fauxText("I can set weights, add rules or categories, change the poll interval, list weights or explain decisions."),
      ]);
    }
    // Pi only runs the tools when the turn ends with stopReason "toolUse".
    return fauxAssistantMessage(
      [
        fauxText(plan.say),
        ...plan.calls.map((c, i) => fauxToolCall(c.name, c.args as never, { id: `fake-call-${Date.now()}-${i}` })),
      ],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([respond]);
  return faux;
}
