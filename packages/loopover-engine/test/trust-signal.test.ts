import { test } from "node:test";
import assert from "node:assert/strict";

import { TRUST_SIGNAL_LEVELS, TRUST_SIGNAL_SOURCES, type TrustSignal } from "../dist/index.js";

test("barrel: exports the shared TrustSignal level/source constants (#6302)", () => {
  assert.deepEqual([...TRUST_SIGNAL_LEVELS], ["low", "neutral", "trusted"]);
  assert.deepEqual([...TRUST_SIGNAL_SOURCES], ["orb-review-history", "ams-track-record"]);
});

test("TrustSignal admits a well-formed source-tagged signal from either system (#6302)", () => {
  const fromAms: TrustSignal = { level: "trusted", sampleSize: 12, source: "ams-track-record", asOf: "2026-07-16T00:00:00.000Z" };
  const fromOrb: TrustSignal = { level: "low", sampleSize: 3, source: "orb-review-history", asOf: "2026-07-16T00:00:00.000Z" };
  for (const signal of [fromAms, fromOrb]) {
    assert.equal(TRUST_SIGNAL_LEVELS.includes(signal.level), true);
    assert.equal(TRUST_SIGNAL_SOURCES.includes(signal.source), true);
    assert.equal(typeof signal.sampleSize, "number");
    assert.equal(typeof signal.asOf, "string");
  }
});
