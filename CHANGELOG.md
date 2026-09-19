
## [2.7.3] - 2026-09-19 Extended

### Fixed
- Removed duplicate `getEarlyMethodResponse` call in `handleHageziDoH` (redundant with `proxyRequest`)
- Resolved `maxDuration = 3` vs `HAGEZI_TIMEOUT_MS = 2500` conflict by increasing `maxDuration` to 5 seconds
- Fixed potential O(n²) attack via DNS compression pointers by adding hard cap on total bytes walked

### Removed
- Removed dead `url` property from `DoHUpstream` interface (was never populated by callers)
- Removed unnecessary export of `HAGEZI_TIMEOUT_MS` (now internal constant)
- Removed redundant `apiCsp` header from API routes (CSP is ignored by browsers on non-HTML responses)

### Added
- Added timing-safe comparison for DNS question keys using `crypto.subtle.timingSafeEqual` with constant-time fallback
- Added circuit breaker pattern for upstream health tracking (3 failures → 30s cooldown)
- Added in-memory rate limiting middleware for non-Netlify deployments (`src/middleware.ts`)
- Added `X-RateLimit-*` headers to rate-limited responses

### Changed
- Optimized `readPostBody` and `readResponseBody` to use dynamic chunk allocation instead of upfront 4KB buffer
- Updated Netlify edge function documentation to reference Next.js middleware for non-Netlify deployments
- Improved compression pointer validation with `totalBytesWalked` counter

### Security
- Added timing-safe comparison to prevent timing attacks on DNS response validation
- Added circuit breaker to prevent cascading failures to unhealthy upstreams
- Added rate limiting for Vercel and self-hosted Docker deployments (previously only Netlify had rate limiting)

---

# FreeDNS DoH Proxy — Changelog

All notable changes to this project are documented here.

## v2.7.3 — Static footer and upstream URL normalization

### Runtime / maintenance

- Pre-normalized all fixed provider and HaGeZi upstream URLs at module load, avoiding repeated URL parsing for fixed destinations.
- Kept compatibility for custom test/injected upstream descriptors by normalizing them once per proxy request.
- Replaced the render-time footer year with an explicit static copyright year for the statically generated homepage.

## v2.7.2 — Deadline separation and DoH runtime hardening

### Runtime

- Reduced the HaGeZi application deadline from 3,000 ms to 2,500 ms while retaining the 3-second route execution ceiling, leaving platform overhead headroom.
- Added focused DoH runtime tests for failover, upstream timeout, GET validation, and upstream rejection.
- Tightened DNS compression-pointer validation so pointers must target previously parsed domain-name positions.
- Simplified provider routes from `/api/doh/[provider]/[format]` to `/api/doh/[provider]/dns-query`.
- Short-circuited `HEAD`/`OPTIONS` before upstream rotation and moved GET-only URL parsing into the GET branch.
- Made request/response stream cancellation best-effort and bounded.

## v2.7.1 — Runtime hardening and documentation alignment

### Runtime

- Kept the intentionally strict single-question DNS model.
- Resource-record owner names may use backward DNS compression pointers; the first Question QNAME is not compressed.
- Removed the per-name `Set` allocation because pointers are restricted to earlier offsets; the existing jump cap remains as defense-in-depth.
- Added response-to-query correlation: the relayed DNS response must match the original transaction ID and Question section, with case-insensitive ASCII DNS-name matching.
- Kept the fixed-upstream model: no arbitrary/custom upstream URL is accepted.
- Kept three server-owned HaGeZi upstreams with deterministic rotation and sequential failover.
- Kept fixed provider routes for Google, Cloudflare, AdGuard, and DNS.SB without provider failover.

### Bounds and timeouts

- Kept the 4 KiB maximum DNS message size for both requests and upstream responses.
- Kept the 8192-character GET query-string limit.
- Kept streaming reads into fixed-size buffers for POST requests and upstream responses.
- Kept the 3-second global budget for the primary HaGeZi path.
- Kept bounded sequential failover and retryable-upstream handling.

### HTTP / DoH behavior

- Kept RFC 8484 GET and POST handling.
- Kept `HEAD` and `OPTIONS` handling for health checks and CORS preflight.
- Kept `200 application/dns-message` as the only upstream response accepted for relay.
- Kept `Cache-Control: no-store`; there is no application DNS response cache.
- Kept wildcard CORS and security headers.

### Deployment

- `next.config.ts` enables `output: "standalone"` for self-hosted builds when neither `VERCEL` nor `NETLIFY` is present at build time.
- Managed Vercel and Netlify builds use their platform-specific Next.js build handling rather than the Docker standalone bundle.
- Docker starts the generated standalone server with `node server.js` on port `8367` as a non-root user.
- Netlify rate limiting is defined as a platform rule in `netlify/edge-functions/doh-rate-limit.ts` for `/api/doh/*`, configured for 100 requests per 60 seconds aggregated by IP + domain.
- Vercel and self-hosted deployments do not contain an application-level shared rate limiter; use platform/WAF/gateway controls instead.

### Documentation

- Updated `README.md` to describe the actual route structure, fixed upstream model, request/response limits, failover behavior, deployment modes, and rate-limiting responsibilities.
- Documented the 4 KiB DNS message limit as an intentional resource/compatibility trade-off; unusually large DNS/DNSSEC responses may be rejected.
- Clarified that the application contains no DNS query-content logging code, while GET requests still carry the encoded DNS message in the URL and may therefore be visible to infrastructure access logging.
- Clarified the distinction between Netlify's edge rate-limit function and the Next.js application route.
- Removed unrelated Bandwidth Hero marketing content from the project README.

### Validation coverage

- Added regression coverage for accepted backward compression and rejected forward/out-of-message compression pointers.
- Added regression coverage for response transaction-ID matching, Question matching, and case-insensitive DNS names.
- Kept structural validation coverage for message type, one-question enforcement, section bounds, and DNS name size.

## v2.7.0 — DoH runtime hardening and low-allocation optimization

- Added response-to-query correlation: the relayed DNS response must match the original transaction ID and Question section (case-insensitive DNS name matching).
- Reworked bounded request and upstream response reads to use a single fixed 4 KiB buffer instead of accumulating chunk arrays and copying them into a second buffer.
- Reused the already-validated GET DNS wire message instead of decoding the Base64URL query twice.
- Added an explicit 3-second Next.js route execution budget to match the primary HaGeZi failover budget.
- Removed unnecessary `Vary: Accept` from non-cacheable DoH responses.
- Centralized HaGeZi endpoint metadata in `src/lib/upstreams.ts` so runtime routing and the homepage use one source of truth.
- Kept the fixed-upstream model, strict 4 KiB bounds, streaming reads, bounded sequential failover, Next.js Edge runtime where used, and deployment-edge rate limiting unchanged.
- Expanded DNS regression tests for valid responses, transaction/question matching, mismatched IDs/questions, and DNS case-insensitive names.
- Bumped the application/proxy version to 2.7.0.

## v2.6.2 — Runtime correctness and security fixes

- Scoped the strict API Content Security Policy to `/api/doh/*` so the interactive homepage can load its required scripts and styles.
- Kept the upstream abort deadline active through the complete response-body read, preventing slow/trickling upstream responses from escaping the request budget.
- Applied the same bounded request deadline to streaming POST-body reads, preventing slow client uploads from holding an execution open indefinitely.
- Tightened DNS name validation with the 255-octet name limit and backward-only compression pointers for resource-record names.
- Centralized the repository URL and removed duplicate configuration.
- Removed redundant `force-dynamic` Route Handler configuration and unused DNS re-exports.
- Synchronized package/proxy/changelog version metadata at 2.6.2.
- Removed redundant `Vary: Origin` from wildcard-CORS responses.

## v2.6.1 — Runtime hardening and deployment cleanup

- Replaced the per-instance in-memory rate limiter with deployment-edge rate limiting; removed client-IP header trust from application code.
- Added a strict shared DNS wire-message validator for GET and POST requests, including DNS header, question, compressed owner-name, and resource-record structure checks.
- Enforced `200` + `application/dns-message` for upstream success responses and validated the returned DNS response before relaying it.
- Added bounded upstream response reads and cancelled failed/oversized upstream bodies.
- Limited automatic failover to retryable HTTP statuses plus network/timeouts instead of every non-2xx response.
- Added bounded per-attempt timeouts inside the global HaGeZi request budget.
- Fixed the GET base64url validator to reject padded encodings and duplicate `dns` parameters.
- Centralized the public site origin and removed hardcoded Vercel URLs from the homepage and metadata.
- Switched Docker dependency installation back to reproducible `npm ci`.
- Fixed the package-lock workflow path trigger and npm cache dependency path.
- Replaced the ESLint compatibility shim with the native flat-config setup supported by Next.js 16.
- Removed unused `DoHUpstream.name` data.
- Added contextual labels to the endpoint copy buttons and CORS preflight caching.

## v2.6.0 — Build/tooling conflict fixes

- Fixed a regression from v2.5.0: removing the standalone Next.js output (to stop it breaking the Vercel/Netlify build) had left `Dockerfile` still copying `.next/standalone`, so `docker build` no longer produced a working image. `next.config.ts` now emits `output: "standalone"` only when neither `VERCEL` nor `NETLIFY` is set in the build environment, so Docker gets its standalone bundle back without reintroducing the managed-platform build failure.
- Pinned `typescript` to `^6.0.3` instead of `^7`. The current linting toolchain has a peer-range constraint below TypeScript 7, so the project remains on the 6.x line until that toolchain can support TypeScript 7 cleanly.
- Kept the dependency workflow responsible for regenerating `package-lock.json` from `package.json`.
- Documented the Docker self-host path in `README.md`.
- Bumped the application/proxy version to 2.6.0.
- No public API, route, or wire-format behavior changed.

## v2.5.0 — Vercel + Netlify optimization

- Preserved all five public DoH endpoint paths and their RFC 8484 GET/POST behavior.
- Added bounded streaming POST-body reads so oversized chunked uploads are rejected without buffering an unbounded request body.
- Forwarded only the validated `dns` query parameter to GET upstreams, preventing unrelated query parameters from being propagated.
- Kept `Cache-Control: no-store` authoritative instead of allowing an upstream cache header to override the proxy policy.
- Preferred Vercel's `x-vercel-forwarded-for` client-IP header for the application rate limiter.
- Expanded Netlify's platform rate-limit rule from the primary route to every `/api/doh/*` route.
- Removed the self-hosting-only Next.js standalone output from the Vercel/Netlify build target.
- Bumped the application/proxy version to 2.5.0.

## v2.4.0 — Codebase cleanup

- Removed a dead, unused `DoHProvider` type import in `src/lib/doh.ts`.
- Removed duplicated provider data: the homepage (`src/app/page.tsx`) now derives its provider endpoint list from `src/lib/providers.ts` instead of maintaining a second hardcoded copy.
- Avoided redundant URL re-parsing on every upstream failover attempt in `src/lib/doh.ts` (the request URL is now parsed once and passed through).
- Removed `wrangler.toml`: it had no CI workflow wiring it up, and its `pages_build_output_dir` setting was inconsistent with this project's actual Vercel/Netlify-focused build output. Not needed for the stated Vercel/Netlify deployment targets.
- Rewrote `README.md` to remove contradictory statements left over from prior edits, merged duplicate deployment documentation, and removed documentation for a `DEBUG_LOG` variable that was never implemented.
- Rewrote this changelog: the previous "Changes v1" and "Changes v2" sections were duplicate leftover content.
- No public API, route, or wire-format behavior changed.

## v2.3.0 and earlier

- Established `/api/doh/dns-query` as the primary HaGeZi-backed RFC 8484 endpoint, with GET `?dns=` and POST `application/dns-message` support.
- Added deterministic HaGeZi upstream rotation and sequential failover.
- Added four fixed, wire-format-only provider endpoints: `google`, `cloudflare`, `adguard`, `dnssb`.
- Removed the legacy provider-root JSON routing layer and its client-side DNS tester dependency; eliminated arbitrary upstream selection.
- Extended the in-process rate limiter to all `/api/doh/*` routes.
- Preserved `no-store`, CORS, bounded timeouts, and 4 KiB message limits throughout.
- Fixed a Docker build context conflict caused by copying a non-existent `public/` directory.
