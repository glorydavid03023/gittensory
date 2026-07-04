import { describe, expect, it } from "vitest";
import { rankOpportunityScore, type OpportunityRankInput } from "../../packages/gittensory-engine/src/opportunity-ranker";
import {
  explainOpportunityScore,
  summarizeOpportunityFactors,
  OPPORTUNITY_FACTOR_KEYS,
  type OpportunityFactorKey,
} from "../../packages/gittensory-engine/src/opportunity-ranker-explain";

// A neutral, all-passing candidate (every factor 1, no contention → score 1); tests override one field at a time,
// mirroring the helper in opportunity-ranker.test.ts.
function input(over: Partial<OpportunityRankInput> = {}): OpportunityRankInput {
  return { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0, ...over };
}

describe("explainOpportunityScore", () => {
  it("reports each factor's effective contribution, with dupRisk as its 1 - risk multiplier", () => {
    expect(explainOpportunityScore(input()).contributions).toEqual({
      potential: 1,
      feasibility: 1,
      laneFit: 1,
      freshness: 1,
      dupRisk: 1,
    });
    expect(explainOpportunityScore(input({ potential: 0.5, dupRisk: 0.25 })).contributions).toEqual({
      potential: 0.5,
      feasibility: 1,
      laneFit: 1,
      freshness: 1,
      dupRisk: 0.75,
    });
  });

  // The whole point of the explanation is that it never drifts from the score it explains: the reported
  // contributions multiply back to `score`, and that `score` equals the authoritative ranker for the same input.
  const PARITY_CASES: OpportunityRankInput[] = [
    input(),
    input({ potential: 0.5 }),
    input({ dupRisk: 0.5 }),
    input({ potential: 0.8, feasibility: 0.5, laneFit: 0.5, freshness: 0.5, dupRisk: 0.5 }),
    input({ freshness: 0.25, dupRisk: 0.2 }),
    input({ laneFit: 0 }),
    input({ dupRisk: 1 }),
    input({ potential: 2, feasibility: 2 }), // clamps
    input({ potential: -1 }),
    input({ freshness: NaN }),
    input({ dupRisk: Infinity }),
    input({ dupRisk: -5 }),
    input({ potential: 0.9, feasibility: 0.9, laneFit: 0.9, freshness: 0.9, dupRisk: 0.1 }),
  ];

  it.each(PARITY_CASES)("score equals rankOpportunityScore and the product of its own contributions (%#)", (value) => {
    const explanation = explainOpportunityScore(value);
    const product =
      explanation.contributions.potential *
      explanation.contributions.feasibility *
      explanation.contributions.laneFit *
      explanation.contributions.freshness *
      explanation.contributions.dupRisk;
    expect(explanation.score).toBeCloseTo(rankOpportunityScore(value), 12);
    expect(explanation.score).toBeCloseTo(product, 12);
  });

  it.each(["potential", "feasibility", "laneFit", "freshness"] as const)(
    "names %s as the limiting factor when it is the single smallest contribution",
    (factor) => {
      expect(explainOpportunityScore(input({ [factor]: 0.1 })).limitingFactor).toBe(factor);
    },
  );

  it("names dupRisk as the limiting factor when contention is the smallest contribution", () => {
    // dupRisk 0.9 → contribution 0.1, below every positive factor at 1.
    expect(explainOpportunityScore(input({ dupRisk: 0.9 })).limitingFactor).toBe("dupRisk");
  });

  it("breaks a contribution tie by OPPORTUNITY_FACTOR_KEYS order (earliest wins)", () => {
    // All contributions equal 1 → the first key, potential, is reported deterministically.
    expect(explainOpportunityScore(input()).limitingFactor).toBe("potential");
    // potential and dupRisk both contribute 0.5; potential precedes dupRisk in the key order.
    expect(explainOpportunityScore(input({ potential: 0.5, dupRisk: 0.5 })).limitingFactor).toBe("potential");
    // feasibility and laneFit both contribute 0.3; feasibility precedes laneFit.
    expect(explainOpportunityScore(input({ feasibility: 0.3, laneFit: 0.3 })).limitingFactor).toBe("feasibility");
  });

  it("clamps and fails closed inside the contributions, matching the ranker", () => {
    expect(explainOpportunityScore(input({ potential: 1.5 })).contributions.potential).toBe(1);
    expect(explainOpportunityScore(input({ potential: -0.5 })).contributions.potential).toBe(0);
    expect(explainOpportunityScore(input({ freshness: NaN })).contributions.freshness).toBe(0);
    expect(explainOpportunityScore(input({ dupRisk: -0.1 })).contributions.dupRisk).toBe(1); // 1 - 0
    expect(explainOpportunityScore(input({ dupRisk: 1.4 })).contributions.dupRisk).toBe(0); // 1 - 1
    expect(explainOpportunityScore(input({ dupRisk: NaN })).contributions.dupRisk).toBe(0); // fails closed to 1 risk
  });

  it("marks a candidate viable only when its score is above 0", () => {
    expect(explainOpportunityScore(input()).isViable).toBe(true);
    expect(explainOpportunityScore(input({ potential: 0.5, freshness: 0.5 })).isViable).toBe(true);
    expect(explainOpportunityScore(input({ laneFit: 0 })).isViable).toBe(false); // a zero factor collapses the product
    expect(explainOpportunityScore(input({ dupRisk: 1 })).isViable).toBe(false); // full contention collapses it
    expect(explainOpportunityScore(input({ freshness: NaN })).isViable).toBe(false); // non-finite degrades to 0
  });

  it("exposes the five factor keys in fixed priority order", () => {
    expect(OPPORTUNITY_FACTOR_KEYS).toEqual(["potential", "feasibility", "laneFit", "freshness", "dupRisk"]);
  });

  it("does not mutate its input", () => {
    const value = input({ potential: 0.5, dupRisk: 0.25 });
    const snapshot = structuredClone(value);
    explainOpportunityScore(value);
    expect(value).toEqual(snapshot);
  });
});

describe("summarizeOpportunityFactors", () => {
  it("rolls up viability, a per-factor histogram, and the most common bottleneck", () => {
    const summary = summarizeOpportunityFactors([
      input({ potential: 0.1 }), // limiting potential, viable
      input({ potential: 0.2 }), // limiting potential, viable
      input({ dupRisk: 0.9 }), // limiting dupRisk, viable (0.1)
      input({ laneFit: 0 }), // limiting laneFit, NOT viable (score 0)
    ]);
    expect(summary.count).toBe(4);
    expect(summary.viableCount).toBe(3);
    expect(summary.limitingFactorCounts).toEqual({ potential: 2, feasibility: 0, laneFit: 1, freshness: 0, dupRisk: 1 });
    expect(summary.mostCommonLimitingFactor).toBe("potential");
  });

  it("breaks a most-common tie by OPPORTUNITY_FACTOR_KEYS order", () => {
    const summary = summarizeOpportunityFactors([input({ potential: 0.1 }), input({ dupRisk: 0.1 })]);
    expect(summary.limitingFactorCounts.potential).toBe(1);
    expect(summary.limitingFactorCounts.dupRisk).toBe(1);
    expect(summary.mostCommonLimitingFactor).toBe("potential"); // potential precedes dupRisk
  });

  it("reports a non-first factor as the bottleneck when it limits the most candidates", () => {
    // Every candidate is limited by dupRisk (the LAST key), so the winner must be found by advancing past the
    // zero-count leading factors — exercising the update path, not just the initial pick.
    const summary = summarizeOpportunityFactors([input({ dupRisk: 0.9 }), input({ dupRisk: 0.8 }), input({ dupRisk: 0.5 })]);
    expect(summary.limitingFactorCounts).toEqual({ potential: 0, feasibility: 0, laneFit: 0, freshness: 0, dupRisk: 3 });
    expect(summary.mostCommonLimitingFactor).toBe("dupRisk");
  });

  it("returns a zeroed histogram and a null bottleneck for an empty list", () => {
    const summary = summarizeOpportunityFactors([]);
    expect(summary.count).toBe(0);
    expect(summary.viableCount).toBe(0);
    expect(summary.limitingFactorCounts).toEqual({ potential: 0, feasibility: 0, laneFit: 0, freshness: 0, dupRisk: 0 });
    expect(summary.mostCommonLimitingFactor).toBeNull();
  });

  it("counts every candidate as non-viable when none clear a zero factor", () => {
    const summary = summarizeOpportunityFactors([input({ potential: 0 }), input({ dupRisk: 1 })]);
    expect(summary.viableCount).toBe(0);
    expect(summary.count).toBe(2);
  });

  it("does not mutate the input array or its elements", () => {
    const candidates = [input({ potential: 0.5 }), input({ laneFit: 0.25 })];
    const snapshot = structuredClone(candidates);
    summarizeOpportunityFactors(candidates);
    expect(candidates).toEqual(snapshot);
  });

  it("keeps the histogram keys exhaustive over the factor set", () => {
    const summary = summarizeOpportunityFactors([input()]);
    expect(Object.keys(summary.limitingFactorCounts).sort()).toEqual([...OPPORTUNITY_FACTOR_KEYS].sort());
    const factorKey: OpportunityFactorKey = "freshness";
    expect(summary.limitingFactorCounts[factorKey]).toBe(0);
  });
});
