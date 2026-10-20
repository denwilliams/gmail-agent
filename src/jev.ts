/**
 * Jev (TypeSafe System One): POST a state plus typed questions, get one typed answer per question.
 * Wire contract: https://api.typesafe.ai/v1/systemone
 *
 * Two stages per email:
 *   classify: facets (category, kind, flags). No weights or taste in the prompt.
 *   judge:    importance / needs_action / urgent, with weights, rules, signals and corrections in the prompt.
 */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD. Reported by Jev when available, otherwise estimated from the catalog price. */
  cost: number;
  ms: number;
}
export type OnUsage = (stage: string, u: JevUsage) => void;

/** The transport. Fake mode swaps in a local stand-in with the same signature. */
export type JevCall = (
  apiKey: string,
  stage: string,
  state: unknown,
  questions: Record<string, Question>,
  onUsage?: OnUsage,
  model?: string,
) => Promise<Record<string, Answer>>;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRY = new Set([429, 502, 503, 529]);
/** Catalog price for jev-latest: $0.042 per 1M input tokens, output free. */
const INPUT_PER_MILLION = 0.042;

export async function jev(
  apiKey: string,
  stage: string,
  state: unknown,
  questions: Record<string, Question>,
  onUsage?: OnUsage,
  model = "jev-latest",
): Promise<Record<string, Answer>> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        answers: Record<string, Answer>;
        usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
      };
      const inTok = body.usage?.input_tokens ?? 0;
      const reported = body.usage?.cost;
      onUsage?.(stage, {
        inputTokens: inTok,
        outputTokens: body.usage?.output_tokens ?? 0,
        cost: typeof reported === "number" && reported >= 0 ? reported : (inTok / 1e6) * INPUT_PER_MILLION,
        ms: Date.now() - started,
      });
      return body.answers;
    }
    if (!RETRY.has(res.status) || attempt >= 2) {
      throw new Error(`jev ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

// ---- categories and kinds ---------------------------------------------------

export interface CategoryDef {
  name: string;
  description: string;
  protected: boolean;
}

/** Seeded into the DB on first run. After that the DB is the source of truth. */
export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { name: "personal", description: "A real person writing to the reader directly", protected: true },
  { name: "work", description: "Colleagues, customers or vendors on work matters", protected: false },
  { name: "finance", description: "Invoices, bills, statements, payment requests, tax", protected: false },
  { name: "transactional", description: "Receipts, order confirmations, bookings, shipping", protected: false },
  { name: "security", description: "Login codes, password resets, security alerts, fraud warnings", protected: true },
  { name: "calendar", description: "Meeting invites, schedule changes, reminders", protected: false },
  { name: "travel", description: "Flights, accommodation, itineraries, transport", protected: false },
  { name: "support", description: "Replies and tickets from vendors' support teams", protected: false },
  { name: "legal", description: "Legal, government, compliance, contracts", protected: true },
  { name: "social", description: "Social network notifications and community mail", protected: false },
  { name: "notification", description: "Automated product or system notifications", protected: false },
  { name: "newsletter", description: "Newsletters and digests the reader subscribed to", protected: false },
  { name: "promo", description: "Marketing, sales, discounts, cold outreach", protected: false },
  { name: "other", description: "Anything that fits none of the above", protected: false },
];

export const KINDS: Record<string, string> = {
  conversation: "Part of a back-and-forth between people",
  ask: "Asks the reader to do, decide or answer something",
  alert: "An automated warning that something is wrong or changed",
  receipt: "Proof of a completed purchase or payment",
  invite: "An invitation or calendar event",
  update: "A status update or FYI that needs no response",
  digest: "A roundup of many items",
  marketing: "Promotional content",
  other: "None of the above",
};

// ---- stage 1: classify ------------------------------------------------------

export interface MailView {
  from: string;
  subject: string;
  snippet: string;
  body: string;
}

export interface Classified {
  category: string;
  kind: string;
  automated: number;
  hasDeadline: number;
  involvesMoney: number;
  replyExpected: number;
  confidence: number;
}

export function classifyQuestions(categories: CategoryDef[]): Record<string, Question> {
  return {
    category: {
      type: "choice",
      instructions: "What category is this email? Judge from `from`, `subject` and `body`.",
      criteria: Object.fromEntries(categories.map((c) => [c.name, c.description])),
    },
    kind: {
      type: "choice",
      instructions: "What kind of message is this, regardless of topic?",
      criteria: KINDS,
    },
    automated: { type: "noul", instructions: "Was this sent by an automated system rather than a person writing it?" },
    has_deadline: { type: "noul", instructions: "Does the email state or imply a deadline or due date?" },
    involves_money: { type: "noul", instructions: "Does it involve a payment, invoice, charge, refund or amount owed?" },
    reply_expected: { type: "noul", instructions: "Is the sender expecting a reply or action from the reader?" },
  };
}

export async function classify(
  apiKey: string,
  mail: MailView,
  categories: CategoryDef[],
  onUsage?: OnUsage,
  call: JevCall = jev,
): Promise<Classified> {
  const a = await call(apiKey, "classify", mail, classifyQuestions(categories), onUsage);
  const cat = a.category as Extract<Answer, { type: "choice" }>;
  const kind = a.kind as Extract<Answer, { type: "choice" }>;
  const n = (k: string) => (a[k] as Extract<Answer, { type: "noul" }>).noul;
  return {
    category: cat.choice,
    kind: kind.choice,
    automated: n("automated"),
    hasDeadline: n("has_deadline"),
    involvesMoney: n("involves_money"),
    replyExpected: n("reply_expected"),
    confidence: Math.min(cat.confidence, kind.confidence),
  };
}

// ---- stage 2: judge ---------------------------------------------------------

export interface JudgeInput extends MailView {
  facets: { category: string; kind: string; automated: boolean };
  /** Observed facts about the relationship, not opinions. */
  signals: Record<string, boolean>;
  /** The reader's combined multiplier for this email; 1 is neutral. */
  weight: number;
  rules: string[];
  taste_examples: { from: string; subject: string; verdict: string }[];
}

const IMPORTANCE_LEVELS = [
  "Ignorable",
  "Low value, safe to archive",
  "Worth seeing at some point",
  "Should be read today",
  "Must be seen right now",
];

const URGENT_Q: Question = {
  type: "noul",
  instructions:
    "Is this time-critical: something that will cause harm or a missed deadline if not seen within a couple of hours?",
};

export interface Judged {
  importance: number; // 0..1
  needsAction: number;
  urgent: number;
  confidence: number;
}

/** `urgentOnly` is the fast path for emails the reader has weighted down hard. */
export async function judge(
  apiKey: string,
  input: JudgeInput,
  urgentOnly: boolean,
  onUsage?: OnUsage,
  call: JevCall = jev,
): Promise<Judged> {
  const questions: Record<string, Question> = urgentOnly
    ? { urgent: URGENT_Q }
    : {
        importance: {
          type: "score",
          instructions:
            "How important is this to the reader? Follow `rules` (the reader's standing instructions) over general judgment. `weight` above 1 means the reader wants more of this, below 1 less. `signals` are observed facts about the relationship. `taste_examples` shows past emails the reader corrected.",
          criteria: IMPORTANCE_LEVELS,
        },
        needs_action: { type: "noul", instructions: "Does this email require the reader to do or answer something?" },
        urgent: URGENT_Q,
      };
  const a = await call(apiKey, urgentOnly ? "judge-fast" : "judge", input, questions, onUsage);
  const urgent = (a.urgent as Extract<Answer, { type: "noul" }>).noul;
  if (urgentOnly) return { importance: 0, needsAction: 0, urgent, confidence: 1 };
  const imp = a.importance as Extract<Answer, { type: "score" }>;
  return {
    importance: Math.min(1, Math.max(0, (imp.score - 1) / (IMPORTANCE_LEVELS.length - 1))),
    needsAction: (a.needs_action as Extract<Answer, { type: "noul" }>).noul,
    urgent,
    confidence: imp.confidence,
  };
}
