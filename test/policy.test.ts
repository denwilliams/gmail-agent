import { describe, expect, it } from "vitest";
import { recipientAlias, streamKeys } from "../src/gmail";
import type { Classified, Judged } from "../src/jev";
import {
  decide,
  DEFAULT_SETTINGS,
  resolveWeight,
  type DecideInput,
  type Signals,
  type WeightKeys,
} from "../src/policy";

const keys: WeightKeys = {
  sender: "a@x.com",
  streams: ["repo.github.com|ci_activity", "repo.github.com"],
  domain: "x.com",
  alias: "me+news@example.com",
  category: "newsletter",
  kind: "digest",
};
const table = (t: Record<string, number>) => (dim: string, key: string) => t[`${dim}:${key}`];

describe("resolveWeight", () => {
  it("is neutral with no weights", () => {
    expect(resolveWeight(table({}), keys).weight).toBe(1);
  });
  it("sender beats stream beats domain", () => {
    const r = resolveWeight(
      table({ "sender:a@x.com": 2, "stream:repo.github.com": 0.5, "domain:x.com": 0.3 }),
      keys,
    );
    expect(r.weight).toBe(2);
    expect(r.parts.filter((p) => p.applied && p.group === "identity")).toHaveLength(1);
  });
  it("prefers the specific stream over the general one", () => {
    const r = resolveWeight(
      table({ "stream:repo.github.com|ci_activity": 0.4, "stream:repo.github.com": 2 }),
      keys,
    );
    expect(r.weight).toBe(0.4);
  });
  it("multiplies content dimensions", () => {
    const r = resolveWeight(table({ "category:newsletter": 0.5, "kind:digest": 0.5 }), keys);
    expect(r.weight).toBeCloseTo(0.25);
  });
  it("combines identity with content and clamps", () => {
    const r = resolveWeight(table({ "sender:a@x.com": 0.2, "category:newsletter": 0.2 }), keys);
    expect(r.weight).toBe(0.2);
    const hi = resolveWeight(table({ "sender:a@x.com": 3, "category:newsletter": 3 }), keys);
    expect(hi.weight).toBe(3);
  });
});

const facets = (o: Partial<Classified> = {}): Classified => ({
  category: "promo",
  kind: "marketing",
  automated: 0.9,
  hasDeadline: 0.05,
  involvesMoney: 0.05,
  replyExpected: 0.05,
  confidence: 0.9,
  ...o,
});
const judged = (o: Partial<Judged> = {}): Judged => ({
  importance: 0.05,
  needsAction: 0.05,
  urgent: 0.02,
  confidence: 0.9,
  ...o,
});
const signals = (o: Partial<Signals> = {}): Signals => ({
  repliedBefore: false,
  toMe: false,
  bulk: true,
  threadJoined: false,
  ...o,
});
const input = (o: Partial<DecideInput> = {}): DecideInput => ({
  facets: facets(),
  judged: judged(),
  signals: signals(),
  weight: 1,
  protectedCategory: false,
  ...o,
});
const act = (o: Partial<DecideInput> = {}) => decide(input(o), DEFAULT_SETTINGS).action;

describe("decide", () => {
  it("archives very low attention", () => expect(act()).toBe("archive"));
  it("digests medium-low attention", () =>
    expect(act({ judged: judged({ importance: 0.45 }) })).toBe("digest"));
  it("keeps medium-high attention", () =>
    expect(act({ judged: judged({ importance: 0.75 }) })).toBe("keep"));
  it("alerts on urgent regardless of weight", () =>
    expect(act({ judged: judged({ urgent: 0.9 }), weight: 0.2 })).toBe("alert"));
  it("never hides protected categories", () => expect(act({ protectedCategory: true })).toBe("keep"));
  it("never hides mail from someone you've replied to", () =>
    expect(act({ signals: signals({ repliedBefore: true }) })).toBe("keep"));
  it("never hides a thread you joined", () =>
    expect(act({ signals: signals({ threadJoined: true }) })).toBe("keep"));
  it("keeps when action is needed", () =>
    expect(act({ judged: judged({ needsAction: 0.8 }) })).toBe("keep"));
  it("keeps deadline+money mail that expects a reply, even from a low-weight sender", () =>
    expect(
      act({ facets: facets({ hasDeadline: 0.9, replyExpected: 0.9 }), weight: 0.2 }),
    ).toBe("keep"));
  it("keeps when Jev is unsure", () =>
    expect(act({ judged: judged({ confidence: 0.2 }) })).toBe("keep"));
  it("a high weight lifts an email out of the digest", () =>
    expect(act({ judged: judged({ importance: 0.45 }), weight: 3 })).not.toBe("digest"));
  it("explains itself", () => {
    const d = decide(input({ weight: 0.5 }), DEFAULT_SETTINGS);
    expect(d.reasons.join(" ")).toContain("weight ×0.50");
  });
});

describe("headers", () => {
  it("builds specific-first stream keys", () => {
    expect(streamKeys({ "list-id": "Repo <o.r.github.com>", "x-github-reason": "review_requested" })).toEqual([
      "o.r.github.com|review_requested",
      "o.r.github.com",
    ]);
    expect(streamKeys({})).toEqual([]);
  });
  it("finds the alias a message was sent to", () => {
    expect(
      recipientAlias({ to: "Me <me+news@example.com>, x@y.com" }, "me@example.com"),
    ).toBe("me+news@example.com");
  });
});
