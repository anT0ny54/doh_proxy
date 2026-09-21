import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/rate-limit.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { RateLimiter } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("allows up to the limit, then limits with a bounded Retry-After", () => {
  const limiter = new RateLimiter(3, 60_000, 100);
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.check("a", 1_000).limited, false);

  const blocked = limiter.check("a", 11_000);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.retryAfterSeconds, 50);
});

test("keys are independent and the window resets", () => {
  const limiter = new RateLimiter(1, 60_000, 100);
  assert.equal(limiter.check("a", 0).limited, false);
  assert.equal(limiter.check("a", 1).limited, true);
  assert.equal(limiter.check("b", 1).limited, false);
  assert.equal(limiter.check("a", 60_000).limited, false, "a new window starts after resetAt");
});

test("expired buckets are evicted", () => {
  const limiter = new RateLimiter(5, 1_000, 100);
  for (let i = 0; i < 10; i += 1) limiter.check(`k${i}`, 0);
  assert.equal(limiter.size, 10);
  limiter.check("fresh", 2_000);
  assert.equal(limiter.size, 1);
});

test("bucket count is hard-capped, evicting the oldest entries first", () => {
  const limiter = new RateLimiter(1, 60_000, 3);
  for (let i = 0; i < 50; i += 1) limiter.check(`spoofed-${i}`, i);
  assert.equal(limiter.size, 3);
  // The newest keys survive; the oldest was evicted and starts a fresh window.
  assert.equal(limiter.check("spoofed-49", 100).limited, true);
  assert.equal(limiter.check("spoofed-0", 100).limited, false);
});

test("a recreated bucket keeps insertion order aligned with resetAt", () => {
  const limiter = new RateLimiter(1, 1_000, 100);
  limiter.check("a", 0);
  limiter.check("b", 500);
  limiter.check("a", 1_000); // a expires and is recreated -> must now sort after b
  limiter.check("c", 1_500); // b expired at 1_500 and is evicted; a (resets 2_000) must stay
  assert.equal(limiter.size, 2);
  assert.equal(limiter.check("a", 1_600).limited, true);
});

test("clock rollback keeps eviction order monotonic", () => {
  const limiter = new RateLimiter(1, 1_000, 100);
  limiter.check("a", 0);
  limiter.check("b", 500);
  limiter.check("a", 1_000); // a expires and is recreated at resetAt=2_000

  // Wall-clock time rolls back. The next request must still use the last
  // observed timestamp so the new bucket starts at resetAt=2_000, not 1_500.
  limiter.check("c", 500);

  // At 1_600, b is expired. With monotonic time, c is still in-window and
  // therefore remains limited; without the fix c would have been recreated.
  assert.equal(limiter.check("c", 1_600).limited, true);
  assert.equal(limiter.size, 2);
});
