# FreeDNS DoH Proxy

A lightweight DNS-over-HTTPS (DoH) proxy built with the Node.js runtime, using the Next.js 16, React 19, Tailwind CSS 4, and TypeScript 6 dependency lines declared in `package.json` (Node.js 22 or newer). The service is designed around a small, fixed upstream set, bounded request/response handling, sequential failover with per-upstream circuit breakers, and process-local overload protection.

## What this project provides

The project exposes a public DoH service and a small homepage. The proxy never accepts a request-supplied upstream URL: the provider upstreams are compiled into the application, and so is the primary HaGeZi list unless the operator pins their own resolvers at startup with `HAGEZI_UPSTREAM_ENDPOINTS` (see [Configuration](#configuration)).

### Primary DoH endpoint

```text
https://<your-domain>/api/doh/dns-query
```

The primary endpoint uses a rotating set of three server-owned HaGeZi DoH resolvers. Requests are attempted sequentially, with a bounded timeout and failover inside the request deadline.

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
server/socket-ip-preload.cjs       `node --require` preload that records the TCP peer address for the
                                   rate limiter (loaded by `npm start` and the Docker image)
scripts/lib/transpile-source.mjs   Test helper: transpiles src/ TypeScript on the fly (resolving `@/lib/*`
                                   imports), provides the `next/server` stub and `importSource()` /
                                   `importDoh()` loaders, including fresh instances for config tests
scripts/lib/dns-fixtures.mjs       Test helper: shared DNS name/query/response builders for every suite
scripts/lib/mock-upstream.mjs      Local mock DoH upstream (integration suite and CI Docker smoke test)
.github/workflows/ci.yml           CI: lint, type check, unit tests, build, integration tests, Docker
                                   DoH smoke test, lockfile-only audit
.github/workflows/docker-publish.yml  Image build/publish to GHCR (manual or on `v*` tags), gated on
                                   lint/type check/unit tests
.github/workflows/Keep-Alive.yml   Keep-alive commit on the 1st and 15th of each month (updates keep-alive.txt)
.github/workflows/npm.yml          Manual full package-lock.json regeneration, verified before commit
keep-alive.txt                     Timestamp rewritten by the keep-alive workflow
.gitattributes, .gitignore         LF normalization and ignore rules
Dockerfile, .dockerignore          Self-hosted standalone build
next.config.ts                     Security headers, standalone output outside Vercel/Netlify, build
                                   platform marker, image optimizer disabled
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
  |      +--> match `/api/doh/*` (OPTIONS passes through unlimited)
  |      +--> identify the client: trusted header (TRUST_PROXY_HEADERS=1, default)
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
  |      +--> select rotated HaGeZi order
  |      +--> sequential upstream fetch (aborted immediately if the client disconnects)
  |      +--> skip upstreams whose circuit breaker is open
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

- **GET** uses the `dns` query parameter containing a base64url-encoded DNS wire message. Optional `=` padding is accepted and stripped before the query is forwarded upstream.
- **POST** uses the raw DNS wire message with `Content-Type: application/dns-message`.
- **HEAD** and **OPTIONS** return `204` for health checks and CORS preflight.
- Unsupported methods return `405`: the route files only export GET, POST, HEAD and OPTIONS, so the Next.js router answers other methods itself.
- An unknown provider id on `/api/doh/<provider>/dns-query` returns `404` from the router (`generateStaticParams()` + `dynamicParams = false`).
- Responses from the DoH handler carry permissive CORS headers (`Access-Control-Allow-Origin: *`, methods `GET, POST, HEAD, OPTIONS`, headers `Accept, Content-Type, Cache-Control`, exposed header `Retry-After`, preflight cache `Access-Control-Max-Age: 86400`). The `429` returned by the rate limiter carries the same CORS headers (from `src/lib/cors.ts`) plus `Cache-Control: no-store` and `Retry-After`.
- Successful answers carry an explicit `Content-Length` (Next.js would otherwise use chunked encoding).
- Upstream requests are sent with `User-Agent: FreeDNS-DoH/<version>` (`PROXY_VERSION`), `Accept: application/dns-message`, `cache: no-store` and `redirect: error`.

Status codes returned by the proxy itself (error bodies are `text/plain`; a successful answer is `application/dns-message`; `204` has no body):

| Status | When |
|---|---|
| `200` | Valid, matching upstream answer relayed. |
| `204` | `HEAD` or `OPTIONS` on a known route (no upstream work). |
| `400` | `dns` parameter missing, repeated or not valid base64url; malformed DNS message; POST without a body, with a `Content-Length` that is not an integer or is below 12, or whose body stream fails mid-read (for example an aborted upload; body `Request body error`). |
| `404` | Unknown provider id on `/api/doh/<provider>/dns-query`. |
| `405` | Method other than GET, POST, HEAD, OPTIONS. |
| `408` | POST body not received within 1 second (or the request deadline, if shorter). |
| `413` | POST body (declared or streamed) larger than 4 KiB. |
| `414` | GET query string longer than 8192 characters. |
| `415` | POST `Content-Type` is not `application/dns-message`. |
| `429` | Per-client rate limit exceeded (returned by `src/proxy.ts`, with `Retry-After` and CORS headers). |
| `503` | In-flight ceiling reached (global or per client IP), with `Retry-After: 1`. |
| 4xx/5xx | Last non-retryable upstream rejection, relayed as `DNS upstream rejected request` (see below). |
| `502` | No upstream produced a valid answer (`DNS upstream unavailable`). |

Request handling is bounded:

- Client queries are capped at **4 KiB** (`MAX_DNS_MESSAGE_SIZE = 4096`); upstream responses at **64 KiB** (`MAX_DNS_RESPONSE_SIZE = 65535`, the RFC 8484 maximum) so DNSSEC and large TXT answers, which routinely exceed 4 KiB, still work. Anything larger is rejected instead of being buffered without a bound.
- GET query strings are capped at **8192 characters**.
- POST bodies are read as a stream with a running 4 KiB cap; the read is aborted as soon as the cap or the request deadline is exceeded. A body stream that errors (for example because the client aborted the upload) is answered with `400` rather than escaping the handler as an unhandled error.
- Upstream response bodies are read the same way (64 KiB cap plus the upstream deadline), and a negative or non-integer declared `Content-Length` is rejected outright.
- Client disconnects abort the upstream fetch immediately: each attempt combines its deadline `AbortController` with `request.signal` via `AbortSignal.any`, so a gone client frees its in-flight slot at once instead of at the deadline, and the failover loop stops without counting the disconnect as an upstream failure. The deadline is deliberately an `AbortController` with a cleared timer, not `AbortSignal.timeout()`: a timeout signal referenced only through `AbortSignal.any()` can be garbage-collected and then never fires (a regression test runs with `--expose-gc`).
- Responses are structurally validated (backward-only compression pointers, per-type RDATA name decoding, transaction-ID matching). Rare-but-legal QDCOUNT=0 responses are accepted — the transaction ID is still verified — while question QNAME compression in responses is rejected (there is no earlier name to point at).
- With `src/proxy.ts` in front of the route, Next.js may buffer a request body before the handler runs (the integration suite's slow-upload case accepts either `200` or `408` for that reason), so the streaming cap and the 1 second body deadline are the handler's own guard rather than a guarantee about the transport. Also cap request bodies at the reverse proxy (for example nginx `client_max_body_size`).
- Both routes use a **2.5 second** application deadline (`DEFAULT_TIMEOUT_MS`), inside the 5 second route `maxDuration`.
- Per-attempt upstream timeouts are bounded so one failed resolver cannot consume the whole request indefinitely.
- The remaining deadline is shared across the attempts still to come. The nominal failover slice is at least 750 ms, but an attempt is skipped when less than 100 ms remains.
- On the primary endpoint, any failed attempt (timeout, network error, non-200 status, wrong content type, invalid or mismatched DNS body) falls through to the next fixed upstream. If none answers, the last non-retryable upstream rejection status (4xx/5xx other than 408, 425, 429, 500, 502, 503, 504; for example `403` or `404`) is returned as `DNS upstream rejected request`; it is kept even if a later attempt times out or fails with a retryable status. A non-200 status outside 400-599 (for example `204`) is recorded as a `502` rejection and, if nothing else answers, returned as `502 DNS upstream rejected request`. Everything else (timeouts, network errors including blocked redirects, wrong content type, invalid, mismatched or oversized bodies, retryable statuses) ends as `502 DNS upstream unavailable`. Provider routes try exactly one upstream. The proxy never launches the full failover set concurrently.
- Failover stops (no further attempt is made) once less than 100 ms of the request deadline remains, so a slow client cannot make healthy upstreams look unhealthy.
- **Circuit breaker (primary endpoint only):** an upstream that accumulates 3 failures (timeout, network error or retryable status: 408, 425, 429, 500, 502, 503 or 504), each within 30 seconds of the previous one and without an intervening success, is skipped for 30 seconds, after which one half-open probe is allowed. Isolated failures further apart than 30 seconds do not accumulate. The probe slot is reserved only when an attempt on that upstream actually starts, so a recovered upstream is not locked out when an earlier upstream answers first. Each probe carries an ownership token, so only the attempt that claimed it can release it (a request that skipped the upstream cannot clear another request's probe). Every attempt reports back within the request deadline; a 5 second probe TTL exists only as a safety net. If every upstream is open, the set is still probed. Non-retryable upstream statuses and invalid/wrong-content-type responses do not increment the breaker, and when they answer a half-open probe they release the slot immediately. Provider routes have a single upstream and keep no breaker state. State is per process.

DNS validation checks message size, header flags/opcode, exactly one Question, section boundaries, name encoding, backward compression pointers, and the complete message structure. Compression pointers may only target bytes validated as part of a domain name: the Question, record owner names and the names inside the RDATA of NS, MD, MF, CNAME, SOA, MB, MG, MR, PTR, MINFO, MX, RP, AFSDB, RT, PX, SRV, NAPTR, KX, DNAME and SVCB/HTTPS (a table-driven layout in `dns.ts`; the RFC 3597 types RP/AFSDB/RT/PX/SRV/NAPTR are included because receivers should decompress them, and the SVCB/HTTPS target name must be uncompressed, per RFC 9460). RDATA of every other type is opaque, so a pointer into it is rejected. Upstream responses must be `200 application/dns-message`, structurally valid, and match the original query transaction ID and Question section before they are relayed.

## Primary upstreams

The server-owned HaGeZi list is compiled in under `src/lib/upstreams.ts`:

| Host | Location in source configuration | Purpose |
|---|---|---|
| `root.hagezi.org` | Falkenstein, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `wurzn.hagezi.org` | Nuremberg, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `juuri.hagezi.org` | Helsinki, Finland | Balanced protection with Multi Pro + Threat Intelligence Feed |

The starting position rotates periodically, but each request still has a deterministic sequential failover order. The default rotation interval is 30 minutes.

## Request protection

### Client identity and rate limiting

Both trust modes enforce the same limit: **100 requests per rolling 60 seconds per client** (`RATE_LIMIT_PER_MINUTE`). The modes differ only in how the client is identified.

| `TRUST_PROXY_HEADERS` | Client identity | Use when |
|---|---|---|
| `1` (**default**; also unset, empty, `true`, `yes`, `on`) | The trusted forwarding header (see below), falling back to the TCP socket address | Behind a platform edge or reverse proxy that overwrites the header on every request |
| `0` (also `false`, `no`, `off`, or any unrecognized value) | The TCP socket address only; every forwarding header is ignored | The app is exposed directly, or you do not trust what is in front of it |

The trusted header defaults to the one the platform edge sets itself, so a client cannot forge it:

| Platform (detected at build time) | Default `CLIENT_IP_HEADERS` |
|---|---|
| Vercel | `x-real-ip`, then `x-forwarded-for` (Vercel overwrites both) |
| Netlify | `x-nf-client-connection-ip` |
| Self-hosted (Docker, `npm start`) | `x-forwarded-for` |

For `X-Forwarded-For`, the entry `TRUSTED_PROXY_HOPS` from the right is used (default `1`: the entry appended by the nearest proxy). With two trusted proxies in a chain (for example a CDN in front of nginx), set `TRUSTED_PROXY_HOPS=2`. If that entry is missing or not an IP, the request falls back to the socket address; it never falls back to a client-written entry. A Cloudflare-fronted deployment can set `CLIENT_IP_HEADERS=cf-connecting-ip` instead.

The socket address comes from `server/socket-ip-preload.cjs`, loaded with `node --require` by `npm start` and by the Docker image. It overwrites a private `x-doh-socket-ip` header on every request, and the app only honors that header in processes that loaded the preload, so a client cannot inject it. Managed platforms do not run the preload: there, keep `TRUST_PROXY_HEADERS=1` (the platform header is the client address). If trust is disabled on such a platform, no per-client address exists and those requests share one bucket with the same limit.

Client keys are normalized: ports, brackets and IPv6 zone IDs are stripped, IPv4-mapped IPv6 collapses to IPv4, and IPv6 clients are keyed by /64. `src/proxy.ts` resolves the key once and hands it to the route in a private `x-doh-client-key` header (always overwritten or removed, so it cannot be injected), which the route uses for the per-client in-flight cap.

### Protection layers

The application uses two process-local protections before expensive upstream work begins.

The first is the rate limiter in `proxy.ts`: a **sliding-window counter** (the previous minute's count is weighted by its remaining overlap, so there is no 2x burst at window boundaries), tracked in an in-memory map capped at 10,000 client keys (the oldest bucket is evicted first). It applies to GET, POST and HEAD on `/api/doh/*`; CORS preflights (`OPTIONS`) are not limited, because they do no upstream work and browsers cannot read a failed preflight. Requests over the limit receive `429 Too Many Requests` with an exact `Retry-After` and CORS headers.

The second is a **32-request in-flight ceiling** (at most 8 per client) in the DoH handler (HEAD/OPTIONS return before a slot is taken). POST bodies must arrive within 1 second (or the request deadline, if shorter), and upstream waits are bounded by the request deadline, so stalled clients cannot consume the whole Node.js process. Requests that arrive after the ceiling is reached receive `503 Service Unavailable` with `Retry-After: 1` rather than waiting in an unbounded queue.

The in-flight ceilings, circuit breakers and request-rate limiter are process-local (on serverless hosts such as Vercel or Netlify each instance has its own copy, so treat them as best-effort and use a platform WAF for hard limits). Platform-level WAF, firewall, connection, or traffic controls can still provide cross-instance protection when required.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | Per-client request limit per rolling 60 s, enforced by `proxy.ts` in both trust modes. A value that is not a positive integer is ignored. | `100` |
| `TRUST_PROXY_HEADERS` | Client identity source (see [Client identity and rate limiting](#client-identity-and-rate-limiting)). Unset, empty, `1`, `true`, `yes` or `on` (case-insensitive): trusted forwarding header, falling back to the socket address. `0`, `false`, `no`, `off` or any unrecognized value: socket address only. | `1` (enabled) |
| `CLIENT_IP_HEADERS` | Comma-separated header names to trust for the client address, tried in order (case-insensitive). Overrides the platform default. Only used while trust is enabled. | Vercel: `x-real-ip,x-forwarded-for`; Netlify: `x-nf-client-connection-ip`; otherwise `x-forwarded-for` |
| `TRUSTED_PROXY_HOPS` | Which `X-Forwarded-For` entry to use, counted from the right (the number of trusted proxies that append to it). Clamped to 1–16. | `1` |
| `HAGEZI_UPSTREAM_ENDPOINTS` | Comma-separated DoH endpoint URLs that replace the built-in HaGeZi list (operator-set, never request-controlled). Entries are trimmed, and ones that are not valid `http(s)` URLs are ignored; with no valid entry the built-in list is used. The list is used as given (no rotation). A query string on an entry (e.g. `?token=...`) is preserved on GET requests; a `#fragment` is dropped. The homepage still lists the compiled-in resolvers. Used by the integration suite and the CI Docker smoke test. | built-in list |
| `HAGEZI_ROTATION_MODE` | Set to `request` (case-insensitive) to round-robin the primary HaGeZi resolver per request instead of per time slot. Any other value keeps time-slot rotation. | time slot |
| `HAGEZI_ROTATION_SECONDS` | Primary HaGeZi rotation interval. Values are clamped to 60–86400 seconds; non-numeric values fall back to the default. | `1800` |
| `NEXT_PUBLIC_SITE_URL` | Public origin used by the homepage and metadata when explicitly set. **Build-time only** (the homepage is statically generated); for Docker pass it as `--build-arg`. | derived from the platform (Netlify `URL`, or `DEPLOY_PRIME_URL` on non-production deploys; Vercel `VERCEL_PROJECT_PRODUCTION_URL`, or `VERCEL_URL` on previews), else `http://localhost:3000`; Docker image: `http://localhost:8367` |

All runtime variables above are parsed once at startup by `src/lib/config.ts`; restart the process to apply a change. The provider endpoints and HaGeZi endpoint URLs are source-controlled in `src/lib/providers.ts` and `src/lib/upstreams.ts`. The only runtime override is the operator-set `HAGEZI_UPSTREAM_ENDPOINTS`; nothing is configurable through request parameters.

## Security and privacy

- The application does not contain query-content logging code.
- GET requests place the encoded DNS message in the URL. Hosting, reverse-proxy, or access logs outside the application can therefore potentially record the URL. Use POST when avoiding DNS data in URL paths matters.
- Only fixed upstream URLs are forwarded (compiled in, or set by the operator at startup through `HAGEZI_UPSTREAM_ENDPOINTS`); request-supplied upstream targets and redirects are not supported.
- The configured client-IP header is trusted by default (disable with `TRUST_PROXY_HEADERS=0`). Behind a platform edge or a reverse proxy that overwrites it, this gives accurate per-client limits; on a directly exposed instance a client could forge it to mint a new identity, so set `TRUST_PROXY_HEADERS=0` there and the socket address is used instead (same 100/min limit).
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

If the container is published directly without a reverse proxy in front, add `-e TRUST_PROXY_HEADERS=0`: forwarding headers are then ignored and each client is limited by its socket address (still 100 requests/minute; see [Client identity and rate limiting](#client-identity-and-rate-limiting)). Behind nginx or Caddy on the same host, keep the default and make the proxy append the client address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

The Docker image (`node:22-alpine`, non-root `node` user, `NODE_OPTIONS=--max-old-space-size=320`, `PORT=8367`) uses Next.js standalone output, has a `HEALTHCHECK` on `/`, and starts the generated server with the socket-IP preload:

```text
node --require ./socket-ip-preload.cjs server.js
```

The `Docker Build and Publish` workflow runs on demand and on `v*` tags (which produce the semver image tags), runs lint, type check and unit tests first, passes the repository variable `NEXT_PUBLIC_SITE_URL` as the build argument and falls back to `http://localhost:8367` when it is unset.

`next.config.ts` uses standalone output unless the `VERCEL` or `NETLIFY` environment variable is set, so managed Vercel/Netlify builds use their native Next.js output handling. `NEXT_PUBLIC_SITE_URL` is inlined at build time, so it must be passed as a build argument.

For a self-hosted build outside Docker, either run `npm start` (which runs `next start` with the socket-IP preload; Next.js warns that standalone output is meant for `server.js`, but serves normally), or run the generated server the way the Dockerfile does: copy `.next/static` to `.next/standalone/.next/static` and `server/socket-ip-preload.cjs` into `.next/standalone/`, then `node --require ./socket-ip-preload.cjs server.js` from that directory. Without the preload, `TRUST_PROXY_HEADERS=0` has no per-client address.

## Development

```bash
npm install
npm run dev
```

Requires Node.js 22 or newer (`engines` in `package.json`).

See [`CHANGELOG.md`](CHANGELOG.md) for release history. `PROXY_VERSION` (the upstream `User-Agent` version) is read from `package.json`.

Useful commands:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run test:integration   # after npm run build
```

`npm test` runs seven node:test suites (with `--expose-gc`, for the deadline regression test): DNS parser/response-validation (`scripts/test-dns.mjs`), RR-type-aware RDATA validation (`scripts/test-dns-rdata.mjs`), DoH runtime behavior (`scripts/test-doh.mjs`: failover, timeouts, circuit breakers including probe ownership and the failure window, GET/POST validation, redirect and content-type handling, response-size caps, cache-control and `Age` handling, version and route-deadline checks), in-flight capacity (`scripts/test-capacity.mjs`), the proxy in both trust modes (`scripts/test-proxy.mjs`), the sliding-window limiter (`scripts/test-rate-limit.mjs`) and configuration and client identity (`scripts/test-config.mjs`: every environment variable, platform defaults, header/hop selection, socket fallback, IP normalization, rotation and upstream overrides). The suites transpile the real `src/` TypeScript on the fly through `scripts/lib/transpile-source.mjs`, which resolves `@/lib/*` imports, supplies the `next/server` stub and can load fresh module instances after changing `process.env` (configuration is read once per instance). They share the builders in `scripts/lib/dns-fixtures.mjs` and do not require a Next.js build. `typescript` (a dev dependency) must be installed for this helper to work.

`npm run test:integration` (`scripts/test-integration.mjs`) is separate: it needs `npm run build` first, starts the production server with `next start` and the socket-IP preload (like `npm start`) against the local mock upstream in `scripts/lib/mock-upstream.mjs` (via `HAGEZI_UPSTREAM_ENDPOINTS`), and checks GET/POST, content types, `Content-Length`, body-size caps, a slow upload, upstream failure, router 404s for unknown providers, and the per-client rate limit in both trust modes (including forged headers with `TRUST_PROXY_HEADERS=0` and a second source address) over real HTTP.

CI (`.github/workflows/ci.yml`) runs on every push and pull request to `main`: lint, type check, `npm test`, build, the integration suite, a Docker image build with a smoke test that sends a real DoH query to the container, and a separate lockfile-only `npm audit` job (production dependencies gate the build; the full audit is advisory). The manual `Update package-lock.json` workflow regenerates the lockfile from scratch, checks the `@next/swc-*` platform binaries are present, and runs lint, type check, tests and build before committing. Pushes made with `GITHUB_TOKEN` do not trigger other workflows, so run CI on that commit manually.

The project currently stays on the TypeScript 6.x line through the `package.json` dependency range; move to a newer major only alongside compatible Next.js ESLint tooling.

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
✓ DoH GET/POST validation and padded base64url handling
✓ Upstream redirect blocking, content-type validation and response validation
✓ Upstream response size cap (declared and streamed) with continued failover
✓ POST body stream failure answered with 400 (no unhandled error)
✓ Sequential failover, retryable-status handling and bounded timeouts
✓ Circuit-breaker open/half-open behavior, probe reservation only on real attempts, probe ownership tokens
✓ Breaker failure window (isolated failures do not trip it) and no breaker state on provider routes
✓ Upstream deadline still fires after garbage collection
✓ GET max-age relay (minus Age) and POST no-store behavior
✓ Global/per-client in-flight ceilings
✓ 100 requests/minute per client with TRUST_PROXY_HEADERS=1 and =0 (unit and real HTTP)
✓ Client identity: platform default headers, CLIENT_IP_HEADERS, TRUSTED_PROXY_HOPS, socket-address fallback
✓ Forged forwarding, socket-IP and client-key headers ignored
✓ OPTIONS not rate limited; 429 carries CORS headers and an exact Retry-After
✓ Half-open probe slot released after a non-retryable or invalid upstream answer
✓ GET requests preserve an existing query string on the upstream endpoint
✓ HAGEZI_UPSTREAM_ENDPOINTS override and HAGEZI_ROTATION_MODE/SECONDS handling
✓ Sliding-window limiter: no boundary burst, expiry, capacity eviction and clock rollback handling
✓ Unknown provider ids answered 404 by the router; Content-Length on answers
✓ PROXY_VERSION read from package.json and route deadline checks
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

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF). Entries whose path is `/dns-query` (without `/api/doh/`) use a different path layout from this codebase's `/api/doh/dns-query`.

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

## ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [`LICENSE`](LICENSE).
