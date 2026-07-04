// Units for the opportunity-score explanation. Runs against the compiled dist/ (built by the `test` script first),
// mirroring the ranker's node:test convention. Imports through the package's public barrel (dist/index.js) so the
// export contract itself is exercised. Pure module — no network, never flakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explainOpportunityScore,
  summarizeOpportunityFactors,
  rankOpportunityScore,
  OPPORTUNITY_FACTOR_KEYS,
} from "../dist/index.js";

const full = { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 };

const closeTo = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);

test("barrel: the public entrypoint re-exports the explanation API", () => {
  assert.equal(typeof explainOpportunityScore, "function");
  assert.equal(typeof summarizeOpportunityFactors, "function");
  assert.deepEqual([...OPPORTUNITY_FACTOR_KEYS], ["potential", "feasibility", "laneFit", "freshness", "dupRisk"]);
});

test("explainOpportunityScore: score matches the ranker and the product of its contributions", () => {
  const input = { potential: 0.8, feasibility: 0.5, laneFit: 0.5, freshness: 0.5, dupRisk: 0.5 };
  const explanation = explainOpportunityScore(input);
  closeTo(explanation.score, rankOpportunityScore(input));
  closeTo(
    explanation.score,
    explanation.contributions.potential *
      explanation.contributions.feasibility *
      explanation.contributions.laneFit *
      explanation.contributions.freshness *
      explanation.contributions.dupRisk,
  );
});

test("explainOpportunityScore: dupRisk contributes 1 - risk, and names the smallest factor", () => {
  const explanation = explainOpportunityScore({ ...full, dupRisk: 0.9 });
  closeTo(explanation.contributions.dupRisk, 0.1);
  assert.equal(explanation.limitingFactor, "dupRisk");
});

test("explainOpportunityScore: a perfect candidate ties to the first factor and is viable", () => {
  const explanation = explainOpportunityScore(full);
  assert.equal(explanation.score, 1);
  assert.equal(explanation.limitingFactor, "potential");
  assert.equal(explanation.isViable, true);
});

test("explainOpportunityScore: a zero factor collapses the score and marks it non-viable", () => {
  const explanation = explainOpportunityScore({ ...full, laneFit: 0 });
  assert.equal(explanation.score, 0);
  assert.equal(explanation.limitingFactor, "laneFit");
  assert.equal(explanation.isViable, false);
});

test("summarizeOpportunityFactors: histogram, viable count, and most common bottleneck", () => {
  const summary = summarizeOpportunityFactors([
    { ...full, potential: 0.1 },
    { ...full, potential: 0.2 },
    { ...full, dupRisk: 0.9 },
    { ...full, laneFit: 0 },
  ]);
  assert.equal(summary.count, 4);
  assert.equal(summary.viableCount, 3);
  assert.deepEqual(summary.limitingFactorCounts, { potential: 2, feasibility: 0, laneFit: 1, freshness: 0, dupRisk: 1 });
  assert.equal(summary.mostCommonLimitingFactor, "potential");
});

test("summarizeOpportunityFactors: an empty list has no bottleneck", () => {
  const summary = summarizeOpportunityFactors([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.mostCommonLimitingFactor, null);
});
