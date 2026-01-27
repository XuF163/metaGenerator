/**
 * Run async jobs with a simple concurrency limit.
 *
 * This avoids fully serial network operations (too slow) and avoids firing
 * thousands of parallel requests (rate limits / memory pressure).
 */

export async function runPromisePool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency))
  const running = new Set<Promise<void>>()

  for (const item of items) {
    const p = worker(item).finally(() => running.delete(p))
    running.add(p)
    if (running.size >= limit) {
      await Promise.race(running)
    }
  }

  await Promise.all(running)
}

