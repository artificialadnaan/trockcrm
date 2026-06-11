/**
 * Bounded-concurrency worker pool, ported verbatim from the web
 * runConcurrentUploads. Never rejects — each item resolves to a settled result
 * so the caller can show a per-photo success/failure summary and retry only the
 * failures. Pure (no native imports) so it is unit-testable in isolation.
 */
export async function runConcurrentUploads<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    try {
      results[index] = { status: "fulfilled", value: await worker(items[index], index) };
    } catch (err) {
      results[index] = { status: "rejected", reason: err };
    }
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}
