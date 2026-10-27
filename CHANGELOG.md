# Changelog

## [Unreleased]

### Fixed
- Request deadlines, POST-body read deadlines, and circuit-breaker cooldown,
  failure-window, and probe-lease timing now use a monotonic clock. Wall-clock
  corrections can no longer prematurely stop failover, extend request handling,
  expire a cooldown early, or expire an active probe lease.
- Release the upstream response reader lock when a body read errors. The
  upstream still counts as a failed attempt and failover continues, but the
  errored stream is no longer left locked until garbage collection.
- Make best-effort cancellation tolerate a synchronous `cancel()` throw so it
  cannot replace an intended request-body error or produce an unhandled rejection.
- Removed a redundant reduced-motion `scroll-behavior` override; the same media
  query still disables nonessential transitions and animations.
- Corrected the rate-limiter clock comment to describe its defensive handling
  of backward input without incorrectly implying that `performance.now()` can
  normally move backward.

### Tests
- Added regression coverage for forward wall-clock jumps during request and
  POST-body deadlines, circuit-breaker cooldowns and active probe leases, plus
  reader-lock cleanup after an upstream stream error, and preservation of a
  `413` response when body cancellation throws synchronously.
- All 115 unit tests pass on Node.js 22.16.0 using the environment's global
  TypeScript 5.8.3 transpiler. Installing the locked dependencies timed out, so
  lint, type checking, production build, integration tests, and Docker checks
  could not be run in this environment.

The project version remains `2.10.0`; no version bump or lockfile change was
made.
