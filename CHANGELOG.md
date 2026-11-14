# Changelog

## [2.11.0] - 2026-11-06

The version is unchanged. This is the latest modification log, updated in the
seventh re-review pass of 2026-11-14.

### Modified

#### Fixed
- `src/proxy.ts`: strip a client-supplied `x-doh-client-key` on `OPTIONS` and
  `HEAD` as well as other methods, preserving the rule that the private route
  header is always set or removed by the proxy.
- `server/socket-ip-preload.cjs`: preserve the backpressure signal from both
  halves when splitting a request-body chunk at the 4097-byte cap.
- `scripts/docker-smoke-test.mjs`: reject non-finite timeouts, sub-millisecond
  durations, and values whose conversion to milliseconds overflows, before
  Docker is invoked. Each fetch and retry pause is limited to the remaining
  readiness deadline, and a response drained after that deadline is not
  accepted as a successful readiness check.
- `scripts/test-integration.mjs`: bound readiness fetches by the remaining
  startup deadline, then verify the child has not exited or been signalled and
  the deadline has not elapsed after the response body is drained. Report spawn
  failures cleanly. The slow-upload test drains the response, clears its
  interval on early completion or request/response error, and destroys the
  request socket on a response-side error while upload is still active.

#### Changed
- `src/lib/doh.ts`: use one deadline timer for the whole POST body instead of
  one timer and promise per chunk; pre-handle the timeout rejection so a
  best-effort cancellation cannot produce an unhandled rejection.
- `src/lib/client-ip.ts`: walk `X-Forwarded-For` from the right and materialize
  only the selected hop; empty fields still count as positions.
- `src/lib/cors.ts`: share `textErrorHeaders()` between the rate-limit response
  and DoH plain-text errors.
- `Dockerfile`: mount a BuildKit cache on `.next/cache` for repeated image builds.
- `scripts/test-integration.mjs`: cancel process-exit fallback timers when
  server processes exit promptly.
- `scripts/docker-smoke-test.mjs`, `scripts/test-integration.mjs`, and
  `scripts/test-capacity.mjs`: use monotonic `performance.now()` deadlines
  instead of wall-clock timestamps.
- `scripts/test-doh.mjs`: use `performance.now()` for elapsed-time assertions;
  retain `Date.now()` only where tests deliberately exercise wall-clock behavior.

#### Tests
- `scripts/test-proxy.mjs`: cover injected client-key stripping on `OPTIONS`
  and `HEAD`.
- `scripts/test-config.mjs`: cover right-to-left `X-Forwarded-For` selection,
  including empty fields and boundary cases.
- `scripts/test-harness.mjs`: cover occupied mock-upstream ports and rejection
  of infinite, sub-millisecond, and millisecond-overflowing Docker smoke-test
  timeouts. Bound the spawned CLI check so a validation regression fails quickly.

#### Documentation
- `README.md`: clarify the development dependency install, test coverage,
  readiness-deadline behavior, Docker timeout minimum, and ESLint maintenance
  constraint.

### Sixth re-review (2026-11-14)

#### Review
- Read all 49 files in the base project archive and all six files in the
  supplied overlay (README, CHANGELOG, and four test scripts) before review.
  Rechecked the full lockfile and source/test/configuration files in the merged
  tree. No additional dead production code or production behavior change was
  justified. The sixth pass fixed bounded-readiness and early-upload cleanup
  gaps in the integration and Docker smoke-test helpers, including destroying
  an active request socket when response processing fails.
- The CSS utility scan found no unused project utility classes. The lockfile
  has 398 package records including root metadata; its JSON structure and root
  dependency, dev-dependency, engine, license, name, and version metadata match
  `package.json`.
- The ESLint 9.39.5 line remains end-of-life. The locked `eslint-config-next`
  peer range accepts ESLint 10, but the locked import, jsx-a11y, and React
  plugins still constrain peers to ESLint 9; upgrade the lint stack together
  rather than changing ESLint alone.

#### Verified
- `npm test`: 147/147 tests passed on Node.js 22.16.0 using the host's global
  TypeScript 5.8.3. This is not a substitute for the lockfile-pinned
  TypeScript 6.0.3.
- JavaScript syntax checks and TypeScript/TSX transpile syntax checks passed
  using the available host tools.
- Full typecheck, ESLint, production build, integration tests, and Docker build
  and smoke test remain unverified because the dependency tree is incomplete;
  the previous clean-install attempt was blocked by npm registry DNS errors.
  Confirm these checks in CI with the complete lockfile-pinned dependencies.

### Seventh re-review (2026-11-14)

#### Review
- Re-read all 49 files in the base archive and all six files in the supplied
  fifth-review overlay before judging the merged project. Rechecked the DNS/DoH
  runtime, tests, configuration, workflows, deployment files, documentation,
  license, and complete lockfile. No additional dead production code or
  production behavior change was justified.
- Fixed a Docker smoke-test boundary: timeout values below 1 ms are rejected,
  and a response body drained after the monotonic readiness deadline cannot
  turn a late response into a passing result.
- Hardened integration startup: after draining a readiness response, verify the
  spawned Next.js process is still alive and the 90-second deadline remains.
- Added a bounded timeout to the CLI argument regression test and converted
  elapsed-time assertions in the DoH tests to the monotonic clock.

#### Verified
- `npm test`: 147/147 tests passed on Node.js 22.16.0 using the host's global
  TypeScript 5.8.3; the lockfile declares TypeScript `^6.0.3`.
- JavaScript syntax checks and TypeScript/TSX transpile syntax checks passed.
- Lockfile JSON parses with 398 package records, no duplicate object keys, and
  root package metadata matching `package.json`.
- Full typecheck, ESLint, production build, integration tests, and Docker build
  and smoke test remain unverified because a complete dependency installation
  could not be obtained in this environment.
