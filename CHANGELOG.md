# Changelog

## Unreleased

`package.json`, `package-lock.json` and `PROXY_VERSION` (`src/lib/doh.ts`) are
all still `2.8.1`; the entries below are not yet assigned to a tagged release.
When releasing, bump all three together (`npm test` enforces that
`PROXY_VERSION` matches `package.json`).

### Security
- **Trusted-proxy boundary for client identity.** `X-Real-IP` /
  `X-Forwarded-For` are now honored only when `TRUST_PROXY_HEADERS` is set to
  a truthy value (`1`, `true`, `yes`, `on`; case-insensitive). Directly
  connected clients can forge these headers, and previously a forged IP would
  mint a fresh rate-limit/in-flight identity. Set `TRUST_PROXY_HEADERS=1` only
  behind a reverse proxy that overwrites or sanitizes these headers on every
  request. While it is unset, per-IP rate limiting and the per-IP in-flight cap
  are inactive (only the global in-flight ceiling applies).
- **Stricter DNS compression-pointer validation.** RDATA is now decoded
  according to record type (NS/CNAME/PTR/DNAME, MX, SOA, SRV, SVCB/HTTPS), and
  only bytes validated as genuine domain names become compression targets.
  Previously the entire RDATA region was marked as targetable, letting
  malformed upstream responses pass structural validation. SVCB/HTTPS target
  names must be uncompressed (RFC 9460, section 2.2); RDATA of all other types
  stays opaque, so a pointer into it is rejected.

### Added
- CI workflow (`.github/workflows/ci.yml`) running lint, unit tests, build,
  real-HTTP integration tests, a Docker image build + container smoke test,
  and a separate `npm audit` job on every push and pull request to `main`.
- End-to-end integration suite (`npm run test:integration`) that launches the
  built application (`next start`) against a local mock DoH upstream and
  covers GET, POST, invalid content types, oversized bodies, slow clients,
  upstream failures and response headers. It does not enable
  `TRUST_PROXY_HEADERS`, so rate limiting is not exercised end to end, and it
  does not assert graceful shutdown (processes are only terminated in teardown).
- DNS parser regression tests (`scripts/test-dns-rdata.mjs`) for the new
  RDATA validation, including malformed-response and compression-cycle cases.
- `HAGEZI_UPSTREAM_ENDPOINTS` environment variable to override the primary
  upstream list (comma-separated). Entries are trimmed and malformed ones
  ignored; with no valid entry the built-in list is used. The list is used as
  given (no rotation) and is read once, on first use. Used by the integration
  suite; also useful for self-hosted deployments that pin their own resolvers.
- `scripts/test-config.mjs` (part of `npm test`): the `HAGEZI_UPSTREAM_ENDPOINTS`
  override, the default-off `TRUST_PROXY_HEADERS` boundary (including
  `X-Real-IP` precedence, last-`X-Forwarded-For`-entry selection and IP
  normalization) and the absence of a per-IP in-flight cap while untrusted.
- Further `scripts/test-doh.mjs` coverage for behavior that was documented but
  untested: wrong upstream content type (fails over, does not trip the
  breaker), upstream responses over 65535 bytes (declared and streamed),
  handler-level `405` with `Allow`, `HAGEZI_ROTATION_MODE=request`, and
  `HAGEZI_ROTATION_SECONDS` clamping and fallback.

### Changed
- Upgraded `next` and `eslint-config-next` to ^16.4.0 (lockfile regenerated):
  resolves the critical `next/og` RCE and the sharp/source-map-js advisories.
  The remaining audit findings are a dev-only lint-time chain
  (braces/micromatch/fast-glob) whose advisory has no patched release
  (vulnerable range "*"); production `npm audit --omit=dev` is clean. CI now
  gates on the production audit and reports the full audit as advisory.
- `src/lib/doh.ts` internals: the two near-identical best-effort stream
  cancellation helpers are now one (`cancelBestEffort`); provider routes
  normalize only their single upstream instead of the whole list; a POST body
  that arrives as one chunk is no longer copied again before parsing. The
  JSDoc describing HaGeZi rotation now sits on `getHageziUpstreams()` instead
  of the unrelated `overrideUpstreams` variable. No behavior change.
- README rewritten where it no longer matched the code: documents
  `TRUST_PROXY_HEADERS` and `HAGEZI_UPSTREAM_ENDPOINTS` in the configuration
  table, no longer states that upstreams can never be configured, notes that
  rate limiting and per-IP caps are inactive until proxy headers are trusted
  (including on Vercel/Netlify), notes that Next.js may buffer request bodies
  when `src/proxy.ts` is in the pipeline, adds `Access-Control-Max-Age`, the
  type-aware RDATA rules, the seventh unit-test suite, the integration suite,
  CI and the `.github/workflows` files to the layout and checklists.

### Fixed
- **Circuit-breaker half-open probe was reserved without being used.** The
  probe slot was claimed while *filtering* upstreams, so when an earlier
  upstream in the (rotated) order answered, a recovered upstream was never
  contacted yet stayed blocked for the 5 s probe TTL, and this could repeat
  indefinitely. The slot is now reserved only when an attempt on that upstream
  actually starts, and re-checked just before each attempt so concurrent
  requests still let exactly one probe through.
- `docker-publish.yml` passed an empty `NEXT_PUBLIC_SITE_URL` build argument
  when the repository variable was unset, which overrides the Dockerfile
  default and made the published image show `http://localhost:3000`. It now
  falls back to `http://localhost:8367`, the Dockerfile default.
- Integration suite robustness: the oversized-body case now streams chunked
  data past the size cap instead of relying on a declared content-length the
  fetch client refuses to under-send; the slow-upload case accepts the
  buffering behavior of the middleware pipeline (bounded terminal response);
  the 405 case no longer asserts an `Allow` header that Next's router does not
  set for unexported methods (the handler-level `Allow` is now unit-tested in
  `scripts/test-doh.mjs`).
- The integration suite header no longer claims a graceful-shutdown check that
  never existed.

### Notes
- Rate limits and in-flight ceilings remain per-instance. In multi-instance
  deployments, enforce global limits at a shared gateway or WAF.
