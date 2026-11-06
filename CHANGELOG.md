# Changelog

## [2.11.0] - 2026-11-06

The version is unchanged. The entry below is the latest modified log for this
release, followed by the 2.11.0 release notes.

### Modified

#### Fixed
- DNS response validation: compressed names were accepted in DNAME and KX
  RDATA even though RFC 6672 requires an uncompressed DNAME target and RFC
  2230 prohibits compression in KX RDATA. Both record types now require
  uncompressed names; regression tests cover bare pointers and pointer suffixes.
- DNS response validation: added the legacy SIG signer-name and NXT
  next-domain-name layouts. RFC 3597 also recommends decompressing these names
  when processing existing records, so valid later pointers into them are now
  accepted rather than rejected as references into opaque RDATA.
- `TRUSTED_PROXIES`: an entry that names an `Object.prototype` property (for
  example `constructor`, `toString`, `__proto__`) was resolved as a named range
  and made every request that reached the trust check fail with a `TypeError`.
  Named ranges are now looked up in a `Map`; such entries are ignored.
- `HAGEZI_UPSTREAM_ENDPOINTS`: an entry ending in a bare `?` produced a GET
  target of `...dns-query??dns=...`. The separator is now added once, and the
  POST target no longer carries the dangling `?`.
- `server/socket-ip-preload.cjs`: an explicit `null` timeout was silently
  replaced by the default, contrary to the file's comment and to Node, which
  rejects `null`. `null` now reaches Node unchanged. The headers-timeout clamp
  applies only to numbers, so `null` cannot turn it into `0`.
- Cache relay: a present but malformed upstream `Age` (for example `1e9`, `-1`,
  `12 34`) was treated as zero and the full `max-age` was relayed. Such answers
  are now not cached (`Cache-Control: no-store, max-age=0`).
- Cache relay: valid upstream `max-age` values longer than nine digits were
  ignored, and large `max-age`/`Age` pairs could lose precision. Decimal values
  are now compared with exact integer arithmetic and the relayed lifetime is
  capped at 300 seconds.
- Circuit-breaker documentation: the README stated that late results from older
  non-probe requests never restart a cooldown or close the breaker. The code
  applies that protection only while a half-open probe is active. The README now
  states the rule as implemented.
- `scripts/test-integration.mjs`: when one of the five servers failed to start,
  the others were left running. All started servers are stopped first. A server
  that has already exited is no longer waited for during teardown (that wait
  burned the full 10-second timeout).

#### Changed
- All DoH answers and the rate limiter's `429` share one header policy, from
  `noStoreCorsHeaders()` in `src/lib/cors.ts`. The `429` `Cache-Control` value is
  now `no-store, max-age=0` (it was `no-store`); DoH answers already sent that
  value. Both mean "do not cache".

#### Removed (no behavior change)
- Duplicated header construction in `src/proxy.ts` and `src/lib/doh.ts`.
- Duplicated `Content-Type` media-type parsing in `src/lib/doh.ts` (now `mediaType()`).
- Duplicated IPv4/IPv6 family mapping and an unreachable branch in
  `src/lib/client-ip.ts` (`CanonicalIp` is now a discriminated union).
- Eight copies of the same fake-monotonic-clock setup in `scripts/test-doh.mjs`
  (now one `withManualClock()` helper).
- A value-level `import` of the `NextRequest` type in the provider route.

#### Optimized
- Upstreams that are already normalized (HaGeZi rotation and provider routes)
  pass through without a per-request lookup.
- The Docker image build skips the audit and funding lookups of `npm ci`.

#### Tests
- Regression tests added: named-range lookup with prototype names; bare trailing
  `?` on an override endpoint; malformed upstream `Age`; `null` preload timeout
  rejected by Node; large `max-age` values and exact `max-age`/`Age` differences;
  compressed DNAME/KX RDATA rejection and legacy SIG/NXT compression targets.
- `npm test`: 127 of 127 pass on Node.js 22.16.0. The test helper used the
  available global TypeScript 5.8.3 because the repository's dependency install
  did not complete in this environment.
- Strict type check of `src/lib` passes with unused-locals and unused-parameters
  enabled (checked with a `next/server` type shim).
- Not run in this environment: a complete `npm ci` (it timed out with package
  directories left incomplete), ESLint, the application type check, `next build`,
  the integration suite (`npm run test:integration`) and the Docker smoke test.

