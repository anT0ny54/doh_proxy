# Changelog

## [2.10.0] - 2026-10-27

### Fixed
- Treat explicitly `undefined` preload timeout options as absent so the managed
  10 s request, 5 s headers, and 1 s connection-check defaults still apply;
  object spread previously replaced them with `undefined` (and `NaN` after the
  headers clamp), which could disable a default or make `createServer()` throw.
- Mark validated DNS compression-pointer starts as legal suffix targets, so a
  later name may point to an earlier compressed suffix without being rejected.
  Opaque RDATA bytes remain ineligible as pointer targets.
- Keep `loadConfig(env)` isolated to the supplied environment while retaining
  Next.js's build-time `DOH_BUILD_PLATFORM` substitution for the default config.
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
- Preserve native HTTP server event argument lists in the socket-IP preload and
  retain the listener in the `createServer(undefined, listener)` overload.
- Reject malformed bracketed client addresses, invalid ports, and overlong IP
  entries instead of accepting a valid-looking prefix.
- Reject mock-upstream listen errors immediately (including occupied ports)
  instead of leaving the start promise pending with an unhandled server error.
- Validate IPv6 scope IDs before stripping them, reject zone suffixes on IPv4,
  and compile trusted-proxy entries only from bare IP/CIDR literals.
- Parse incoming and upstream `Content-Length` values as decimal digits only;
  JavaScript-specific numeric spellings such as `0x10` and `1e2` are rejected.
- Require decimal-digit syntax for numeric runtime settings instead of accepting
  JavaScript numeric spellings such as `0x10`, `1e2`, or `+100`.

### Tests
- Added regression coverage for explicit `undefined` preload timeout options
  alongside the existing HTTP-server overload and timeout tests.
- Added regression coverage for compressed DNS suffix pointers, explicit
  configuration-environment isolation, malformed client-IP values, HTTP server
  listener overloads and event argument counts, mock-upstream port conflicts,
  strict `Content-Length` parsing, trusted-proxy/address-decoration validation,
  and decimal-only runtime numeric settings, alongside the existing deadline
  and upstream-failure regressions.
- All 120 unit tests pass in this audit environment (Node.js 20.20.2 with an
  external TypeScript 5.8.3 transpiler). A locked dependency install remained
  unavailable, so lint, type checking, the production build, integration tests,
  Docker checks, and npm audit could not be run here.

The project version remains `2.10.0`; no version bump or lockfile change was
made.
