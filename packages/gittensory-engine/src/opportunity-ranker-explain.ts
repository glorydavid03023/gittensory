// Opportunity-score explanation. The ranker in `opportunity-ranker.ts` collapses five normalized signals into a
// single ordinal `rankOpportunityScore` product, which is exactly what a cross-repo candidate list needs to SORT
// by — but a bare score can't tell a miner WHY a candidate ranked low, so it can't tell "skip it, the work is
// already contested" from "skip it, it's stale" from "pursue it, it's just off-lane". This module explains a score
// without re-deriving it: it reuses the ranker's own `clamp01`/`clampRisk` so each factor's reported contribution is
// the exact multiplier the score was built from, then names the single limiting dimension.
//
// PURE — no IO, no Date, no random — matching the ranker and the house convention in src/signals/duplicate-winner.ts.
// Identical inputs always produce an identical explanation and an identical tie-break.

import { clamp01, clampRisk, rankOpportunityScore, type OpportunityRankInput } from "./opportunity-ranker.js";

/** The five ranked dimensions, in the fixed priority order used to break ties deterministically. A tie on the
 *  lowest (or the most common) contribution resolves to the factor listed FIRST here, so callers on any engine
 *  get one stable answer. `potential` first mirrors the field order in {@link OpportunityRankInput}. */
export const OPPORTUNITY_FACTOR_KEYS = ["potential", "feasibility", "laneFit", "freshness", "dupRisk"] as const;

export type OpportunityFactorKey = (typeof OPPORTUNITY_FACTOR_KEYS)[number];

/** A single candidate's score, broken down into the per-factor multipliers that composed it. */
export type OpportunityScoreExplanation = {
  /** The composed ordinal score — identical to {@link rankOpportunityScore} for the same input (pinned by test). */
  score: number;
  /** Each factor's EFFECTIVE multiplier in the product: the four positive factors clamped to [0, 1], and `dupRisk`
   *  expressed as its `1 - clampRisk(dupRisk)` contribution (so more contention reads as a SMALLER multiplier, the
   *  same direction as the other four). Their product is exactly {@link score}. */
  contributions: Record<OpportunityFactorKey, number>;
  /** The factor with the SMALLEST contribution — the dimension dragging the score down most, and the first thing a
   *  miner should weigh before spending effort. Ties resolve by {@link OPPORTUNITY_FACTOR_KEYS} order, so an
   *  all-equal input (including a perfect `1` across the board) deterministically reports `potential`. */
  limitingFactor: OpportunityFactorKey;
  /** Whether the opportunity is worth pursuing at all. The score is a product, so a single zero contribution (a
   *  positive factor at/below 0, a non-finite one, or `dupRisk >= 1`) collapses it to 0 — `isViable` is false in
   *  exactly those cases and true otherwise. */
  isViable: boolean;
};

/** The `1 - clampRisk(dupRisk)` contention contribution: a fully-contested or broken (`dupRisk >= 1` / non-finite)
 *  signal contributes 0, an uncontested one contributes 1 — same [0, 1] direction as the positive factors. */
function contentionContribution(dupRisk: number): number {
  return 1 - clampRisk(dupRisk);
}

function contributionsOf(input: OpportunityRankInput): Record<OpportunityFactorKey, number> {
  return {
    potential: clamp01(input.potential),
    feasibility: clamp01(input.feasibility),
    laneFit: clamp01(input.laneFit),
    freshness: clamp01(input.freshness),
    dupRisk: contentionContribution(input.dupRisk),
  };
}

/** The factor whose contribution is strictly the smallest; on a tie the earliest in {@link OPPORTUNITY_FACTOR_KEYS}
 *  wins, so the choice never depends on object key order or a non-stable comparison. */
function lowestContributionFactor(contributions: Record<OpportunityFactorKey, number>): OpportunityFactorKey {
  let limiting: OpportunityFactorKey = OPPORTUNITY_FACTOR_KEYS[0];
  for (const key of OPPORTUNITY_FACTOR_KEYS) {
    if (contributions[key] < contributions[limiting]) limiting = key;
  }
  return limiting;
}

/**
 * Explain one candidate's opportunity score: the same product {@link rankOpportunityScore} yields, plus the per-factor
 * multipliers it was built from and the single limiting dimension. Pure. The reported {@link OpportunityScoreExplanation.score}
 * is computed as the product of the reported contributions, so the breakdown is internally consistent by construction
 * and (because it reuses the ranker's own `clamp01`/`clampRisk`) equals `rankOpportunityScore(input)` — an invariant the
 * tests pin so the two can never silently diverge.
 */
export function explainOpportunityScore(input: OpportunityRankInput): OpportunityScoreExplanation {
  const contributions = contributionsOf(input);
  const score =
    contributions.potential *
    contributions.feasibility *
    contributions.laneFit *
    contributions.freshness *
    contributions.dupRisk;
  return {
    score,
    contributions,
    limitingFactor: lowestContributionFactor(contributions),
    isViable: score > 0,
  };
}

/** A pipeline-level rollup of the limiting factors across a whole candidate list. */
export type OpportunityFactorSummary = {
  /** Number of candidates summarized. */
  count: number;
  /** How many candidates are viable (score > 0). */
  viableCount: number;
  /** Histogram of which factor limited each candidate — every key present, zero-filled. Sums to {@link count}. */
  limitingFactorCounts: Record<OpportunityFactorKey, number>;
  /** The factor that limited the MOST candidates (ties broken by {@link OPPORTUNITY_FACTOR_KEYS} order), or `null`
   *  for an empty list. The systemic bottleneck a miner should address first — e.g. "most candidates are off-lane". */
  mostCommonLimitingFactor: OpportunityFactorKey | null;
};

function zeroedFactorCounts(): Record<OpportunityFactorKey, number> {
  return { potential: 0, feasibility: 0, laneFit: 0, freshness: 0, dupRisk: 0 };
}

/**
 * Summarize the limiting factors across a candidate list: how many are viable, a per-factor histogram of what limited
 * each one, and the single most common bottleneck. Pure; does not mutate the input. An empty list yields an all-zero
 * histogram and a `null` most-common factor (there is no bottleneck to report), never a spurious pick.
 */
export function summarizeOpportunityFactors(candidates: readonly OpportunityRankInput[]): OpportunityFactorSummary {
  const limitingFactorCounts = zeroedFactorCounts();
  let viableCount = 0;
  for (const candidate of candidates) {
    const explanation = explainOpportunityScore(candidate);
    limitingFactorCounts[explanation.limitingFactor] += 1;
    if (explanation.isViable) viableCount += 1;
  }
  return {
    count: candidates.length,
    viableCount,
    limitingFactorCounts,
    mostCommonLimitingFactor: candidates.length === 0 ? null : mostCommon(limitingFactorCounts),
  };
}

/** The factor with the highest count; ties resolve to the earliest in {@link OPPORTUNITY_FACTOR_KEYS}. Only called
 *  for a non-empty list, so the returned factor always reflects at least one candidate. */
function mostCommon(counts: Record<OpportunityFactorKey, number>): OpportunityFactorKey {
  let top: OpportunityFactorKey = OPPORTUNITY_FACTOR_KEYS[0];
  for (const key of OPPORTUNITY_FACTOR_KEYS) {
    if (counts[key] > counts[top]) top = key;
  }
  return top;
}
