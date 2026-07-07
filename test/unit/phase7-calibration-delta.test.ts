import { describe, expect, it } from "vitest";
import {
  computePhase7CalibrationLoop,
  renderPhase7CalibrationAuditMarkdown,
  resolvePhase7CalibrationConfig,
  DOCUMENTED_CALIBRATION_BASELINE,
} from "../../packages/gittensory-engine/src/phase7-calibration-loop";

const NOW = "2026-07-04T18:00:00.000Z";
const FRESH_REPLAY_AT = "2026-07-04T12:00:00.000Z";

function enabledConfig() {
  return resolvePhase7CalibrationConfig({
    miner: {
      calibration: {
        phase7LoopEnabled: true,
        autonomyIncreaseMinAccuracy: 0.7,
        replayFreshnessMaxAgeHours: 168,
        historicalReplayWeight: 0.5,
        prOutcomeWeight: 0.5,
      },
    },
  });
}

// decided=20; correct=round(20*accuracy) → an exact 0.5 / 0.62 / above-baseline accuracy for the pr_outcome source.
function prOutcome(accuracy: number) {
  const decided = 20;
  const correct = Math.round(decided * accuracy);
  return { mergeConfirmed: correct, mergeFalse: decided - correct, closeConfirmed: 0, closeFalse: 0, observedAt: NOW };
}

function healthyReplay(compositeScore: number) {
  return { compositeScore, replayRunId: "replay-1", observedAt: FRESH_REPLAY_AT, harnessStatus: "healthy" as const };
}

function loopWith(prAccuracy: number, replayAccuracy: number = prAccuracy) {
  return computePhase7CalibrationLoop({
    config: enabledConfig(),
    prOutcome: prOutcome(prAccuracy),
    historicalReplay: healthyReplay(replayAccuracy),
    now: NOW,
  });
}

describe("phase 7 calibration deltaFromBaseline sign", () => {
  it("reports a NEGATIVE deviation when combined accuracy is below the documented baseline", () => {
    // Both sources at 0.5 → combined 0.5, which is 0.12 below the 0.62 baseline. The delta is a signed deviation,
    // so a below-baseline regression must surface as -0.12, not be clamped to 0 (which would hide the regression).
    const result = loopWith(0.5);
    expect(result.combinedAccuracy).toBe(0.5);
    expect(result.deltaFromBaseline).toBe(-0.12);
    expect(renderPhase7CalibrationAuditMarkdown(result)).toContain("delta from baseline: -12.00 percentage points");
  });

  it("reports a POSITIVE deviation when combined accuracy is above the baseline", () => {
    // Both sources at 0.75 → combined 0.75, 0.13 above baseline; the above-baseline path was already correct.
    const result = loopWith(0.75);
    expect(result.combinedAccuracy).toBe(0.75);
    expect(result.deltaFromBaseline).toBe(0.13);
  });

  it("reports a ZERO deviation exactly at the baseline", () => {
    // pr_outcome 0.6 + replay 0.64 average to combined 0.62 === baseline → delta 0 (a genuine zero, distinct from
    // a below-baseline value the old clamp would have flattened to 0).
    const result = loopWith(0.6, 0.64);
    expect(result.combinedAccuracy).toBe(DOCUMENTED_CALIBRATION_BASELINE);
    expect(result.deltaFromBaseline).toBe(0);
  });
});
