const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
  date: number;
  labelIds: string[];
  /** lower-cased names of the headers we use for streams, signals and addressing */
  headers: Record<string, string>;
}

const WANTED_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "x-github-reason",
  "to",
  "cc",
  "delivered-to",
  "precedence",
];

/** Everything the poll loop needs from Gmail. The fake mode implements this too. */
export interface MailApi {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  recentInbox(max?: number): Promise<string[]>;
  newInboxIds(startHistoryId: string): Promise<{ ids: string[]; historyId: string }>;
  get(id: string): Promise<MailMessage>;
  modify(id: string, add: string[], remove: string[]): Promise<unknown>;
  unarchive(id: string): Promise<unknown>;
  ensureLabel(name: string): Promise<string>;
  labels(id: string): Promise<string[] | null>;
  repliedBefore(addr: string): Promise<boolean>;
  threadJoined(threadId: string): Promise<boolean>;
}

export class Gmail implements MailApi {
  constructor(private token: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const err = new Error(`gmail ${res.status} ${path}: ${await res.text()}`) as Error & {
        status: number;
      };
      err.status = res.status;
      throw err;
    }
    return res.json() as Promise<T>;
  }

  profile() {
    return this.call<{ emailAddress: string; historyId: string }>("/profile");
  }

  /** First run: recent inbox messages. */
  async recentInbox(max = 25): Promise<string[]> {
    const r = await this.call<{ messages?: { id: string }[] }>(
      `/messages?labelIds=INBOX&maxResults=${max}`,
    );
    return (r.messages ?? []).map((m) => m.id);
  }

  /** Incremental: message ids added to INBOX since `startHistoryId`. */
  async newInboxIds(startHistoryId: string): Promise<{ ids: string[]; historyId: string }> {
    const ids = new Set<string>();
    let historyId = startHistoryId;
    let pageToken: string | undefined;
    try {
      do {
        const q = new URLSearchParams({
          startHistoryId,
          historyTypes: "messageAdded",
          labelId: "INBOX",
        });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await this.call<{
          history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        }>(`/history?${q}`);
        for (const h of r.history ?? [])
          for (const a of h.messagesAdded ?? [])
            if (a.message.labelIds?.includes("INBOX")) ids.add(a.message.id);
        historyId = r.historyId ?? historyId;
        pageToken = r.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // 404 = history id too old; caller resyncs from the profile
      if ((e as { status?: number }).status === 404) return { ids: [], historyId: "" };
      throw e;
    }
    return { ids: [...ids], historyId };
  }

  async get(id: string): Promise<MailMessage> {
    const m = await this.call<GmailRaw>(`/messages/${id}?format=full`);
    const h = (n: string) =>
      m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return {
      id: m.id,
      threadId: m.threadId,
      from: h("from"),
      subject: h("subject"),
      snippet: m.snippet ?? "",
      body: extractText(m.payload).slice(0, 4000),
      date: Number(m.internalDate ?? Date.now()),
      labelIds: m.labelIds ?? [],
      headers: Object.fromEntries(
        WANTED_HEADERS.map((n) => [n, h(n)] as const).filter(([, v]) => v),
      ),
    };
  }

  /** Current labels only, for implicit-feedback checks. */
  async labels(id: string): Promise<string[] | null> {
    try {
      const m = await this.call<{ labelIds?: string[] }>(`/messages/${id}?format=minimal`);
      return m.labelIds ?? [];
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null; // deleted by the user
      throw e;
    }
  }

  /** Have you ever sent mail to this address? */
  async repliedBefore(addr: string): Promise<boolean> {
    const q = encodeURIComponent(`in:sent to:${addr}`);
    const r = await this.call<{ messages?: unknown[] }>(`/messages?q=${q}&maxResults=1`);
    return !!r.messages?.length;
  }

  /** Have you sent a message in this thread? */
  async threadJoined(threadId: string): Promise<boolean> {
    const t = await this.call<{ messages?: { labelIds?: string[] }[] }>(
      `/threads/${threadId}?format=minimal`,
    );
    return !!t.messages?.some((m) => m.labelIds?.includes("SENT"));
  }

  modify(id: string, add: string[], remove: string[]) {
    return this.call(`/messages/${id}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    });
  }

  archive(id: string) {
    return this.modify(id, [], ["INBOX"]);
  }

  unarchive(id: string) {
    return this.modify(id, ["INBOX"], []);
  }

  /** Find or create a label; used to tag what the agent touched. */
  async ensureLabel(name: string): Promise<string> {
    const r = await this.call<{ labels: { id: string; name: string }[] }>("/labels");
    const hit = r.labels.find((l) => l.name === name);
    if (hit) return hit.id;
    const c = await this.call<{ id: string }>("/labels", {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    return c.id;
  }
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}
interface GmailRaw {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: Part;
}

function decode(b64url: string): string {
  const b = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

function extractText(p?: Part): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return decode(p.body.data);
  for (const c of p.parts ?? []) {
    const t = extractText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    return decode(p.body.data)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export const senderEmail = (from: string) =>
  (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
export const senderDomain = (from: string) => senderEmail(from).split("@")[1] ?? "";

const addrs = (v: string | undefined) =>
  (v ?? "").split(",").map((p) => senderEmail(p)).filter((p) => p.includes("@"));

/**
 * Stream keys, most specific first. A List-Id identifies a mailing list or notification stream
 * (a GitHub repo, a Google Group); X-GitHub-Reason narrows it (review_requested vs ci_activity).
 */
export function streamKeys(h: Record<string, string>): string[] {
  const listId = (h["list-id"]?.match(/<([^>]+)>/)?.[1] ?? h["list-id"])?.trim().toLowerCase();
  if (!listId) return [];
  const reason = h["x-github-reason"]?.trim().toLowerCase();
  return reason ? [`${listId}|${reason}`, listId] : [listId];
}

/** The address of yours this was sent to, e.g. an alias. Null if it can't be told. */
export function recipientAlias(h: Record<string, string>, account: string | null): string | null {
  const me = account?.toLowerCase();
  const candidates = [...addrs(h["delivered-to"]), ...addrs(h.to), ...addrs(h.cc)];
  return candidates.find((a) => a === me) ?? candidates.find((a) => me && a.split("@")[1] === me.split("@")[1]) ?? null;
}

export function addressedTo(h: Record<string, string>, account: string | null): boolean {
  const me = account?.toLowerCase();
  return !!me && addrs(h.to).includes(me);
}

export const isBulk = (h: Record<string, string>) =>
  !!h["list-unsubscribe"] || /bulk|list|junk/i.test(h.precedence ?? "");
