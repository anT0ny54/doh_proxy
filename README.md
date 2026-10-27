# FreeDNS DoH Proxy

A lightweight DNS-over-HTTPS (DoH) proxy built with the Node.js runtime, using the Next.js 16, React 19, Tailwind CSS 4, and TypeScript 6 dependency lines declared in `package.json` (Node.js 22 or newer). The service is designed around a small, fixed upstream set, bounded request/response handling, sequential failover with per-upstream circuit breakers, and process-local overload protection.

## What this project provides

The project exposes a public DoH service and a small homepage. The proxy never accepts a request-supplied upstream URL: the provider upstreams are compiled into the application, and so is the primary HaGeZi list unless the operator pins their own resolvers at startup with `HAGEZI_UPSTREAM_ENDPOINTS` (see [Configuration](#configuration)).

### Primary DoH endpoint

```text
https://<your-domain>/api/doh/dns-query
```

The primary endpoint uses a rotating set of three server-owned HaGeZi DoH resolvers. By default each client gets a stable first choice derived from its address, so load spreads across all three. Requests are attempted sequentially, with a bounded timeout and failover inside the request deadline.

### Fixed provider endpoints

These routes are for testing or using a specific compiled-in upstream through the same proxy code:

| Provider | Endpoint |
|---|---|
| Google | `/api/doh/google/dns-query` |
| Cloudflare | `/api/doh/cloudflare/dns-query` |
| AdGuard | `/api/doh/adguard/dns-query` |
| DNS.SB | `/api/doh/dnssb/dns-query` |

Provider routes do **not** accept arbitrary upstream URLs and do not use the HaGeZi failover list.

## Project layout

```text
src/proxy.ts                       Rate limiter entry point (Next.js proxy, matcher: /api/doh/:path*)
src/app/api/doh/dns-query/         Primary HaGeZi endpoint (GET/POST/HEAD/OPTIONS)
src/app/api/doh/[provider]/        Fixed provider endpoints (GET/POST/HEAD/OPTIONS)
src/app/page.tsx                   Static homepage listing the endpoints
src/app/layout.tsx                 Root layout, metadata and viewport
src/app/globals.css, icon.svg      Tailwind entry stylesheet and favicon
src/components/CopyButton.tsx      Client component: copy-to-clipboard button (with fallback)
src/lib/doh.ts                     Request handling, failover, circuit breaker, in-flight limits
src/lib/dns.ts                     DNS wire-format validation and query/response matching
src/lib/config.ts                  All environment settings, parsed once at startup
src/lib/cors.ts                    CORS headers shared by the DoH handler and the 429 response
src/lib/rate-limit.ts              In-process sliding-window-counter limiter
src/lib/client-ip.ts               Client identity (trusted header / socket address) and normalization
src/lib/providers.ts               Fixed provider upstreams
src/lib/upstreams.ts               Fixed HaGeZi upstreams
src/lib/site.ts                    Public origin resolution, repository URL, copyright year
scripts/test-*.mjs                 node:test suites. `npm test` runs all but test-integration.mjs (no build
                                   needed); `npm run test:integration` needs a prior `npm run build`
server/socket-ip-preload.cjs       `node --require` preload (loaded by `npm start` and the Docker image):
                                   records the TCP peer address, sets HTTP request/header timeouts and
                                   keeps oversized request bodies detectable
scripts/lib/transpile-source.mjs   Test helper: transpiles src/ TypeScript on the fly (resolving `@/lib/*`
                                   imports), provides the `next/server` stub and `importSource()` /
                                   `importDoh()` loaders, including fresh instances for config tests
scripts/lib/dns-fixtures.mjs       Test helper: shared DNS name/query/response builders (including the oversized
                                   response) and the `dnsAnswer()` upstream response for every suite
scripts/lib/mock-upstream.mjs      Local mock DoH upstream, `startMockUpstream()` (integration suite and Docker smoke test)
scripts/docker-smoke-test.mjs      Docker smoke test shared by ci.yml and docker-publish.yml: runs the image
                                   against the mock upstream and requires a real DoH answer
.github/workflows/ci.yml           CI: lint, type check, unit tests, build, integration tests, Docker
                                   DoH smoke test, lockfile-only audit
.github/workflows/docker-publish.yml  Image build/publish to GHCR (manual or on `v*` tags), gated on
                                   lint/type check/unit tests and a Docker DoH smoke test
.github/workflows/npm.yml          Manual full package-lock.json regeneration, verified before commit
.github/workflows/Keep-Alive.yml   Scheduled (03:17 UTC on the 1st and 15th) commit that rewrites keep-alive.txt,
                                   so GitHub does not disable scheduled workflows after 60 days of inactivity
keep-alive.txt                     Timestamp file written by Keep-Alive.yml
.gitattributes, .gitignore         LF normalization (source, the preload and the Docker files) and ignore rules
Dockerfile, .dockerignore          Self-hosted standalone build (the ignore file keeps tests and tooling out of
                                   the build context)
next.config.ts                     Security headers, standalone output outside Vercel/Netlify, build
                                   platform and version markers, 4097-byte proxy body cap, image
                                   optimizer disabled
netlify.toml                       Pins Node.js 22 for Netlify builds
package.json, package-lock.json    Dependencies, scripts, `engines` (Node.js >=22)
tsconfig.json, eslint.config.mjs,  TypeScript, ESLint and Tailwind/PostCSS configuration
postcss.config.mjs
LICENSE                            GNU AGPL-3.0
CHANGELOG.md                       Release history
```

## Runtime architecture

```text
Client
  |
  +--> Node.js `src/proxy.ts`
  |      |
  |      +--> match `/api/doh/*` (OPTIONS and HEAD pass through unlimited)
  |      +--> identify the client: trusted header (TRUST_PROXY_HEADERS=1, default; honored
  |      |    only from a TRUSTED_PROXIES peer when the socket address is known)
  |      |    or TCP socket address (TRUST_PROXY_HEADERS=0, via the socket-IP preload)
  |      +--> enforce 100 requests / rolling 60 seconds per client (RATE_LIMIT_PER_MINUTE), in both modes
  |      +--> return 429 (with CORS headers and Retry-After) when exceeded
  |      |
  |      +--> continue to the Next.js Route Handler with the client key in a private header
  |
  +--> GET/POST /api/doh/dns-query
  |      |
  |      +--> HEAD/OPTIONS -> 204 (no upstream work, no in-flight slot)
  |      +--> enforce 32-request (8 per client IP) in-flight ceiling
  |      |      +--> return 503 when a ceiling is reached
  |      +--> validate DNS wire message
  |      +--> select rotated HaGeZi order (per client by default)
  |      +--> sequential upstream fetch (aborted immediately if the client disconnects)
  |      +--> skip upstreams whose circuit breaker is open (all open: one probe per upstream)
  |      +--> upstream 400/413/414/415 -> relayed at once (no failover)
  |      +--> validate response + match ID/Question
  |      +--> return application/dns-message
  |
  +--> GET/POST /api/doh/<provider>/dns-query
         |
         +--> unknown provider id -> 404 (answered by the router, no handler code runs)
         +--> HEAD/OPTIONS -> 204 (no upstream work, no in-flight slot)
         +--> enforce 32-request (8 per client IP) in-flight ceiling
         |      +--> return 503 when a ceiling is reached
         +--> validate DNS wire message
         +--> use one fixed provider upstream (no failover; aborted immediately if the client disconnects)
         +--> validate response + match ID/Question
         +--> return application/dns-message
```

The implementation is intentionally small: there is no server-side DNS cache (for GET, an upstream `max-age` minus its `Age` may be relayed as `private, max-age=N`, capped at 300 s, so clients can cache) and no arbitrary proxy target. Public DoH requests use fixed upstreams, bounded message handling, sequential failover, a process-local request-rate limit, and a process-local in-flight ceiling.

## API behavior

The proxy implements the RFC 8484 DoH request format:

- **GET** uses the `dns` query parameter containing a base64url-encoded DNS wire message. Correctly sized optional `=` padding is accepted and stripped before the query is forwarded upstream; missing-required or extra padding is rejected.
- **POST** uses the raw DNS wire message with `Content-Type: application/dns-message`. Any supplied `Content-Length` must contain decimal digits only; the proxy rejects invalid numeric spellings before reading or forwarding the body.
- **HEAD** and **OPTIONS** return `204` for health checks and CORS preflight. Neither is rate limited.
- Unsupported methods return `405`: the route files only export GET, POST, HEAD and OPTIONS, so the Next.js router answers other methods itself.
- An unknown provider id on `/api/doh/<provider>/dns-query` returns `404` from the router (`generateStaticParams()` + `dynamicParams = false`).
- The rate limiter in `src/proxy.ts` runs before routing. Every request under `/api/doh/` except `HEAD` and `OPTIONS` counts against the client's budget, including unsupported methods and unknown provider ids, and once the budget is spent those get `429` instead of `405` or `404`.
- Responses from the DoH handler carry permissive CORS headers (`Access-Control-Allow-Origin: *`, methods `GET, POST, HEAD, OPTIONS`, headers `Accept, Content-Type, Cache-Control`, exposed header `Retry-After`, preflight cache `Access-Control-Max-Age: 86400`). The `429` returned by the rate limiter carries the same CORS headers (from `src/lib/cors.ts`) plus `Cache-Control: no-store` and `Retry-After`.
- Successful answers carry an explicit `Content-Length` (Next.js would otherwise use chunked encoding).
- Upstream requests are sent with `User-Agent: FreeDNS-DoH/<version>` (`PROXY_VERSION`), `Accept: application/dns-message`, `cache: no-store` and `redirect: error`.

Status codes returned by the proxy itself (error bodies are `text/plain`; a successful answer is `application/dns-message`; `204` has no body):

| Status | When |
|---|---|
| `200` | Valid, matching upstream answer relayed. |
| `204` | `HEAD` or `OPTIONS` on a known route (no upstream work). |
| `400` | `dns` parameter missing, repeated or not valid base64url; malformed DNS message; POST without a body, with a `Content-Length` that is not a decimal integer or is below 12, or whose body stream fails mid-read (for example an aborted upload; body `Request body error`). |
| `404` | Unknown provider id on `/api/doh/<provider>/dns-query`. |
| `405` | Method other than GET, POST, HEAD, OPTIONS. |
| `408` | Request (headers and body) not fully received within 10 seconds, or headers within 5 seconds. Answered by Node.js itself through the timeouts set by `server/socket-ip-preload.cjs` (see the transport bullets under "Request handling is bounded"). The route's own 1 second body deadline only applies where no request buffering happens in front of it. |
| `413` | POST body (declared or streamed) larger than 4 KiB. |
| `414` | GET query string longer than 8192 characters. |
| `415` | POST `Content-Type` is not `application/dns-message`. |
| `429` | Per-client rate limit exceeded (returned by `src/proxy.ts`, with `Retry-After` and CORS headers). |
| `503` | In-flight ceiling reached (global or per client IP), with `Retry-After: 1`. |
| 4xx/5xx | Upstream `400`, `413`, `414` or `415`, relayed at once; otherwise the last non-retryable upstream rejection. Both use the body `DNS upstream rejected request` (see below). |
| `502` | No upstream produced a valid answer (`DNS upstream unavailable`), including when every upstream's circuit breaker is open and each already has a probe in flight. |

Request handling is bounded:

- Client queries are capped at **4 KiB** (`MAX_DNS_MESSAGE_SIZE = 4096`); upstream responses at **64 KiB** (`MAX_DNS_RESPONSE_SIZE = 65535`, the RFC 8484 maximum) so DNSSEC and large TXT answers, which routinely exceed 4 KiB, still work. Anything larger is rejected instead of being buffered without a bound.
- GET query strings are capped at **8192 characters**.
- POST bodies are read as a stream with a running 4 KiB cap; the read is aborted as soon as the cap or the request deadline is exceeded. A body stream that errors (for example because the client aborted the upload) is answered with `400` rather than escaping the handler as an unhandled error. Best-effort cancellation is bounded and cannot override the intended response if a stream’s `cancel()` throws synchronously or rejects.
- Upstream response bodies are read the same way (64 KiB cap plus the upstream deadline), and a negative or non-decimal declared `Content-Length` is rejected outright.
- Client disconnects abort the upstream fetch immediately: each attempt combines its deadline `AbortController` with `request.signal` via `AbortSignal.any`, so a gone client frees its in-flight slot at once instead of at the deadline, and the failover loop stops without counting the disconnect as an upstream failure. The deadline is deliberately an `AbortController` with a cleared timer, not `AbortSignal.timeout()`: a timeout signal referenced only through `AbortSignal.any()` can be garbage-collected and then never fires (a regression test runs with `--expose-gc`).
- Responses are structurally validated (backward-only compression pointers, per-type RDATA name decoding, transaction-ID matching). Rare-but-legal QDCOUNT=0 responses are accepted — the transaction ID is still verified — while question QNAME compression in responses is rejected (there is no earlier name to point at).
- With `src/proxy.ts` in front of the route, Next.js buffers the whole request body before the handler runs, so the handler's 1 second body deadline cannot see a slow upload. The transport is bounded instead:
  - `experimental.proxyClientMaxBodySize` in `next.config.ts` caps that buffer at **4097 bytes**, one byte over the 4 KiB query cap. The Next.js default is 10 MB.
  - Next.js drops the whole chunk that crosses the cap. The preload therefore splits that chunk exactly at the cap, so an oversized body reaches the handler as 4097 bytes and is still answered `413`, even when it starts with a valid query.
  - The preload gives servers created with `http.createServer()` a 10 second `requestTimeout`, a 5 second `headersTimeout` and a 1 second check interval (Node.js defaults: 300 s, 60 s, 30 s). An explicitly `undefined` timeout property is treated as absent, so these defaults still apply. A client that trickles its request gets `408` from Node.js after about 10 seconds.
  - Managed platforms do not run the preload. There, a body sent with a `Content-Length` over 4 KiB is still rejected with `413`, but an oversized chunked body may reach the handler truncated to a shorter prefix.
  - Also cap request bodies and time at the reverse proxy (for example nginx `client_max_body_size` and `client_body_timeout`).
- Both routes use a **2.5 second** application deadline (`DEFAULT_TIMEOUT_MS`), inside the 5 second route `maxDuration`. Deadline accounting and the POST-body read budget use the monotonic `performance.now()` clock, so wall-clock corrections cannot prematurely stop failover or extend request handling.
- Per-attempt upstream timeouts are bounded so one failed resolver cannot consume the whole request indefinitely.
- The remaining deadline is shared across the attempts still to come. The nominal failover slice is at least 750 ms.
- On the primary endpoint, any failed attempt (timeout, network error, non-200 status, wrong content type, invalid or mismatched DNS body) falls through to the next fixed upstream, with one exception: an upstream `400`, `413`, `414` or `415` describes the request itself, so it is relayed at once instead of replaying the same bad query to every upstream. If none answers, the last non-retryable upstream rejection status (4xx/5xx other than 408, 425, 429, 500, 502, 503, 504; for example `403` or `404`) is returned as `DNS upstream rejected request`; it is kept even if a later attempt times out or fails with a retryable status. A non-200 status outside 400-599 (for example `204`) is recorded as a `502` rejection and, if nothing else answers, returned as `502 DNS upstream rejected request`. Everything else (timeouts, network errors including blocked redirects, wrong content type, invalid, mismatched or oversized bodies, retryable statuses) ends as `502 DNS upstream unavailable`. Provider routes try exactly one upstream. The proxy never launches the full failover set concurrently.
- Failover stops (no further attempt is made) once less than 100 ms of the request deadline remains, so a slow client cannot make healthy upstreams look unhealthy.
- **Circuit breaker (primary endpoint only):** an upstream that accumulates 3 failures (timeout, network error, retryable status: 408, 425, 429, 500, 502, 503 or 504, or a `200` that is not `application/dns-message`, such as a captive portal or CDN error page), each within 30 seconds of the previous one and without an intervening success, is skipped for 30 seconds, after which one half-open probe is allowed. Isolated failures further apart than 30 seconds do not accumulate. The probe slot is reserved only when an attempt on that upstream actually starts, so a recovered upstream is not locked out when an earlier upstream answers first. Each probe carries an ownership token, so only the attempt that claimed it can release it (a request that skipped the upstream cannot clear another request's probe). A late failure or success from an older non-probe request cannot clear an active probe, close the breaker, or restart its cooldown; the probe's own result determines whether the breaker closes or re-opens. Every attempt reports back within the request deadline; a 5 second probe TTL exists only as a safety net. Cooldown, failure-window and probe-TTL accounting use monotonic `performance.now()` time, so wall-clock corrections cannot prematurely expire a cooldown or active probe lease. If every upstream is open, the set is still probed, but each upstream by at most one request at a time; concurrent requests that find every probe slot taken get `502` at once instead of piling onto dead upstreams. Non-retryable upstream statuses and invalid DNS bodies (which a crafted query can provoke) do not increment the breaker, and when they answer a half-open probe they release the slot immediately. Provider routes have a single upstream and keep no breaker state. State is per process.

DNS validation checks message size, header flags/opcode, exactly one Question in queries (responses may carry one Question or, rarely, none; see above), section boundaries, name encoding, backward compression pointers, and the complete message structure. Compression pointers may only target bytes validated as part of a domain name: the Question, record owner names and the names inside the RDATA of NS, MD, MF, CNAME, SOA, MB, MG, MR, PTR, MINFO, MX, RP, AFSDB, RT, PX, SRV, NAPTR, KX, DNAME and SVCB/HTTPS (a table-driven layout in `dns.ts`; the RFC 3597 types RP/AFSDB/RT/PX/SRV/NAPTR are included because receivers should decompress them, and the SVCB/HTTPS target name must be uncompressed, per RFC 9460). RDATA of every other type is opaque, so a pointer into it is rejected. Upstream responses must be `200 application/dns-message`, structurally valid, and match the original query transaction ID and, when present, the Question section before they are relayed.

## Primary upstreams

The server-owned HaGeZi list is compiled in under `src/lib/upstreams.ts`:

| Host | Location in source configuration | Purpose |
|---|---|---|
| `root.hagezi.org` | Falkenstein, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `wurzn.hagezi.org` | Nuremberg, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `juuri.hagezi.org` | Helsinki, Finland | Balanced protection with Multi Pro + Threat Intelligence Feed |

The starting position rotates, but each request still has a deterministic sequential failover order. `HAGEZI_ROTATION_MODE` picks the strategy:

| Mode | First choice | Trade-off |
|---|---|---|
| `client` (**default**) | Derived from a hash of the client key | Spreads load over all three resolvers while each client keeps a stable, cache-friendly first choice. Requests without a client key round-robin. |
| `request` | Round-robin per request | Most even spread; a client's queries hit different resolver caches. |
| `time` | Changes every `HAGEZI_ROTATION_SECONDS` (default 30 minutes) | Consistent across instances, but one resolver takes all traffic during a slot (the pre-2.10 default). |

## Request protection

### Client identity and rate limiting

Both trust modes enforce the same limit: **100 requests per rolling 60 seconds per client** (`RATE_LIMIT_PER_MINUTE`, default 100). The modes differ only in how the client is identified.

| `TRUST_PROXY_HEADERS` | Client identity | Use when |
|---|---|---|
| `1` (**default**; also unset, empty, `true`, `yes`, `on`) | The trusted forwarding header (see below), falling back to the TCP socket address. When the socket address is known, the header is honored only if the TCP peer matches `TRUSTED_PROXIES` | Behind a platform edge or reverse proxy that overwrites the header on every request; also safe when exposed directly, with the default `TRUSTED_PROXIES` |
| `0` (also `false`, `no`, `off`, or any unrecognized value) | The TCP socket address only; every forwarding header is ignored | The app is exposed directly, or you do not trust what is in front of it |

The trusted header defaults to the one the platform edge sets itself, so a client cannot forge it:

| Platform (selected and inlined by `next.config.ts` at build time; runtime `VERCEL`/`NETLIFY` markers do not override it) | Default `CLIENT_IP_HEADERS` |
|---|---|
| Vercel | `x-real-ip`, then `x-forwarded-for` (Vercel overwrites both) |
| Netlify | `x-nf-client-connection-ip` |
| Self-hosted (Docker, `npm start`) | `x-forwarded-for` |

For `X-Forwarded-For`, the entry `TRUSTED_PROXY_HOPS` from the right is used (default `1`: the entry appended by the nearest proxy). With two trusted proxies in a chain (for example a CDN in front of nginx), set `TRUSTED_PROXY_HOPS=2`. If that entry is missing or not an IP, the request falls back to the socket address; it never falls back to a client-written entry. A Cloudflare-fronted deployment can set `CLIENT_IP_HEADERS=cf-connecting-ip` instead.

#### Trusted proxies

On self-hosted deployments (where the preload is loaded), `TRUSTED_PROXIES` decides which TCP peers may set the forwarding header. The default, `loopback,private`, trusts `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `fc00::/7`, which covers a reverse proxy on the same host, the Docker bridge network, and the usual private-network load balancers. A client that connects directly from a public address is keyed by that address, whatever `X-Forwarded-For` it sends, so it cannot rotate the header to mint new identities.

Entries are comma-separated bare IPs, CIDR ranges (IPv4 or IPv6), or the names `loopback`, `private` and `linklocal` (`169.254.0.0/16`, `fe80::/10`). Decorated forms such as ports, brackets and IPv6 scope IDs are not valid here and are ignored. Invalid entries are ignored; that includes an IPv4-mapped IPv6 range with a prefix above 32 (for example `::ffff:10.0.0.0/104`), because the address collapses to IPv4, so write it as `10.0.0.0/8`. `none` trusts no peer, and `*` trusts every peer (the behavior before 2.10; use it only if nothing can reach the app except through your proxy). If your proxy connects from a public address (for example a CDN directly in front of the container), list that CDN's ranges. Managed platforms do not run the preload, so the socket address is unknown there and the platform header is used as before.

The socket address comes from `server/socket-ip-preload.cjs`, loaded with `node --require` by `npm start` and by the Docker image. It overwrites a private `x-doh-socket-ip` header on every request, and the app only honors that header in processes that loaded the preload, so a client cannot inject it. Managed platforms do not run the preload: there, keep `TRUST_PROXY_HEADERS=1` (the platform header is the client address). If trust is disabled on such a platform, no per-client address exists and those requests share one bucket with the same limit.

Client keys are normalized: valid ports and brackets are removed, and nonempty IPv6 scope IDs are accepted and removed only on IPv6 literals (malformed or IPv4 zone suffixes are rejected). IPv4-mapped IPv6 collapses to IPv4, and IPv6 clients are keyed by /64. `src/proxy.ts` resolves the key once and hands it to the route in a private `x-doh-client-key` header (always overwritten or removed, so it cannot be injected), which the route uses for the per-client in-flight cap.

### Protection layers

The application uses two process-local protections before expensive upstream work begins.

The first is the rate limiter in `proxy.ts`: a **sliding-window counter** (the previous minute's count is weighted by its remaining overlap, so there is no 2x burst at window boundaries), tracked in an in-memory map capped at 10,000 client keys (the oldest bucket is evicted first). It applies to GET and POST on `/api/doh/*`. CORS preflights (`OPTIONS`) and health checks (`HEAD`) are not limited: both are answered with `204` and do no upstream work, browsers cannot read a failed preflight, and a monitor behind the same NAT or edge address as real users must not use up their budget. Requests over the limit receive `429 Too Many Requests` with an exact `Retry-After` and CORS headers. The limiter is driven by a monotonic clock (`performance.now()`), not the wall clock, so an NTP step or a VM resume can neither reset the budgets nor freeze the windows (a forward step on a wall-clock source would stall every window until real time caught up). Windows are therefore aligned to process start rather than to the epoch.

The second is a **32-request in-flight ceiling** (at most 8 per client) in the DoH handler (HEAD/OPTIONS return before a slot is taken). Request bodies are bounded at the transport (4097-byte buffer, 10 second request timeout; see [API behavior](#api-behavior)), and upstream waits are bounded by the request deadline, so stalled clients cannot consume the whole Node.js process. Requests that arrive after the ceiling is reached receive `503 Service Unavailable` with `Retry-After: 1` rather than waiting in an unbounded queue.

The in-flight ceilings, circuit breakers and request-rate limiter are process-local (on serverless hosts such as Vercel or Netlify each instance has its own copy, so treat them as best-effort and use a platform WAF for hard limits). Platform-level WAF, firewall, connection, or traffic controls can still provide cross-instance protection when required.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | Per-client request limit per rolling 60 s, enforced by `proxy.ts` in both trust modes. Values must contain decimal digits and be a positive integer; other formats are ignored. | `100` |
| `TRUST_PROXY_HEADERS` | Client identity source (see [Client identity and rate limiting](#client-identity-and-rate-limiting)). Unset, empty, `1`, `true`, `yes` or `on` (case-insensitive): trusted forwarding header, falling back to the socket address. `0`, `false`, `no`, `off` or any unrecognized value: socket address only. | `1` (enabled) |
| `CLIENT_IP_HEADERS` | Comma-separated header names to trust for the client address, tried in order (case-insensitive). Overrides the platform default. Only used while trust is enabled. | Vercel: `x-real-ip,x-forwarded-for`; Netlify: `x-nf-client-connection-ip`; otherwise `x-forwarded-for` |
| `TRUSTED_PROXIES` | Comma-separated TCP peers allowed to set the client-IP header: IPs, CIDRs, `loopback`, `private`, `linklocal`, `none` or `*` (see [Trusted proxies](#trusted-proxies)). Only checked where the socket address is known (preload loaded); empty or unset uses the default. | `loopback,private` |
| `TRUSTED_PROXY_HOPS` | Which `X-Forwarded-For` entry to use, counted from the right (the number of trusted proxies that append to it). Decimal-digit values are clamped to 1–16; other formats fall back to `1`. | `1` |
| `HAGEZI_UPSTREAM_ENDPOINTS` | Comma-separated DoH endpoint URLs that replace the built-in HaGeZi list (operator-set, never request-controlled). Entries are trimmed, and ones that are not valid `http(s)` URLs are ignored; with no valid entry the built-in list is used. The list is used as given (no rotation). A query string on an entry (e.g. `?token=...`) is preserved on GET requests; a `#fragment` is dropped. The homepage is informational: it still lists the compiled-in resolvers and does not reflect this override. Used by the integration suite and the CI Docker smoke test. | built-in list |
| `HAGEZI_ROTATION_MODE` | Primary HaGeZi rotation strategy, case-insensitive: `client` (stable per-client first choice), `request` (round-robin per request) or `time` (time slot; see [Primary upstreams](#primary-upstreams)). Any other value uses `client`. | `client` |
| `HAGEZI_ROTATION_SECONDS` | Slot length for `HAGEZI_ROTATION_MODE=time`. Decimal-digit values are clamped to 60–86400 seconds; other formats fall back to the default. | `1800` |
| `NEXT_PUBLIC_SITE_URL` | Public origin used by the homepage and metadata when explicitly set. Accepts a full URL (the scheme is case-insensitive; only the origin is kept, so a path or query is dropped) or a bare host such as `dns.example.com` (`https://` is assumed). A value with any other scheme (for example `ftp://`) is ignored and the next source below is used. **Build-time only** (the homepage is statically generated); for Docker pass it as `--build-arg`. | derived from the platform (Netlify `URL`, or `DEPLOY_PRIME_URL` on non-production deploys; Vercel `VERCEL_PROJECT_PRODUCTION_URL`, or `VERCEL_URL` on previews), else `http://localhost:3000`; Docker image: `http://localhost:8367` |

All runtime variables above are parsed once at startup by `src/lib/config.ts`; restart the process to apply a change. The provider endpoints and HaGeZi endpoint URLs are source-controlled in `src/lib/providers.ts` and `src/lib/upstreams.ts`. The only runtime override is the operator-set `HAGEZI_UPSTREAM_ENDPOINTS`; nothing is configurable through request parameters.

## Security and privacy

- The application does not contain query-content logging code.
- GET requests place the encoded DNS message in the URL. Hosting, reverse-proxy, or access logs outside the application can therefore potentially record the URL. Use POST when avoiding DNS data in URL paths matters.
- Only fixed upstream URLs are forwarded (compiled in, or set by the operator at startup through `HAGEZI_UPSTREAM_ENDPOINTS`); request-supplied upstream targets and redirects are not supported.
- The configured client-IP header is trusted by default (disable with `TRUST_PROXY_HEADERS=0`), but on self-hosted deployments only when the TCP peer is in `TRUSTED_PROXIES` (default: loopback and private ranges). Behind a platform edge or a reverse proxy this gives accurate per-client limits. On a directly exposed instance, a public client's forged header is ignored and its socket address is used instead (same 100/min limit).
- The image optimizer is disabled (`images: { unoptimized: true }`); the app never uses `next/image`, so the optimizer endpoint and its `sharp` code path are not reachable.
- Request and response sizes are explicitly bounded to keep memory use predictable.
- Response validation rejects malformed or mismatched DNS answers before relay.
- GET DoH responses relay a usable upstream `Cache-Control: max-age=N`, minus the upstream `Age`, as `private, max-age=N`, capped at 300 seconds. POST and error responses use `Cache-Control: no-store`. The proxy does not implement an application DNS cache.
- The strict document CSP is applied only to the homepage. Every route (API included) gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy` and `Cross-Origin-Resource-Policy: cross-origin`; the `X-Powered-By` header is disabled. A CSP has no effect on `application/dns-message` bodies.
- A public DoH service can still consume significant bandwidth under abuse, so platform or gateway traffic controls remain important.

## Deployment

### Managed Next.js hosting

The DoH route handlers and `proxy.ts` run on the **Node.js runtime**. Deploy the repository using the platform's normal Next.js integration and configure any platform-level WAF/rate limiting as an additional outer layer when needed.

`netlify.toml` pins `NODE_VERSION = 22` to match the Dockerfile and `package.json` `engines`. On Vercel/Netlify the build does not use standalone output.

Keep the default `TRUST_PROXY_HEADERS=1` on Vercel and Netlify. The build detects the platform and trusts the header that platform's edge sets itself (`x-real-ip` on Vercel, `x-nf-client-connection-ip` on Netlify), so forged client headers are not used as identity. Managed platforms do not load the socket-IP preload, so `TRUST_PROXY_HEADERS=0` there leaves no per-client address and all requests share one bucket. Limits remain per instance on these platforms, so treat them as best-effort and add a platform WAF for hard limits.

Verify:

```text
HEAD /api/doh/dns-query -> 204
```

### Docker (self-hosted)

```bash
docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

The defaults are safe for a container published directly: public clients connect from public addresses, which are not in the default `TRUSTED_PROXIES`, so each one is limited by its socket address (100 requests/minute; see [Client identity and rate limiting](#client-identity-and-rate-limiting)). Behind nginx or Caddy on the same host, keep the defaults and make the proxy append the client address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`); it connects through the Docker bridge, which is a private range. If a public CDN connects to the container directly, add its ranges to `TRUSTED_PROXIES`.

On some setups (for example Docker Desktop, or when Docker's userland proxy handles the connection) every client appears to connect from the bridge gateway, a private address. That peer is trusted by default, so a client that sends no `X-Forwarded-For` header is keyed by the gateway address and all such clients share one bucket, while a client that rotates the header can mint identities and avoid the limit. Prefer `--network host`, or put a reverse proxy in front that sets `X-Forwarded-For`. `-e TRUSTED_PROXIES=none` closes the forgery hole (forwarding headers are ignored) but keeps every client in the one shared gateway bucket, so a single heavy client can then use up the limit for everyone.

The image listens on IPv4 (`HOSTNAME=0.0.0.0`). On an IPv6-enabled Docker network, add `-e HOSTNAME=::` for dual-stack.

The Docker image (`node:22-alpine`, non-root `node` user, `NODE_OPTIONS=--max-old-space-size=320`, `PORT=8367`) uses Next.js standalone output, has a `HEALTHCHECK` that sends `HEAD /api/doh/dns-query` and expects `204` (this exercises the proxy and the DoH route without upstream traffic, and is not rate limited), and starts the generated server with the socket-IP preload:

```text
node --require ./socket-ip-preload.cjs server.js
```

The `Docker Build and Publish` workflow runs on demand and on `v*` tags. It runs lint, type check and unit tests first, then builds the image locally and runs the same DoH smoke test as CI (`scripts/docker-smoke-test.mjs`) before pushing. A `v*` tag publishes the semver tags (`2.10.0`, `2.10`, `2`) and moves `latest`. A manual run publishes only the branch name and the short commit SHA, so it never overwrites `latest`. The workflow passes the repository variable `NEXT_PUBLIC_SITE_URL` as the build argument and falls back to `http://localhost:8367` when it is unset. All actions in every workflow are pinned to commit SHAs.

`next.config.ts` uses standalone output unless the `VERCEL` or `NETLIFY` environment variable is set, so managed Vercel/Netlify builds use their native Next.js output handling. `NEXT_PUBLIC_SITE_URL` is inlined at build time, so it must be passed as a build argument.

For a self-hosted build outside Docker, either run `npm start` (which runs `next start` with the socket-IP preload; Next.js warns that standalone output is meant for `server.js`, but serves normally), or run the generated server the way the Dockerfile does: copy `.next/static` to `.next/standalone/.next/static` and `server/socket-ip-preload.cjs` into `.next/standalone/`, then `node --require ./socket-ip-preload.cjs server.js` from that directory. Without the preload, `TRUST_PROXY_HEADERS=0` has no per-client address.

## Development

```bash
npm install
npm run dev
```

Requires Node.js 22 or newer (`engines` in `package.json`).

See [`CHANGELOG.md`](CHANGELOG.md) for release history. `PROXY_VERSION` (the upstream `User-Agent` version) comes from `package.json`: `next.config.ts` inlines only the version string, as `DOH_PROXY_VERSION`.

Useful commands:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run test:integration   # after npm run build
```

`npm test` runs eight node:test suites (with `--expose-gc`, for the deadline regression test): mock-server harness error handling (`scripts/test-harness.mjs`: an occupied port rejects promptly), DNS parser/response-validation (`scripts/test-dns.mjs`), RR-type-aware RDATA validation (`scripts/test-dns-rdata.mjs`), DoH runtime behavior (`scripts/test-doh.mjs`: failover, timeouts, circuit breakers including probe ownership, the failure window and single probes when every breaker is open, request-rejection relay, GET/POST validation, redirect and content-type handling, response-size caps, cache-control and `Age` handling, version and route-deadline checks), in-flight capacity (`scripts/test-capacity.mjs`), the proxy in both trust modes, including HEAD/OPTIONS exemption, forged headers from a public peer and immunity to wall-clock steps (`scripts/test-proxy.mjs`), the sliding-window limiter (`scripts/test-rate-limit.mjs`) and configuration and client identity (`scripts/test-config.mjs`: every environment variable, platform defaults, header/hop selection, `TRUSTED_PROXIES` matching, socket fallback, IP normalization, all three rotation modes, upstream overrides, `NEXT_PUBLIC_SITE_URL` parsing, the body cap and the preload timeouts). The suites transpile the real `src/` TypeScript on the fly through `scripts/lib/transpile-source.mjs`, which resolves `@/lib/*` imports, supplies the `next/server` stub, sets `DOH_PROXY_VERSION` from `package.json`, and can load fresh module instances after changing `process.env` (configuration is read once per instance). They share the builders in `scripts/lib/dns-fixtures.mjs` and do not require a Next.js build. `typescript` (a dev dependency) must be installed for this helper to work.

`npm run test:integration` (`scripts/test-integration.mjs`) is separate: it needs `npm run build` first, starts the production server with `next start` and the socket-IP preload (like `npm start`) against the local mock upstream in `scripts/lib/mock-upstream.mjs` (via `HAGEZI_UPSTREAM_ENDPOINTS`), and checks GET/POST, content types, `Content-Length`, body-size caps (including a chunked body over the 4097-byte buffer that starts with a valid query), a slow upload, the 10 second transport timeout (`408`), upstream failure, router 404s for unknown providers, HEAD not being rate limited, and the per-client rate limit in both trust modes (including forged headers with `TRUST_PROXY_HEADERS=0`, with `TRUSTED_PROXIES=none`, and from a second source address) over real HTTP. The timeout case makes the suite take about 10 seconds longer.

CI (`.github/workflows/ci.yml`) runs on every push and pull request to `main`: lint, type check, `npm test`, build, the integration suite, a Docker image build with a smoke test that sends a real DoH query to the container, and a separate lockfile-only `npm audit` job (production dependencies gate the build; the full audit is advisory). The smoke test is `node scripts/docker-smoke-test.mjs <image>`; it can also be run locally, but it needs `docker run --network host` (Linux) and free ports 18053 and 18367, it removes a stale container of the same name (`doh-proxy`) from an interrupted run before starting, and it always removes its container and mock upstream afterwards. The manual `Update package-lock.json` workflow regenerates the lockfile from scratch, checks the `@next/swc-*` platform binaries are present, and runs lint, type check, tests and build before committing. Pushes made with `GITHUB_TOKEN` do not trigger other workflows, so run CI on that commit manually.

The project currently stays on the TypeScript 6.x line through the `package.json` dependency range; move to a newer major only alongside compatible Next.js ESLint tooling. ESLint is pinned to `^9` because the plugins pulled in by `eslint-config-next` (`import`, `jsx-a11y`, `react`) declare peer support only up to ESLint 9; move to ESLint 10 once they support it.

## Validation checklist

The repository includes automated checks for:

```text
✓ DNS query/response structure and message-type validation
✓ Compression-pointer direction and target validation
✓ DNS name expansion length bounds
✓ Response transaction-ID and Question matching, including case-insensitivity
✓ parseQuery input immutability for Node Buffer views (0x20 preservation)
✓ Queries up to 4 KiB and responses up to 65535 bytes
✓ RR-type-aware RDATA validation (valid compression targets, uncompressed SVCB/HTTPS targets)
✓ DoH GET/POST validation, correct optional base64url padding and rejection of malformed padding before upstream fetch
✓ Upstream redirect blocking, content-type validation and response validation
✓ Upstream response size cap (declared and streamed) with continued failover
✓ Errored upstream response streams release their reader lock before failover
✓ POST body stream failure answered with 400; synchronous cancellation errors do not hide the 413 response
✓ Request and POST-body deadlines are immune to wall-clock adjustments
✓ Sequential failover, retryable-status handling and bounded timeouts
✓ Circuit-breaker open/half-open behavior, monotonic cooldown/failure-window/probe-TTL timing, probe reservation only on real attempts, probe ownership tokens and immunity to wall-clock jumps and late non-probe results
✓ One probe per upstream when every breaker is open; wrong content type counts as a failure
✓ Upstream 400/413/414/415 relayed without failover
✓ Breaker failure window (isolated failures do not trip it) and no breaker state on provider routes
✓ Upstream deadline still fires after garbage collection
✓ GET max-age relay (minus Age) and POST no-store behavior
✓ Global/per-client in-flight ceilings
✓ 100 requests/minute per client with TRUST_PROXY_HEADERS=1 and =0 (unit and real HTTP)
✓ Client identity: platform default headers, CLIENT_IP_HEADERS, TRUSTED_PROXY_HOPS, TRUSTED_PROXIES, socket-address fallback
✓ Malformed, overlong and out-of-range client-IP entries are rejected rather than accepted as valid prefixes
✓ Socket-IP preload preserves `http.createServer()` listener overloads and native server-event argument lists
✓ Forged forwarding, socket-IP and client-key headers ignored
✓ OPTIONS and HEAD not rate limited; 429 carries CORS headers and an exact Retry-After
✓ Transport bounds: 4097-byte body buffer (oversized bodies still 413), 10 s request timeout (408)
✓ Half-open probe slot released after a non-retryable or invalid upstream answer
✓ GET requests preserve an existing query string on the upstream endpoint
✓ HAGEZI_UPSTREAM_ENDPOINTS override and HAGEZI_ROTATION_MODE (client/request/time) and SECONDS handling
✓ Sliding-window limiter: no boundary burst, expiry, capacity eviction and clock rollback handling
✓ Limiter clock is monotonic: wall-clock steps (forward or back) neither reset nor freeze budgets
✓ NEXT_PUBLIC_SITE_URL: mixed-case scheme, bare host, host:port and non-http schemes
✓ Unknown provider ids answered 404 by the router; Content-Length on answers
✓ Docker image answers a real DoH query through the standalone server and socket-IP preload (CI and publish workflow)
✓ PROXY_VERSION taken from package.json and route deadline checks
```

For deployment, also verify the live endpoint with a real DoH client. The repository's automated tests use mocked upstreams and do not prove external resolver availability or platform-level rate limiting.

## Endpoint examples

Use the domain where you deployed this project:

```text
https://<your-domain>/api/doh/dns-query
```

Provider-specific routes follow the same pattern, for example:

```text
https://<your-domain>/api/doh/cloudflare/dns-query
```

The examples above use a placeholder deployment hostname; service-specific live endpoints may be listed separately when intentionally maintained.

## Repository

https://github.com/anT0ny54/doh_proxy

## 🔗 Related projects (not part of this repository)

The services below are maintained separately and are **not** part of this repository, its build pipeline, or its release cycle. They are listed here for convenience only.

### 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

### ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
