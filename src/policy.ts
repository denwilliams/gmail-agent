import type { Classified, Judged } from "./jev";

export type Action = "alert" | "keep" | "digest" | "archive";

export interface Settings {
  /** attention below this is archived silently */
  archiveBelow: number;
  /** attention below this (and above archiveBelow) goes in the digest */
  digestBelow: number;
  /** attention at or above this pushes a notification */
  alertAbove: number;
  /** Jev urgent probability that alone triggers an alert */
  urgentAbove: number;
  /** below this Jev confidence we never archive or digest */
  minConfidence: number;
  pollSeconds: number;
  /** local hours (0-23) at which the digest is pushed */
  digestHours: number[];
  timezone: string;
  /** a combined weight at or below this skips the full judge and only checks urgency */
  fastPathWeight: number;
}

export const DEFAULT_SETTINGS: Settings = {
  archiveBelow: 0.2,
  digestBelow: 0.5,
  alertAbove: 0.9,
  urgentAbove: 0.7,
  minConfidence: 0.5,
  pollSeconds: 600,
  digestHours: [8, 17],
  timezone: "Australia/Melbourne",
  fastPathWeight: 0.3,
};

// ---- weights ----------------------------------------------------------------

/** Bounds for how often to check for new mail. */
export const MIN_POLL_SECONDS = 15;
export const MAX_POLL_SECONDS = 3600;
export const clampPoll = (s: number) => Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(s) || DEFAULT_SETTINGS.pollSeconds));

export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 3;
export const clampWeight = (w: number) => Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w));

export interface WeightKeys {
  sender: string;
  /** most specific first, e.g. ["list-id|reason", "list-id"] */
  streams: string[];
  domain: string;
  alias: string | null;
  category: string;
  kind: string;
}

export interface WeightPart {
  dim: string;
  key: string;
  weight: number;
  /** identity parts compete (most specific wins); content parts multiply */
  group: "identity" | "content";
  applied: boolean;
}

export interface Resolved {
  weight: number;
  parts: WeightPart[];
}

/**
 * Identity (sender > stream > domain): the most specific weight that exists wins.
 * Content (category, kind, alias): multiply, since they describe different things.
 * The product is clamped.
 */
export function resolveWeight(
  lookup: (dim: string, key: string) => number | undefined,
  k: WeightKeys,
): Resolved {
  const parts: WeightPart[] = [];
  const identity: [string, string][] = [
    ["sender", k.sender],
    ...k.streams.map((s): [string, string] => ["stream", s]),
    ["domain", k.domain],
  ];
  let id = 1;
  let won = false;
  for (const [dim, key] of identity) {
    const w = lookup(dim, key);
    if (w === undefined) continue;
    parts.push({ dim, key, weight: w, group: "identity", applied: !won });
    if (!won) {
      id = w;
      won = true;
    }
  }

  let content = 1;
  const contentDims: [string, string | null][] = [
    ["category", k.category],
    ["kind", k.kind],
    ["alias", k.alias],
  ];
  for (const [dim, key] of contentDims) {
    if (!key) continue;
    const w = lookup(dim, key);
    if (w === undefined) continue;
    parts.push({ dim, key, weight: w, group: "content", applied: true });
    content *= w;
  }
  return { weight: clampWeight(id * content), parts };
}

// ---- decision ---------------------------------------------------------------

export interface Signals {
  repliedBefore: boolean;
  toMe: boolean;
  bulk: boolean;
  threadJoined: boolean;
}

export interface Decision {
  action: Action;
  attention: number;
  reasons: string[];
}

export interface DecideInput {
  facets: Classified;
  judged: Judged;
  signals: Signals;
  weight: number;
  protectedCategory: boolean;
}

/** Deterministic, explainable policy. Every branch adds a reason shown on the card. */
export function decide(i: DecideInput, s: Settings): Decision {
  const { facets: f, judged: j, signals: sig } = i;
  const reasons: string[] = [f.category, f.kind, `importance ${pct(j.importance)}`];
  // Noisy-OR: importance is the base, and needs-action / urgency each raise it without capping it.
  const base = 1 - (1 - j.importance) * (1 - 0.5 * j.needsAction) * (1 - 0.5 * j.urgent);
  const attention = clamp01(base * i.weight);
  if (i.weight !== 1) reasons.push(`weight ×${i.weight.toFixed(2)}`);

  if (j.urgent >= s.urgentAbove || attention >= s.alertAbove) {
    if (j.urgent >= s.urgentAbove) reasons.push(`urgent ${pct(j.urgent)}`);
    return { action: "alert", attention: Math.max(attention, s.alertAbove), reasons };
  }

  // Hard guards: below here the email can only be kept, never hidden.
  const guard = hardGuard(i, s);
  if (guard) return { action: "keep", attention, reasons: [...reasons, guard] };

  if (attention < s.archiveBelow) return { action: "archive", attention, reasons };
  if (attention < s.digestBelow) return { action: "digest", attention, reasons };
  return { action: "keep", attention, reasons };
}

function hardGuard(i: DecideInput, s: Settings): string | null {
  const { facets: f, judged: j, signals: sig } = i;
  if (i.protectedCategory) return "protected category";
  if (sig.repliedBefore) return "you've replied to this sender before";
  if (sig.threadJoined) return "you're in this thread";
  if (j.needsAction >= 0.5) return "needs action";
  if ((f.hasDeadline >= 0.6 || f.involvesMoney >= 0.6) && f.replyExpected >= 0.6) {
    return "deadline or money and a reply is expected";
  }
  if (Math.min(f.confidence, j.confidence) < s.minConfidence) return "low confidence";
  return null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => `${Math.round(n * 100)}%`;
