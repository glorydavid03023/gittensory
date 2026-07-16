// Shared trust-signal vocabulary (#6302), groundwork for #6208's reputation-bridge design.
//
// ORB (`src/review/submitter-reputation.ts`, whose `ReputationSignal` is `"trusted" | "neutral" | "low"`) and
// AMS (`track-record-summary.ts` / `prediction-ledger.js`) each carry their own internal notion of "how
// trustworthy is this contributor's history" with no shared vocabulary between them. This is a minimal,
// ADDITIVE type both can converge toward. It is DELIBERATELY not wired into any call site and does not change
// either system's internal representation — #6208 owns how a TrustSignal is populated, identity-linked, and
// consumed. Like both source systems, it carries no score/ranking internals, preserving their public-safe
// boundary.

/** Coarse trust levels, matching ORB's existing `ReputationSignal` buckets so the two systems align. */
export const TRUST_SIGNAL_LEVELS = ["low", "neutral", "trusted"] as const;

export type TrustSignalLevel = (typeof TRUST_SIGNAL_LEVELS)[number];

/** Which system a signal was derived from. */
export const TRUST_SIGNAL_SOURCES = ["orb-review-history", "ams-track-record"] as const;

export type TrustSignalSource = (typeof TRUST_SIGNAL_SOURCES)[number];

/**
 * A minimal, source-tagged trust signal derived from a contributor's public history — the shared vocabulary
 * #6208 can converge ORB's and AMS's internal representations toward, instead of inventing one mid-implementation.
 */
export type TrustSignal = {
  /** Coarse trust level; the same buckets ORB's `ReputationSignal` already emits. */
  level: TrustSignalLevel;
  /** How many public data points (PR outcomes / reviews) the level was derived from. */
  sampleSize: number;
  /** Which system produced this signal. */
  source: TrustSignalSource;
  /** ISO-8601 timestamp of the underlying data the signal reflects. */
  asOf: string;
};
