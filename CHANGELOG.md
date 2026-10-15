# Changelog

## [2.9.0] - 2026-10-16

### Security
- One client-identity model for both trust modes, each enforcing **100
  requests/minute per client** (`RATE_LIMIT_PER_MINUTE`):
  - `TRUST_PROXY_HEADERS=1` (still the default) trusts the header the platform
    edge sets itself instead of always preferring client-forgeable
    `X-Real-IP`: Vercel `x-real-ip` then `x-forwarded-for`, Netlify
    `x-nf-client-connection-ip`, self-hosted `x-forwarded-for` (detected at
    build time through `DOH_BUILD_PLATFORM`, inlined by `next.config.ts`).
    New `CLIENT_IP_HEADERS` overrides the list and `TRUSTED_PROXY_HOPS`
    (default 1) picks the `X-Forwarded-For` entry from the right. An unusable
    entry falls back to the socket address, never to a client-written entry.
  - `TRUST_PROXY_HEADERS=0` previously put every client into one shared
    bucket, so 100 requests/minute in total throttled the whole service. It
    now limits each client by its TCP socket address, recorded by the new
    `server/socket-ip-preload.cjs` (`node --require`, loaded by the Docker
    image and `npm start`). The header it writes is overwritten on every
    request and honored only in processes that loaded the preload, so it
    cannot be forged. The shared bucket remains only for requests with no
    address at all (trust disabled on a platform without the preload).
  - On a directly exposed self-hosted instance with the default trust,
    Next.js only fills in `X-Forwarded-For` when it is absent, so a client
    could mint a new identity per request; the README now documents
    `TRUST_PROXY_HEADERS=0` (now per-client) for that case.
- The image optimizer is disabled (`images: { unoptimized: true }`). The app
  never uses `next/image`, so the optimizer endpoint behind the 2.8.3
  image-optimization advisory is no longer reachable.
- `package-lock.json` fully regenerated: it had no `@next/swc-*` entries and
  still recorded `next`'s dependencies at 16.4.0 (`sharp ^0.35.4`), which
  caused the "Mismatching @next/swc version" build warning: `npm ci`
  installed no locked SWC binary for 16.4.1 (including the musl one used by
  the Alpine Docker build). All eight `@next/swc-*@16.4.1`
  binaries are now locked and `eslint` resolves to 10.12.0 instead of 10.0.0.

### Fixed
- Half-open probe ownership: a request that skipped an upstream could clear
  another request's in-flight probe, letting a second probe through. Probes
  now carry an ownership token and only the owner releases them.
- CORS preflights (`OPTIONS`) are no longer rate limited (browsers cannot read
  a failed preflight, and preflights do no upstream work). The `429` now
  carries the full CORS header set and a `Content-Type`.
- The relayed GET `max-age` now subtracts the upstream `Age` header, so
  clients no longer cache an answer longer than its remaining TTL.
- Name compression into the RDATA of MD, MF, MB, MG, MR, MINFO, RP, AFSDB, RT,
  PX, NAPTR and KX records was rejected, failing valid answers. RDATA name
  validation is now table-driven and covers these types (RFC 1035 and the
  RFC 3597 section 4 types).
- `Retry-After` on a `429` is exact for the sliding window (retrying after it
  succeeds) instead of always pointing at the end of the fixed window.
- Docker publish workflow: the semver tag rules never applied because the
  workflow only ran on `workflow_dispatch`; it now also runs on `v*` tags.
- `npm.yml` committed lockfiles with `[skip ci]` and without verification. It
  now regenerates from scratch, checks the `@next/swc-*` binaries are locked,
  runs lint, type check, tests and build first, and no longer skips CI.
- README corrections: removed the handler-level `405` and the "not rate
  limited" claim for unknown clients, corrected the integration-suite
  description (its requests were rate limited as `127.0.0.1`), the probe TTL
  description and the public endpoint list labelling.

### Changed
- Configuration: every environment variable is parsed once at startup in
  the new `src/lib/config.ts` (previously `TRUST_PROXY_HEADERS` and
  `HAGEZI_ROTATION_*` were read on every request).
- The client IP is resolved once per request in `src/proxy.ts` and handed to
  the route in a private `x-doh-client-key` header (always overwritten or
  removed) instead of being parsed again in `doh.ts`.
- Rate limiter: sliding-window counter (previous window weighted by its
  overlap) instead of a fixed window, so there is no 2x burst at window
  boundaries; same O(1) eviction and 10,000-key cap.
- Circuit breaker: failures more than 30 seconds apart no longer accumulate,
  so isolated failures spread over hours cannot trip it. Provider routes
  (single upstream, no failover) no longer keep breaker state, which never
  changed their behavior.
- Unknown provider ids are answered `404` by the router
  (`generateStaticParams()` + `dynamicParams = false`) before handler code
  runs.
- GET upstream URLs are built from a precomputed prefix (a `#fragment` on an
  endpoint is dropped) instead of a new `URL` per attempt; the handler uses
  `request.nextUrl`.
- `PROXY_VERSION` is imported from `package.json`; the duplicated constant and
  its sync test are gone.
- New `src/lib/cors.ts` shares the CORS headers between the handler and the
  `429`.
- CI: new `typecheck` script (`tsc --noEmit`) in CI and the publish workflow;
  the audit job uses `npm audit --package-lock-only` without installing; the
  Docker smoke test sends a real DoH query to the container against the
  shared mock upstream instead of only loading `/`. Docker publishing is gated
  on lint, type check and unit tests.
- Tests: `scripts/lib/transpile-source.mjs` resolves `@/lib/*` imports
  recursively and can load fresh module instances for configuration tests;
  every suite uses the shared builders in `scripts/lib/dns-fixtures.mjs`; the
  mock upstream moved to `scripts/lib/mock-upstream.mjs`. New tests cover
  both trust modes (unit and real HTTP), platform header defaults, hop
  selection, probe ownership, the failure window, `Age`, router 404s,
  `Content-Length` and the sliding window. `npm test` runs with
  `--expose-gc`.
- Version 2.9.0.

### Removed
- Dead code: the no-op `nodeGlobals` ESLint block (the shared config already
  provides those globals), the unreachable `"::"` branch and the redundant
  falsy list in `client-ip.ts`, the unreachable `length > 63` label check and
  the duplicate response-size check in `dns.ts`, the `Uint8Array` query form
  of `isValidDnsResponse` (tests only), the `getEarlyMethodResponse` wrapper,
  the double `stripPadding`, the arrow-function route wrapper, and
  `!README.md` in `.dockerignore` (the Dockerfile never copies it).
- Test cleanup: per-suite `encodeName` / `buildQuery` / `queryWithName`
  copies, the misnamed "pre-parsed and rotated" test, the off-by-one-level
  indentation in `test-doh.mjs` and the mixed `await test()` style in
  `test-dns.mjs`.

### Not changed (on purpose)
- Upstream deadlines still use an `AbortController` with a cleared timer.
  Replacing it with `AbortSignal.any([AbortSignal.timeout(ms), ...])` was
  tried and reverted: a timeout signal referenced only through
  `AbortSignal.any()` can be garbage-collected and then never fires, which
  would silently disable the deadline. A regression test covers this.
- The explicit `Content-Length` on answers stays: without it Next.js sends
  `ArrayBuffer` bodies with chunked encoding (verified by the integration
  suite).
- The 5 second probe TTL is kept, documented as a safety net only.
- The dev-only `braces` advisory (no patched release) remains advisory in CI;
  the production audit reports 0 vulnerabilities.

