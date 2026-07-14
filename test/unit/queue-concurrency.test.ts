import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../src/queue/concurrency";

/** Runs `mapper` over `items` while recording the peak number of simultaneously in-flight mappers. */
async function withPeakInFlight<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>) {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, concurrency, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await work(item);
    } finally {
      inFlight -= 1;
    }
  });
  return { results, peak };
}

/** Resolves on a later microtask turn, so overlapping mappers actually interleave. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mapWithConcurrency() (#5835)", () => {
  it("never runs more than `concurrency` mappers at once", async () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const { results, peak } = await withPeakInFlight(items, 4, async (item) => {
      await tick();
      return item * 2;
    });
    expect(peak).toBeLessThanOrEqual(4);
    // ...and it really does run them concurrently, rather than trivially serialising.
    expect(peak).toBe(4);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  it("preserves input order in the result even when mappers finish out of order", async () => {
    // The first item resolves LAST, so an order-preserving implementation cannot just push as results arrive.
    const { results } = await withPeakInFlight([0, 1, 2, 3], 4, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 5 : 0));
      return `item-${item}`;
    });
    expect(results).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  it("never spawns more workers than there are items", async () => {
    const { peak, results } = await withPeakInFlight([1, 2], 10, async (item) => {
      await tick();
      return item;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([1, 2]);
  });

  it("resolves to an empty array on empty input, without hanging or calling the mapper", async () => {
    // `items.length || 1` keeps the worker count at 1 rather than 0 here -- a zero-worker pool would resolve
    // Promise.all([]) immediately, which is fine, but the guard also protects the `concurrency <= 0` case below.
    let called = 0;
    const results = await mapWithConcurrency<number, number>([], 5, async (item) => {
      called += 1;
      return item;
    });
    expect(results).toEqual([]);
    expect(called).toBe(0);
  });

  it("clamps a zero/negative concurrency to a single worker instead of hanging forever", async () => {
    // Math.max(1, ...) is load-bearing: 0 workers would never drain the queue and the promise would never settle.
    for (const concurrency of [0, -3]) {
      const { results, peak } = await withPeakInFlight([1, 2, 3], concurrency, async (item) => {
        await tick();
        return item;
      });
      expect(peak).toBe(1);
      expect(results).toEqual([1, 2, 3]);
    }
  });

  it("propagates a mapper rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
