import type { Answer, JevCall, Question } from "./jev";

/**
 * An offline stand-in for Jev: keyword heuristics that answer the same typed questions.
 * It is deterministic, so pipeline tests can pin outcomes. It is NOT a quality model.
 */

const AUTOMATED = /no-?reply|donotreply|notification|mailer|newsletter|marketing|alerts?@|billing@|orders@|bookings@|support@|hello@|info@|team@|office@|admin@|github\.com|pagerduty|linkedin|accounts\./i;

/** keyword -> weight, per built-in category name. Custom categories match on their description. */
const KEYWORDS: Record<string, RegExp[]> = {
  finance: [/invoice/i, /payment/i, /statement/i, /\btax\b/i, /\$\d/],
  transactional: [/receipt/i, /order (?:was )?(?:delivered|confirmed)/i, /your order/i, /shipped/i, /charged/i],
  security: [/verification code/i, /password/i, /security alert/i, /sign[- ]in/i, /secure your account/i],
  calendar: [/invitation/i, /invited to a meeting/i, /calendar/i, /accept or decline/i],
  travel: [/itinerary/i, /flight/i, /booking is confirmed/i, /check in/i],
  support: [/support ticket/i, /ticket #/i, /contacting support/i],
  legal: [/legal/i, /compliance/i, /contract/i, /court/i],
  social: [/liked your post/i, /linkedin/i, /follow(?:ed|ers)/i],
  notification: [/pull request/i, /build (?:passed|failed)/i, /workflow run/i, /requested your review/i, /health checks/i],
  newsletter: [/newsletter/i, /roundup/i, /this week's/i, /weekly/i],
  promo: [/% off/i, /\bsale\b/i, /discount/i, /shop now/i, /early bird/i, /unsubscribe/i],
  work: [/roadmap/i, /standup/i, /customer projects?/i, /sprint/i, /deck\b/i],
};

const BASE_IMPORTANCE: Record<string, number> = {
  personal: 4, work: 3.5, finance: 3.5, security: 3, calendar: 3, support: 3, travel: 3, legal: 3.5,
  transactional: 2, notification: 2, social: 1.5, newsletter: 1.5, promo: 1, other: 2,
};

const KIND_RULES: [string, RegExp][] = [
  ["alert", /critical|outage|is down|failed|failing|security alert/i],
  ["invite", /invitation|invited to a meeting/i],
  ["receipt", /receipt|total \$|charged to/i],
  ["digest", /roundup|this week's|workflow run|newsletter/i],
  ["marketing", /% off|sale\b|discount|shop now/i],
  ["ask", /\?|please |could you|can you|let me know|acknowledge/i],
  ["conversation", /^re:/i],
];

const STOP = new Set(["that", "this", "with", "from", "your", "have", "will", "about", "into", "than", "them", "they", "their"]);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((t) => !STOP.has(t));

interface MailState { from?: string; subject?: string; snippet?: string; body?: string }
const textOf = (s: MailState) => `${s.from ?? ""}\n${s.subject ?? ""}\n${s.body || s.snippet || ""}`;
const hits = (res: RegExp[], t: string) => res.filter((r) => r.test(t)).length;

export function guessCategory(
  state: MailState,
  categories: Record<string, string | null>,
): { choice: string; confidence: number } {
  const t = textOf(state);
  const automated = AUTOMATED.test(state.from ?? "");
  const scores: Record<string, number> = {};
  for (const name of Object.keys(categories)) {
    let sc = 0;
    if (KEYWORDS[name]) sc += 2 * hits(KEYWORDS[name]!, t);
    else if (name !== "other" && name !== "personal") {
      // custom category: overlap between its name/description and the email
      const want = new Set([...tokens(name.replace(/-/g, " ")), ...tokens(categories[name] ?? "")]);
      const lower = t.toLowerCase();
      sc += tokens(t).filter((w) => want.has(w)).length;
      if (name.split("-").some((p) => p.length > 3 && lower.includes(p))) sc += 3;
    }
    if (name === "personal" && !automated) sc += 1.5;
    scores[name] = sc;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = [ranked[0], ranked[1]];
  if (!top || top[1] <= 0) {
    return { choice: "other" in categories ? "other" : (top?.[0] ?? "other"), confidence: 0.4 };
  }
  return { choice: top[0], confidence: top[1] - (second?.[1] ?? 0) >= 1 ? 0.9 : 0.6 };
}

const noul = (n: number): Answer => ({ type: "noul", noul: Math.min(1, Math.max(0, n)) });

export const fakeJev: JevCall = async (_key, stage, state, questions, onUsage) => {
  const t0 = Date.now();
  const s = (state ?? {}) as MailState & {
    facets?: { category: string; kind: string; automated: boolean };
    rules?: string[];
  };
  const text = textOf(s);
  const out: Record<string, Answer> = {};

  for (const [id, q] of Object.entries(questions)) {
    out[id] = answer(id, q, s, text);
  }

  const inTokens = Math.ceil(JSON.stringify(state).length / 4);
  onUsage?.(stage, {
    inputTokens: inTokens,
    outputTokens: 0,
    cost: (inTokens / 1e6) * 0.042,
    ms: Date.now() - t0 + 1,
  });
  return out;
};

function answer(
  id: string,
  q: Question,
  s: MailState & { facets?: { category: string; kind: string }; rules?: string[] },
  text: string,
): Answer {
  switch (id) {
    case "category": {
      const g = guessCategory(s, (q as Extract<Question, { type: "choice" }>).criteria);
      return { type: "choice", choice: g.choice, confidence: g.confidence, probabilities: { [g.choice]: g.confidence } };
    }
    case "kind": {
      const criteria = (q as Extract<Question, { type: "choice" }>).criteria;
      const hit = KIND_RULES.find(([, re]) => re.test(text));
      const choice = hit && hit[0] in criteria ? hit[0] : "update";
      return { type: "choice", choice, confidence: 0.85, probabilities: { [choice]: 0.85 } };
    }
    case "automated":
      return noul(AUTOMATED.test(s.from ?? "") ? 0.9 : 0.1);
    case "has_deadline":
      return noul(/\bdue\b|deadline|overdue|by (?:monday|tuesday|wednesday|thursday|friday)|before standup|next week/i.test(text) ? 0.85 : 0.05);
    case "involves_money":
      return noul(/\$\d|invoice|payment|refund|charged/i.test(text) ? 0.85 : 0.05);
    case "reply_expected":
      return noul(/\?|please (?:reply|return|arrange)|let me know|can you|could you|acknowledge/i.test(text) ? 0.8 : 0.1);
    case "needs_action":
      return noul(/\?|please |could you|can you|requested your review|acknowledge|due\b|permission forms?/i.test(text) ? 0.8 : 0.1);
    case "urgent":
      return noul(/critical|outage|is down|immediately|health checks|cannot place orders/i.test(text) ? 0.92 : 0.03);
    case "importance": {
      const category = s.facets?.category ?? "other";
      let score = BASE_IMPORTANCE[category] ?? 2;
      // the reader's standing rules: any rule sharing a distinctive word with the email lifts it
      const mail = new Set(tokens(text));
      if ((s.rules ?? []).some((r) => tokens(r).some((w) => mail.has(w)))) score += 1;
      // a deadline or a direct ask lifts it a notch
      if (/\bdue\b|deadline|requested your review/i.test(text)) score += 0.5;
      const lowConfidence = category === "other";
      return { type: "score", score: Math.min(5, score), confidence: lowConfidence ? 0.4 : 0.9 };
    }
    default:
      return q.type === "noul" ? noul(0.5) : q.type === "score" ? { type: "score", score: 3, confidence: 0.5 } : { type: "choice", choice: Object.keys(q.criteria)[0] ?? "", confidence: 0.5, probabilities: {} };
  }
}

/** Pure helpers the fake Luna uses. */
export function fakeSummary(from: string, subject: string, body: string): string {
  const first = body.replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0] ?? body;
  return `${first.slice(0, 160)}${first.length > 160 ? "…" : ""}`;
}

export function fakeDigest(items: { sender: string; subject: string; category: string }[]): string {
  const by = new Map<string, string[]>();
  for (const i of items) {
    const name = i.sender.replace(/<.*>/, "").trim() || i.sender;
    by.set(i.category, [...(by.get(i.category) ?? []), `${name}: ${i.subject}`]);
  }
  return [...by].map(([c, l]) => `${c} (${l.length}): ${l.slice(0, 3).join("; ")}${l.length > 3 ? "; …" : ""}`).join("\n");
}
