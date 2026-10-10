# Changelog

## Unreleased

`package.json`, `package-lock.json` and `PROXY_VERSION` (`src/lib/doh.ts`) are
all still `2.8.1`; the entries below are not yet assigned to a tagged release.
When releasing, bump all three together (`npm test` enforces that
`PROXY_VERSION` matches `package.json`).

### Security
- **`TRUST_PROXY_HEADERS` switch for client identity.** `X-Real-IP` /
  `X-Forwarded-For` are trusted **by default**: the variable unset, empty or
  truthy (`1`, `true`, `yes`, `on`; case-insensitive) enables them, while `0`,
  `false`, `no`, `off` and any unrecognized value disable them. It is
  evaluated on every request. Directly connected clients can forge these
  headers, so on an instance that is exposed without a sanitizing reverse
  proxy a forged IP mints a fresh rate-limit/in-flight identity: **set
  `TRUST_PROXY_HEADERS=0` there**. With trust disabled, per-IP rate limiting
  and the per-IP in-flight cap are inactive (only the global in-flight ceiling
  applies). An earlier draft of this entry described the flag as opt-in
  (default off); that never matched the code.
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
  upstream failures and response headers. Its requests carry no forwarding
  headers, so the client address is unknown and rate limiting is not exercised
  end to end; it does not assert graceful shutdown (processes are only
  terminated in teardown).
- DNS parser regression tests (`scripts/test-dns-rdata.mjs`) for the new
  RDATA validation, including malformed-response and compression-cycle cases.
- `HAGEZI_UPSTREAM_ENDPOINTS` environment variable to override the primary
  upstream list (comma-separated). Entries are trimmed, and ones that are not
  valid `http(s)` URLs are ignored; with no valid entry the built-in list is
  used. The list is used as
  given (no rotation) and is read once, on first use. Used by the integration
  suite; also useful for self-hosted deployments that pin their own resolvers.
- `scripts/test-config.mjs` (part of `npm test`): the `HAGEZI_UPSTREAM_ENDPOINTS`
  override (including rejection of non-`http(s)` entries), the default-on
  `TRUST_PROXY_HEADERS` boundary (including `X-Real-IP` precedence,
  last-`X-Forwarded-For`-entry selection and IP normalization) and the absence
  of a per-IP in-flight cap while trust is explicitly disabled.
- Regression tests in `scripts/test-doh.mjs` for the two fixes below (probe
  release after an inconclusive half-open attempt; GET keeping an existing
  query string). `npm test` now runs 79 tests (including the body-stream
  regression test listed below).
- Further `scripts/test-doh.mjs` coverage for behavior that was documented but
  untested: wrong upstream content type (fails over, does not trip the
  breaker), upstream responses over 65535 bytes (declared and streamed),
  handler-level `405` with `Allow`, `HAGEZI_ROTATION_MODE=request`, and
  `HAGEZI_ROTATION_SECONDS` clamping and fallback.

### Changed
- `src/lib/dns.ts`: `skipName()` took an optional `targets` bitmap, but every
  caller passes one, so the `if (targets)` / `targets &&` guards were dead
  branches. The parameter is now required and the guards are gone. No behavior
  change.
- Test code: the `validQuery()` / `validResponse()` builders that were
  copy-pasted into `test-doh.mjs`, `test-capacity.mjs` and `test-config.mjs`
  now live in `scripts/lib/dns-fixtures.mjs`. No behavior change.
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
  `TRUST_PROXY_HEADERS` (default on; `0`/`false`/`no`/`off` or an unrecognized
  value disables it) and `HAGEZI_UPSTREAM_ENDPOINTS` in the configuration
  table, no longer states that upstreams can never be configured, notes that
  rate limiting and per-IP caps are inactive only while trust is disabled and
  that a directly exposed instance (including a published Docker port) should
  set `TRUST_PROXY_HEADERS=0`, notes that Next.js may buffer request bodies
  when `src/proxy.ts` is in the pipeline, adds `Access-Control-Max-Age`, the
  type-aware RDATA rules, the seventh unit-test suite, the integration suite,
  CI and the `.github/workflows` files to the layout and checklists. Several
  passages that still described forwarding headers as opt-in were corrected,
  the Deployment section now recommends setting `TRUST_PROXY_HEADERS=1`
  explicitly on Vercel and Netlify (with a note to verify header sanitizing),
  and the layout now lists `npm.yml` (the README named a non-existent
  `yarn.yml`), `keep-alive.txt`, `.gitattributes` and `.gitignore`.
- Comments and test names that contradicted the code were corrected:
  `src/proxy.ts` and `src/lib/client-ip.ts` described trust as opt-in, and
  `scripts/test-config.mjs`, `test-doh.mjs` and `test-proxy.mjs` called the
  default "untrusted" or "opt in". No behavior change.

### Fixed
- **A failing POST body stream escaped the handler as an unhandled error.** If
  the request body stream rejected mid-read (for example the client aborted the
  upload), `readPostBody` cancelled the reader and then re-threw, so the route
  handler rejected and Next.js answered with a logged `500`. The error is now
  answered with `400 Request body error`; the in-flight slot was already
  released and still is. Covered by a new regression test in
  `scripts/test-doh.mjs` (verified to fail without the fix).
- **Half-open probe slot stayed reserved after an inconclusive attempt.** When
  a half-open probe was answered with a non-retryable status (e.g. `403`), the
  wrong content type or an invalid body, neither a failure nor a success was
  recorded, so the upstream stayed blocked for the full 5 s probe TTL. The slot
  is now released immediately; the outcome still does not count toward the
  breaker.
- **GET to an upstream endpoint that already has a query string.** The `dns`
  parameter was appended with a second `?` (`...?token=abc?dns=...`), which
  broke such `HAGEZI_UPSTREAM_ENDPOINTS` entries. The parameter is now added
  through `URL`, preserving the existing query. Built-in endpoints are
  unaffected.
- `HAGEZI_UPSTREAM_ENDPOINTS` accepted any parseable URL scheme (e.g.
  `ftp://`), which could only fail at request time and trip the breaker. Only
  `http(s)` entries are kept now.
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
- Trusting forwarding headers by default is convenient behind a platform front
  end but unsafe on a directly exposed instance; see `TRUST_PROXY_HEADERS`
  above. The last `X-Forwarded-For` entry is used as the client identity, so in
  a multi-proxy chain it must be appended by the outermost trusted proxy
  (or that proxy should set `X-Real-IP`).
- The homepage lists the compiled-in HaGeZi resolvers even when
  `HAGEZI_UPSTREAM_ENDPOINTS` overrides them at runtime.
- Dead-code review: apart from the optional `targets` guards removed above, no
  unused code was found in `src/`. `WINDOW_SIZE_MS`, `MAX_BUCKETS` and
  `TRUST_PROXY_HEADERS_ENV` are exported but only used inside their modules and
  tests, which is harmless; the `Uint8Array`/omitted-query forms of
  `isValidDnsResponse()` are exercised only by tests (production passes a
  `ParsedQuery`) and were kept as part of its public contract.
- The handler does not observe `request.signal`, so an upstream attempt for a
  client that has already disconnected runs until it finishes or the 2.5 s
  deadline expires, holding its in-flight slot meanwhile.
- DNS compression pointers into RDATA that the parser treats as opaque are
  rejected. That covers every type other than NS/CNAME/PTR/DNAME, MX, SOA, SRV
  and SVCB/HTTPS, including legacy name-bearing types such as RP, AFSDB and
  MINFO, so a response that points into one of those would fail validation.
