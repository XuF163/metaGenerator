/**
 * Simple async concurrency limiter.
 *
 * We use this to enforce provider constraints like "no concurrent requests"
 * for some free-tier models.
 */

export class AsyncQueue {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`[meta-gen] AsyncQueue maxConcurrency must be >= 1 (got ${maxConcurrency})`)
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active++
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    next?.()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

