# Changelog

## [Unreleased]

Two runtime bugs fixed in `src/`, one unreferenced code path removed, tests and
documentation updated. Found in a third full read of the repository (every
source, test, workflow, configuration and documentation file, except that
`package-lock.json` was checked structurally and against `package.json` rather
than line by line and `LICENSE`, the standard AGPL-3.0 text, was only skimmed).
Dead-code, conflict and optimization checks are listed under "Review notes".

### Fixed
- **The rate limiter could stall for as long as a clock step lasted.**
  `src/proxy.ts` fed `Date.now()` to the limiter, whose clamp only handles a
  clock that moves *backwards*. After a forward step (an NTP correction, a VM
  resume) followed by the clock being corrected back, the effective clock stayed
  at the stepped value, so no window rolled over and every client was stuck at
  its current budget until real time caught up. Reproduced with the unmodified
  limiter: after a +1 h step and correction, a client with a limit of 5/min got
  4 requests in the next 30 real minutes instead of about 150. `proxy.ts` now
  passes `Math.floor(performance.now())`, a monotonic clock, so wall-clock steps
  in either direction have no effect. Windows are aligned to process start
  instead of the epoch; nothing depended on epoch alignment, and `Retry-After`
  is unaffected. The doc comment of `RateLimiter` now says that callers must
  pass a monotonic clock and why the clamp alone is not enough.
- **`NEXT_PUBLIC_SITE_URL` with an upper- or mixed-case scheme produced a wrong
  origin.** `toOrigin()` in `src/lib/site.ts` only recognized a lower-case
  `http://` / `https://` prefix, so `HTTPS://dns.example.com` was treated as a
  bare host and became `https://https` in the homepage endpoint, the canonical
  URL and the Open Graph URL. For the same reason `ftp://dns.example.com` became
  `https://ftp` instead of being rejected. Any explicit `scheme://` is now
  parsed as written (and non-http(s) schemes are ignored, as the code already
  intended); only a value without a scheme gets `https://`. `host:port` is still
  treated as a bare host.

### Removed
- The CLI entry point of `scripts/lib/mock-upstream.mjs` (`node
  scripts/lib/mock-upstream.mjs <port>`) and its `pathToFileURL` import. Nothing
  referenced it any more: the Docker smoke test and the integration suite import
  `startMockUpstream()` directly. The function is unchanged.

### Changed
- Tests: 104 -> 106 unit tests. `test-proxy.mjs` gains a regression test that
  steps the wall clock two hours forward and back while the limiter is
  exhausted (the verdict must not change) and then advances the monotonic clock
  (the budget must return). `test-config.mjs` gains a test for
  `NEXT_PUBLIC_SITE_URL` parsing (mixed-case scheme, bare host, `host:port`,
  `ftp://`, blank, path and query dropped). Both fail against the previous
  source and pass now.
- README: the limiter's clock source, the accepted forms of
  `NEXT_PUBLIC_SITE_URL`, the two new checklist lines and the updated test
  descriptions.

### Review notes
- Run in this review: the 106 unit tests (all pass), an unused-symbol check
  (`tsc --noUnusedLocals --noUnusedParameters`) over `src/lib` and, with
  `checkJs`, over `scripts/` and `server/` (nothing unused), and a
  reproduction of both bugs before the fix. Not run, because the review
  environment had neither network access nor the project's dependencies:
  `npm run lint`, `npm run typecheck`, `npm run build`, the integration suite
  and the Docker build and smoke test. Run those before releasing; the two
  `src/` edits are small and use only `performance.now()` and a regular
  expression.
- Dead or redundant code: only the mock-upstream CLI above. The remaining
  exports that no other `src/` module imports are consumed by the tests
  (`normalizeIp`, `parseTrust`, `loadConfig`, `PROXY_VERSION`,
  `getHageziUpstreams`, the in-flight constants, `RateLimiter#size`) and the
  `timeoutMs` option of `proxyRequest()` is set only by tests; all are
  deliberate seams. Defensive branches that cannot run in production and are
  kept on purpose: the `404` in `handleDoH()` (the router answers first) and the
  oversized-input allocation in `compressionTargets()` (responses are capped at
  65535 bytes before validation).
- Conflicts: none between `README.md`, `package.json`, `Dockerfile`, the
  workflows, `next.config.ts` and the code. Checked in particular the default
  values and clamps of every environment variable, the Keep-Alive schedule, the
  published image tags, the 4097-byte body cap in `next.config.ts` and the
  preload, the `maxDuration` versus `DEFAULT_TIMEOUT_MS` relation, and the
  test counts quoted in the earlier entry (104 unit, 16 integration).
- Optimization: nothing worth changing. The hot path already avoids per-request
  URL parsing, rotation-list allocation and per-message scratch allocation.
  Building the fixed `Accept`/`User-Agent` `Headers` once instead of per
  attempt would save about 1 microsecond per upstream call (measured), which is
  negligible next to the network round trip; not done.
- Left alone, by design and already documented in the README: a single shared
  limiter bucket when no client address exists (`TRUST_PROXY_HEADERS=0` on a
  platform without the preload); eviction of the oldest bucket once 10,000 keys
  are tracked, which a client rotating /64 prefixes can use to push out others;
  relaying an upstream `400`/`413`/`414`/`415` without failover, which lets one
  misconfigured upstream fail requests for everyone; and `200` bodies that fail
  validation not counting toward the circuit breaker, since a crafted query can
  provoke them. One behavior was undocumented and is now described in the
  README without changing it: an IPv4-mapped IPv6 CIDR in `TRUSTED_PROXIES`
  with a prefix above 32 (for example `::ffff:10.0.0.0/104`) is silently
  ignored, because the address collapses to IPv4 and the prefix no longer fits
  (verified; a mapped single address such as `::ffff:10.1.2.3` does work).
  Write the range as `10.0.0.0/8`.

