/**
 * Fixed-window, in-process rate limiter used by the root `proxy.ts`.
 *
 * Buckets live in a `Map`, whose iteration order is insertion order. Every
 * bucket is (re)inserted at the moment its window starts, so the Map is ordered
 * by `resetAt` while the effective clock is monotonic. That lets expired
 * buckets be dropped from the front in amortised O(1) per request (no full
 * scan) and gives a cheap "evict oldest" when the hard size cap is reached,
 * which keeps memory bounded even if a client rotates spoofed identifiers.
 *
 * `check()` clamps backwards clock movement to the last observed timestamp
 * because `Date.now()` is wall-clock time and can move backwards after clock
 * or NTP adjustments.
 */

export const WINDOW_SIZE_MS = 60_000;
export const WINDOW_LIMIT = 100;
export const MAX_BUCKETS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  readonly limited: boolean;
  /** Whole seconds until the current window ends (0 when not limited). */
  readonly retryAfterSeconds: number;
}

const ALLOWED: RateLimitResult = { limited: false, retryAfterSeconds: 0 };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  // Date.now() can move backwards after clock/NTP adjustments. Keep the
  // effective clock monotonic so Map insertion order continues to match
  // resetAt ordering.
  private lastNow = Number.NEGATIVE_INFINITY;

  constructor(limit = WINDOW_LIMIT, windowMs = WINDOW_SIZE_MS, maxBuckets = MAX_BUCKETS) {
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
    this.evictExpired(effectiveNow);

    const current = this.buckets.get(key);
    if (!current || current.resetAt <= effectiveNow) {
      // Delete first so the re-created bucket moves to the end of the Map and
      // insertion order keeps matching `resetAt` order.
      this.buckets.delete(key);
      this.evictOldestWhileFull();
      this.buckets.set(key, { count: 1, resetAt: effectiveNow + this.windowMs });
      return ALLOWED;
    }

    current.count += 1;
    if (current.count <= this.limit) return ALLOWED;

    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - effectiveNow) / 1_000)),
    };
  }

  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt > now) break;
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
