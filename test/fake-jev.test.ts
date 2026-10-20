import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../src/fake-data";
import { fakeJev } from "../src/fake-jev";
import { classify, DEFAULT_CATEGORIES, judge } from "../src/jev";
import { decide, DEFAULT_SETTINGS, resolveWeight } from "../src/policy";

async function run(s: (typeof SCENARIOS)[number], categories = DEFAULT_CATEGORIES, rules: string[] = []) {
  const mail = { from: s.from, subject: s.subject, snippet: s.body.slice(0, 100), body: s.body };
  const facets = await classify("k", mail, categories, undefined, fakeJev);
  const weight = resolveWeight(() => undefined, {
    sender: "x@y.com", streams: [], domain: "y.com", alias: null, category: facets.category, kind: facets.kind,
  }).weight;
  const signals = { repliedBefore: !!s.knownContact, toMe: true, bulk: false, threadJoined: false };
  const judged = await judge(
    "k",
    {
      ...mail,
      facets: { category: facets.category, kind: facets.kind, automated: facets.automated >= 0.5 },
      signals,
      weight,
      rules,
      taste_examples: [],
    },
    false,
    undefined,
    fakeJev,
  );
  const d = decide(
    {
      facets, judged, signals, weight,
      protectedCategory: !!categories.find((c) => c.name === facets.category)?.protected,
    },
    DEFAULT_SETTINGS,
  );
  return { facets, judged, d };
}

describe("fake Jev scenarios", () => {
  for (const s of SCENARIOS) {
    it(`${s.key} -> ${s.expect}`, async () => {
      const r = await run(s);
      expect(r.d.action, `${s.key}: ${r.facets.category}/${r.facets.kind} attn ${r.d.attention.toFixed(2)} [${r.d.reasons.join(", ")}]`).toBe(s.expect);
    });
  }

  it("covers every action", () => {
    expect(new Set(SCENARIOS.map((s) => s.expect))).toEqual(new Set(["alert", "keep", "digest", "archive"]));
  });

  it("is deterministic", async () => {
    const s = SCENARIOS[0]!;
    expect(JSON.stringify(await run(s))).toBe(JSON.stringify(await run(s)));
  });

  it("the school notice lands in 'other' with low confidence until a category exists", async () => {
    const school = SCENARIOS.find((s) => s.key === "school")!;
    const before = await run(school);
    expect(before.facets.category).toBe("other");
    expect(before.facets.confidence).toBeLessThan(0.5);
    expect(before.d.action).toBe("keep"); // never hidden while we're unsure what it is

    const cats = [
      ...DEFAULT_CATEGORIES,
      { name: "school", description: "Notices, forms and excursions from the kids' school", protected: false },
    ];
    const after = await run(school, cats);
    expect(after.facets.category).toBe("school");
    expect(after.facets.confidence).toBeGreaterThanOrEqual(0.5);
    expect(after.d.action).toBe("keep"); // a form that's due still needs action
  });

  it("a standing rule that matches the email lifts its importance", async () => {
    const promo = SCENARIOS.find((s) => s.key === "newsletter")!;
    const plain = await run(promo);
    const ruled = await run(promo, DEFAULT_CATEGORIES, ["Anything about Rust is interesting"]);
    expect(ruled.judged.importance).toBeGreaterThan(plain.judged.importance);
  });
});
