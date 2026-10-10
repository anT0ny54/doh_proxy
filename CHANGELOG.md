# Changelog

## Unreleased

### Security
- **Trusted-proxy boundary for client identity.** `X-Real-IP` /
  `X-Forwarded-For` are now honored only when `TRUST_PROXY_HEADERS` is set to
  a truthy value. Directly connected clients can forge these headers, and
  previously a forged IP would mint a fresh rate-limit/in-flight identity.
  Set `TRUST_PROXY_HEADERS=1` only behind a reverse proxy that overwrites or
  sanitizes these headers on every request.
- **Stricter DNS compression-pointer validation.** RDATA is now decoded
  according to record type (NS/CNAME/PTR/DNAME, MX, SOA, SRV, SVCB/HTTPS), and
  only bytes validated as genuine domain names become compression targets.
  Previously the entire RDATA region was marked as targetable, letting
  malformed upstream responses pass structural validation.

### Added
- CI workflow (`.github/workflows/ci.yml`) running lint, unit tests, build,
  real-HTTP integration tests, a Docker image build + container smoke test,
  and a separate `npm audit` job on every push and pull request to `main`.
- End-to-end integration suite (`npm run test:integration`) that launches the
  built application against a local mock DoH upstream and covers GET, POST,
  invalid content types, oversized bodies, slow clients, upstream failures,
  response headers and shutdown.
- DNS parser regression tests (`scripts/test-dns-rdata.mjs`) for the new
  RDATA validation, including malformed-response and compression-cycle cases.
- `HAGEZI_UPSTREAM_ENDPOINTS` environment variable to override the primary
  upstream list (comma-separated). Used by the integration suite; also useful
  for self-hosted deployments that pin their own resolvers.

### Changed
- Upgraded `next` and `eslint-config-next` to ^16.4.0 (lockfile regenerated):
  resolves the critical `next/og` RCE and the sharp/source-map-js advisories.
  The remaining audit findings are a dev-only lint-time chain
  (braces/micromatch/fast-glob) whose advisory has no patched release
  (vulnerable range "*"); production `npm audit --omit=dev` is clean. CI now
  gates on the production audit and reports the full audit as advisory.

### Fixed
- Integration suite robustness: the oversized-body case now streams chunked
  data past the size cap instead of relying on a declared content-length the
  fetch client refuses to under-send; the slow-upload case accepts the
  buffering behavior of the middleware pipeline (bounded terminal response);
  the 405 case no longer asserts an `Allow` header that Next's router does not
  set for unexported methods.

### Notes
- Rate limits and in-flight ceilings remain per-instance. In multi-instance
  deployments, enforce global limits at a shared gateway or WAF.
