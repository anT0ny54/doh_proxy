/**
 * Sliding-window-counter rate limiter used by `src/proxy.ts`.
 *
 * Each key keeps the count of the current fixed window and of the previous
 * one; the previous count is weighted by how much of it still overlaps the
 * rolling window. That removes the 2x burst a plain fixed window allows
 * around window boundaries, at the same O(1) cost.
 *
 * Windows are aligned to multiples of the window length on the clock the
 * caller supplies, and a bucket is (re)inserted into the Map whenever it moves
 * to a new window, so Map insertion order matches `windowStart` order while the
 * effective clock is monotonic. Stale buckets are therefore dropped from the
 * front in amortised O(1), and the hard size cap evicts the oldest bucket
 * first, keeping memory bounded even if a client rotates identifiers.
 *
 * Callers should pass a monotonic clock (`src/proxy.ts` uses
 * `performance.now()`). As a safety net `check()` clamps backwards movement to
 * the last observed timestamp, but it cannot undo a forward step: with a
 * wall-clock source such as `Date.now()`, a +1 h NTP step followed by a
 * correction would freeze every window for an hour.
 */

const WINDOW_SIZE_MS = 60_000;
const MAX_BUCKETS = 10_000;

interface Bucket {
  windowStart: number;
  current: number;
  previous: number;
}

export interface RateLimitResult {
  readonly limited: boolean;
  /** Whole seconds until a request would be allowed again (0 when not limited). */
  readonly retryAfterSeconds: number;
}

const ALLOWED: RateLimitResult = { limited: false, retryAfterSeconds: 0 };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private lastNow = Number.NEGATIVE_INFINITY;

  constructor(limit: number, windowMs = WINDOW_SIZE_MS, maxBuckets = MAX_BUCKETS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
  }

  /** Number of tracked buckets (exposed for tests/diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  check(key: string, now: number): RateLimitResult {
    const effectiveNow = Math.max(now, this.lastNow);
    this.lastNow = effectiveNow;
    const windowStart = effectiveNow - (effectiveNow % this.windowMs);
    this.evictStale(windowStart);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      this.evictOldestWhileFull();
      bucket = { windowStart, current: 0, previous: 0 };
      this.buckets.set(key, bucket);
    } else if (bucket.windowStart !== windowStart) {
      // evictStale() keeps only current- or previous-window buckets, so this
      // bucket's count becomes the previous one. Re-insert to keep order.
      this.buckets.delete(key);
      bucket = { windowStart, current: 0, previous: bucket.current };
      this.buckets.set(key, bucket);
    }

    const elapsed = effectiveNow - windowStart;
    const estimate = bucket.previous * (1 - elapsed / this.windowMs) + bucket.current;
    if (estimate + 1 <= this.limit) {
      bucket.current += 1;
      return ALLOWED;
    }
    return { limited: true, retryAfterSeconds: this.retryAfterSeconds(bucket, elapsed) };
  }

  /** Time until `previous * weight + current + 1 <= limit` holds again. */
  private retryAfterSeconds(bucket: Bucket, elapsed: number): number {
    const headroom = this.limit - 1;
    let waitMs: number;
    if (bucket.current <= headroom && bucket.previous > 0) {
      // Enough decay of the previous window inside the current one.
      waitMs = this.windowMs * (1 - (headroom - bucket.current) / bucket.previous) - elapsed;
    } else {
      // Only the next window helps: the current count then decays instead.
      const intoNext = bucket.current > 0 ? Math.max(0, this.windowMs * (1 - headroom / bucket.current)) : 0;
      waitMs = this.windowMs - elapsed + intoNext;
    }
    return Math.max(1, Math.ceil(waitMs / 1_000));
  }

  /** Drops buckets older than the previous window; they no longer count. */
  private evictStale(windowStart: number): void {
    const oldestRelevant = windowStart - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart >= oldestRelevant) break;
      this.buckets.delete(key);
    }
  }

  private evictOldestWhileFull(): void {
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }
}
