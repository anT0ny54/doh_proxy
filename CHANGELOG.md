# Changelog

## [2.8.3] - 2026-10-16

### Security
- Upgraded `next` and `eslint-config-next` to ^16.4.1 (lockfile regenerated):
  resolves the critical image-optimization/SVG remote-code-execution advisory
  published 2026-10-14 (patched in 16.4.1; the existing `sharp@0.35.5`
  mitigation is retained) and the App Router Server Actions advisory from the
  same date.
- Migrated `eslint` 9 -> 10 (9.x is end-of-life since 2026-08-06); flat config
  updated, and lint, unit tests, production build and integration tests
  re-verified.
- Unknown-client fallback limiter: when `TRUST_PROXY_HEADERS=0`, or when no
  usable `X-Real-IP` / `X-Forwarded-For` header is present, requests were
  previously not rate limited at all. They now share one process-local global
  bucket with the same limit, so a directly exposed instance cannot evade
  limiting by omitting or forging forwarding headers. The global in-flight
  ceiling still applies; multi-instance deployments should still front the app
  with a shared reverse-proxy/WAF limiter.

### Fixed
- Integration-test teardown hang: when setup failed before the mock upstream
  was created (e.g. missing `.next/BUILD_ID`), `after()` awaited
  `mock?.close(resolve)`, which never settles for an undefined `mock`. Cleanup
  now guards on `mock` so the intended "run `npm run build` first" error is
  reported and the process exits.

### Changed
- ESLint now covers `scripts/**/*.mjs` (all node:test suites and helpers) via
  a dedicated flat-config block with Node globals; the blanket `scripts/**`
  ignore is removed.
- Dead code removal: the handler-level 405 branch in
  `getEarlyMethodResponse()` was unreachable in production because the Next.js
  router answers 405 for methods a route does not export; it is removed along
  with its stub-based unit test. The production 405 remains covered by the
  integration suite.
- Test maintenance: `scripts/test-integration.mjs` reuses the shared DNS
  builders in `scripts/lib/dns-fixtures.mjs` instead of its own
  `encodeName()` / `buildQuery()` / `buildUpstreamResponse()` copies.
- The dev-only `braces@3.0.3` advisory (no patched release; vulnerable range
  "*") remains tracked. Production `npm audit --omit=dev` stays the blocking CI
  gate; the full audit remains advisory.

