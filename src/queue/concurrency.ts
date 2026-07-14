// Bounded fan-out helper, shared by the queue modules (#5835). It lived in processors.ts, but
// duplicate-detection.ts needs it too and deliberately does not import processors.ts -- that file's own header
// records why: importing back would make the two circularly dependent (it inlines an admission-key wrapper for
// exactly the same reason). A neutral module both can depend on is the way to share this without reintroducing
// the cycle, rather than growing a third private copy of the same worker-pool loop.

/**
 * Map `items` through `mapper` with at most `concurrency` in flight at once, preserving input order in the
 * result. Unlike `Promise.all(items.map(...))`, the number of simultaneously-running mappers never exceeds
 * `concurrency` -- which is what keeps a large input from bursting that many concurrent GitHub REST calls out
 * of a single webhook delivery and draining the installation's shared rate-limit bucket.
 *
 * A `concurrency` below 1 is clamped to 1 (never zero workers, which would hang), and never exceeds the item
 * count (no idle workers). An empty input resolves immediately to an empty array.
 */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );
  return results;
}
