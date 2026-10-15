import { test } from "node:test";
import assert from "node:assert/strict";
import { importSource } from "./lib/transpile-source.mjs";

const { RateLimiter } = await importSource("lib/rate-limit.ts");

test("allows up to the limit, then limits with a bounded Retry-After", () => {
  const limiter = new RateLimiter(3, 60_000, 100);
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.check("a", 1_000).limited, false);

  const blocked = limiter.check("a", 11_000);
  assert.equal(blocked.limited, true);
  // 49 s to the next window, plus 20 s until 3 * (1 - t/60) <= 2.
  assert.equal(blocked.retryAfterSeconds, 69);
});

test("keys are independent", () => {
  const limiter = new RateLimiter(1, 60_000, 100);
  assert.equal(limiter.check("a", 0).limited, false);
  assert.equal(limiter.check("a", 1).limited, true);
  assert.equal(limiter.check("b", 1).limited, false);
});

test("sliding window: no double burst across a window boundary", () => {
  const limiter = new RateLimiter(10, 60_000, 100);
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.check("a", 59_000).limited, false);
  // A fixed window would allow 10 more at 60_000; the previous window still
  // weighs ~98% here, so the client stays limited.
  assert.equal(limiter.check("a", 60_000).limited, true);
  // Halfway through the next window half of the previous count has decayed.
  let allowed = 0;
  for (let i = 0; i < 10; i += 1) if (!limiter.check("a", 90_000).limited) allowed += 1;
  assert.equal(allowed, 5);
  // Two windows later everything has decayed.
  assert.equal(limiter.check("a", 180_000).limited, false);
});

test("Retry-After is honest: retrying after it succeeds", () => {
  const limiter = new RateLimiter(5, 60_000, 100);
  for (let i = 0; i < 5; i += 1) limiter.check("a", 30_000);
  const blocked = limiter.check("a", 40_000);
  assert.equal(blocked.limited, true);
  assert.equal(limiter.check("a", 40_000 + blocked.retryAfterSeconds * 1_000 - 2_000).limited, true);
  assert.equal(limiter.check("a", 40_000 + blocked.retryAfterSeconds * 1_000).limited, false);
});

test("stale buckets are evicted", () => {
  const limiter = new RateLimiter(5, 1_000, 100);
  for (let i = 0; i < 10; i += 1) limiter.check(`k${i}`, 0);
  assert.equal(limiter.size, 10);
  limiter.check("fresh", 1_500); // previous window: still relevant
  assert.equal(limiter.size, 11);
  limiter.check("fresh", 2_000); // two windows on: k* no longer count
  assert.equal(limiter.size, 1);
});

test("bucket count is hard-capped, evicting the oldest entries first", () => {
  const limiter = new RateLimiter(1, 60_000, 3);
  for (let i = 0; i < 50; i += 1) limiter.check(`spoofed-${i}`, i);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.check("spoofed-49", 100).limited, true);
  assert.equal(limiter.check("spoofed-0", 100).limited, false);
});

test("a bucket moved to a new window keeps insertion order aligned with windowStart", () => {
  const limiter = new RateLimiter(1, 1_000, 100);
  limiter.check("a", 0);
  limiter.check("b", 500);
  limiter.check("a", 1_000); // a rolls into window 1 and moves behind b
  limiter.check("c", 2_000); // window 0 is now stale: b is evicted, a (window 1) stays
  assert.equal(limiter.size, 2);
  assert.equal(limiter.check("c", 2_100).limited, true);
});

test("clock rollback keeps the effective clock monotonic", () => {
  const limiter = new RateLimiter(1, 1_000, 100);
  limiter.check("a", 5_000);
  // Wall-clock time rolls back; the limiter must keep using 5_000, so "a" is
  // still inside its window and stays limited.
  assert.equal(limiter.check("a", 1_000).limited, true);
  limiter.check("b", 1_000);
  assert.equal(limiter.size, 2);
});
