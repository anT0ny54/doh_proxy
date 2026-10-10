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
src/lib/rate-limit.ts              In-process fixed-window limiter
src/lib/client-ip.ts               Client IP extraction and normalization
src/lib/providers.ts               Fixed provider upstreams
src/lib/upstreams.ts               Fixed HaGeZi upstreams
src/lib/site.ts                    Public origin resolution, repository URL, copyright year
scripts/test-*.mjs                 node:test suites. `npm test` runs all but test-integration.mjs (no build
                                   needed); `npm run test:integration` needs a prior `npm run build`
scripts/lib/transpile-source.mjs   Test helper: transpiles src/ TypeScript on the fly, provides the
                                   `next/server` stub and `importDoh()` loader shared by the suites
scripts/lib/dns-fixtures.mjs       Test helper: shared valid DNS query/response builders (used by the
                                   doh, capacity and config suites)
.github/workflows/ci.yml           CI: lint, unit tests, build, integration tests, Docker smoke test, audit
.github/workflows/docker-publish.yml  Manual image build/publish to GHCR
.github/workflows/Keep-Alive.yml   Keep-alive commit on the 1st and 15th of each month (updates keep-alive.txt)
.github/workflows/npm.yml          Manual package-lock.json regeneration ("Update package-lock.json")
keep-alive.txt                     Timestamp rewritten by the keep-alive workflow
.gitattributes, .gitignore         LF normalization and ignore rules
Dockerfile, .dockerignore          Self-hosted standalone build
next.config.ts                     Security headers, standalone output outside Vercel/Netlify
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
  |      +--> match `/api/doh/*` (all methods, including HEAD/OPTIONS)
  |      +--> skip limiting when TRUST_PROXY_HEADERS disables trust or no usable client IP header is present
  |      +--> enforce 100 requests / 60 seconds per identified source IP (RATE_LIMIT_PER_MINUTE)
  |      +--> return 429 when the process-local rate window is exceeded
  |      |
  |      +--> continue to the Next.js Route Handler
  |
  +--> GET/POST /api/doh/dns-query
  |      |
  |      +--> HEAD/OPTIONS -> 204 (no upstream work, no in-flight slot)
  |      +--> enforce 32-request (8 per client IP) in-flight ceiling
  |      |      +--> return 503 when a ceiling is reached
  |      +--> validate DNS wire message
  |      +--> select rotated HaGeZi order
  |      +--> sequential upstream fetch
  |      +--> skip upstreams whose circuit breaker is open
  |      +--> validate response + match ID/Question
  |      +--> return application/dns-message
  |
  +--> GET/POST /api/doh/<provider>/dns-query
         |
         +--> unknown provider id -> 404
         +--> HEAD/OPTIONS -> 204 (no upstream work, no in-flight slot)
         +--> enforce 32-request (8 per client IP) in-flight ceiling
         |      +--> return 503 when a ceiling is reached
         +--> validate DNS wire message
         +--> use one fixed provider upstream (no failover)
         +--> validate response + match ID/Question
         +--> return application/dns-message
```

The implementation is intentionally small: there is no server-side DNS cache (for GET, an upstream `max-age` may be relayed as `private, max-age=N`, capped at 300 s, so clients can cache) and no arbitrary proxy target. Public DoH requests use fixed upstreams, bounded message handling, sequential failover, a process-local request-rate limit, and a process-local in-flight ceiling.

## API behavior

The proxy implements the RFC 8484 DoH request format:

- **GET** uses the `dns` query parameter containing a base64url-encoded DNS wire message. Optional `=` padding is accepted and stripped before the query is forwarded upstream.
- **POST** uses the raw DNS wire message with `Content-Type: application/dns-message`.
- **HEAD** and **OPTIONS** return `204` for health checks and CORS preflight.
- Unsupported methods return `405`: the route files only export GET, POST, HEAD and OPTIONS, so Next.js answers other methods itself. `proxyRequest` additionally has a defensive `405` (with `Allow: GET, POST, HEAD, OPTIONS`) for callers that bypass the route files.
- An unknown provider id on `/api/doh/<provider>/dns-query` returns `404`.
- Responses from the DoH handler carry permissive CORS headers (`Access-Control-Allow-Origin: *`, methods `GET, POST, HEAD, OPTIONS`, headers `Accept, Content-Type, Cache-Control`, exposed header `Retry-After`, preflight cache `Access-Control-Max-Age: 86400`). The `429` returned by the rate limiter carries `Cache-Control: no-store`, `Retry-After` and just two CORS headers (`Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Retry-After`), which is enough for browser clients to read it.
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
| `429` | Per-IP rate limit exceeded (returned by `src/proxy.ts`, with `Retry-After`). |
| `503` | In-flight ceiling reached (global or per client IP), with `Retry-After: 1`. |
| 4xx/5xx | Last non-retryable upstream rejection, relayed as `DNS upstream rejected request` (see below). |
| `502` | No upstream produced a valid answer (`DNS upstream unavailable`). |

Request handling is bounded:

- Client queries are capped at **4 KiB** (`MAX_DNS_MESSAGE_SIZE = 4096`); upstream responses at **64 KiB** (`MAX_DNS_RESPONSE_SIZE = 65535`, the RFC 8484 maximum) so DNSSEC and large TXT answers, which routinely exceed 4 KiB, still work. Anything larger is rejected instead of being buffered without a bound.
- GET query strings are capped at **8192 characters**.
- POST bodies are read as a stream with a running 4 KiB cap; the read is aborted as soon as the cap or the request deadline is exceeded. A body stream that errors (for example because the client aborted the upload) is answered with `400` rather than escaping the handler as an unhandled error.
- Upstream response bodies are read the same way (64 KiB cap plus the upstream deadline).
- With `src/proxy.ts` in front of the route, Next.js may buffer a request body before the handler runs (the integration suite's slow-upload case accepts either `200` or `408` for that reason), so the streaming cap and the 1 second body deadline are the handler's own guard rather than a guarantee about the transport. Also cap request bodies at the reverse proxy (for example nginx `client_max_body_size`).
- Both routes use a **2.5 second** application deadline (`DEFAULT_TIMEOUT_MS`), inside the 5 second route `maxDuration`.
- Per-attempt upstream timeouts are bounded so one failed resolver cannot consume the whole request indefinitely.
- The remaining deadline is shared across the attempts still to come. The nominal failover slice is at least 750 ms, but an attempt is skipped when less than 100 ms remains.
- On the primary endpoint, any failed attempt (timeout, network error, non-200 status, wrong content type, invalid or mismatched DNS body) falls through to the next fixed upstream. If none answers, the last non-retryable upstream rejection status (4xx/5xx other than 408, 425, 429, 500, 502, 503, 504; for example `403` or `404`) is returned as `DNS upstream rejected request`; it is kept even if a later attempt times out or fails with a retryable status. A non-200 status outside 400-599 (for example `204`) is recorded as a `502` rejection and, if nothing else answers, returned as `502 DNS upstream rejected request`. Everything else (timeouts, network errors including blocked redirects, wrong content type, invalid, mismatched or oversized bodies, retryable statuses) ends as `502 DNS upstream unavailable`. Provider routes try exactly one upstream. The proxy never launches the full failover set concurrently.
- Failover stops (no further attempt is made) once less than 100 ms of the request deadline remains, so a slow client cannot make healthy upstreams look unhealthy.
- **Circuit breaker:** an upstream that accumulates 3 failures (timeout, network error or retryable status: 408, 425, 429, 500, 502, 503 or 504) without an intervening success is skipped for 30 seconds, after which one half-open probe is allowed. The probe slot is reserved only when an attempt on that upstream actually starts, so a recovered upstream is not locked out when an earlier upstream answers first; a probe that never reports back is released after 5 seconds. If every upstream is open, the set is still probed. Non-retryable upstream statuses and invalid/wrong-content-type responses do not increment the breaker, and when they answer a half-open probe they release the probe slot immediately instead of blocking the upstream for the rest of the 5 seconds. State is per process.

DNS validation checks message size, header flags/opcode, exactly one Question, section boundaries, name encoding, backward compression pointers, and the complete message structure. Compression pointers may only target bytes validated as part of a domain name: the Question, record owner names and the names inside NS/CNAME/PTR/DNAME, MX, SOA, SRV and SVCB/HTTPS RDATA (the SVCB/HTTPS target name must be uncompressed, per RFC 9460). RDATA of every other type is opaque, so a pointer into it is rejected. Upstream responses must be `200 application/dns-message`, structurally valid, and match the original query transaction ID and Question section before they are relayed.

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

Per-IP rate limiting and per-IP in-flight caps key off `X-Real-IP` /
`X-Forwarded-For`. A directly connected client can forge these headers, so
**trusting them is only safe behind a reverse proxy** (nginx, Caddy, a platform
front end, …) that overwrites or sanitizes them on every request. In this
codebase the headers are **trusted by default**: `TRUST_PROXY_HEADERS` unset,
empty or truthy ("1", "true", "yes", "on") enables them, while "0", "false",
"no", "off" — or any unrecognized value — disables them. If the app is
exposed directly (for example a container with a published port and no proxy
in front), set `TRUST_PROXY_HEADERS=0`; otherwise a client can mint a fresh
rate-limit/in-flight identity by forging the headers. With trust disabled,
requests are not attributed to a client IP; put a sanitizing reverse proxy or
WAF in front to enforce per-client limits. Rate limits and in-flight ceilings
remain per-instance; use a shared gateway or WAF for global limits in
multi-instance deployments.

The application uses two process-local protections before expensive upstream work begins.

The first is a **100 requests per 60 seconds per identified source IP** fixed window (set `RATE_LIMIT_PER_MINUTE` to change; IPv6 clients are keyed by /64, and ports/IPv4-mapped forms are normalized) in `proxy.ts`, tracked in an in-memory map capped at 10,000 source keys (the oldest bucket is evicted first). It applies to every method on `/api/doh/*` (HEAD and OPTIONS count too); requests over the window receive `429 Too Many Requests` with `Retry-After`. The limiter is local to each runtime instance. When no usable `X-Real-IP` or `X-Forwarded-For` address is available, the request is not per-client rate limited and continues to the route handler. Forwarding headers must therefore be sanitized by the front proxy when they are used to identify the client.

The second is a **32-request in-flight ceiling** (at most 8 per identified client IP) in the DoH handler (HEAD/OPTIONS return before a slot is taken). POST bodies must arrive within 1 second (or the request deadline, if shorter), and upstream waits are bounded by the request deadline, so stalled clients cannot consume the whole Node.js process. Requests that arrive after the ceiling is reached receive `503 Service Unavailable` with `Retry-After: 1` rather than waiting in an unbounded queue.

The in-flight ceilings, circuit breakers and request-rate limiter are process-local (on serverless hosts such as Vercel or Netlify each instance has its own copy, so treat them as best-effort and use a platform WAF for hard limits). Platform-level WAF, firewall, connection, or traffic controls can still provide cross-instance protection when required.

Requests without a usable `X-Real-IP` / `X-Forwarded-For` header, or any request while trust is disabled (`TRUST_PROXY_HEADERS=0`), have an unknown client address: they are **not** rate limited and only count against the global in-flight ceiling. Put a reverse proxy or WAF in front for per-client limiting. `X-Real-IP` is preferred; otherwise the **last** `X-Forwarded-For` entry (the one added by the nearest proxy) is used, so with several proxies in a chain make sure the outermost trusted one is the last to append (or sets `X-Real-IP`), or all clients will share the identity of an intermediate hop.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | Per-source-IP request limit per 60 s window enforced by `proxy.ts`. Read once at startup; a value that is not a positive integer is ignored. | `100` |
| `TRUST_PROXY_HEADERS` | Whether to trust `X-Real-IP` / `X-Forwarded-For` for client identity. Unset, empty, `1`, `true`, `yes` or `on` (case-insensitive) trust them; `0`, `false`, `no`, `off` and any unrecognized value disable trust (no per-IP rate limit or in-flight cap). Evaluated on every request. Keep it enabled only behind a reverse proxy that overwrites or sanitizes the headers on every request; set `0` when the app is directly exposed. | enabled (trusted) |
| `HAGEZI_UPSTREAM_ENDPOINTS` | Comma-separated DoH endpoint URLs that replace the built-in HaGeZi list (operator-set, never request-controlled). Entries are trimmed, and ones that are not valid `http(s)` URLs are ignored; with no valid entry the built-in list is used. The list is used as given (no rotation) and is read once, on first use. A query string on an entry (e.g. `?token=...`) is preserved on GET requests. The homepage still lists the compiled-in resolvers. Used by the integration suite. | built-in list |
| `HAGEZI_ROTATION_MODE` | Set to `request` (case-insensitive) to round-robin the primary HaGeZi resolver per request instead of per time slot. Any other value keeps time-slot rotation. | time slot |
| `HAGEZI_ROTATION_SECONDS` | Primary HaGeZi rotation interval. Values are clamped to 60–86400 seconds; non-numeric values fall back to the default. | `1800` |
| `NEXT_PUBLIC_SITE_URL` | Public origin used by the homepage and metadata when explicitly set. **Build-time only** (the homepage is statically generated); for Docker pass it as `--build-arg`. | derived from the platform (Netlify `URL`, or `DEPLOY_PRIME_URL` on non-production deploys; Vercel `VERCEL_PROJECT_PRODUCTION_URL`, or `VERCEL_URL` on previews), else `http://localhost:3000`; Docker image: `http://localhost:8367` |

The provider endpoints and HaGeZi endpoint URLs are source-controlled in `src/lib/providers.ts` and `src/lib/upstreams.ts`. The only runtime override is the operator-set `HAGEZI_UPSTREAM_ENDPOINTS`; nothing is configurable through request parameters.

## Security and privacy

- The application does not contain query-content logging code.
- GET requests place the encoded DNS message in the URL. Hosting, reverse-proxy, or access logs outside the application can therefore potentially record the URL. Use POST when avoiding DNS data in URL paths matters.
- Only fixed upstream URLs are forwarded (compiled in, or set by the operator at startup through `HAGEZI_UPSTREAM_ENDPOINTS`); request-supplied upstream targets and redirects are not supported.
- `X-Real-IP` / `X-Forwarded-For` are trusted by default (disable with `TRUST_PROXY_HEADERS=0`). Behind a sanitizing reverse proxy this gives accurate per-client limits; on a directly exposed instance a client could forge the headers to mint a rate-limit or in-flight identity, so set `TRUST_PROXY_HEADERS=0` there.
- Request and response sizes are explicitly bounded to keep memory use predictable.
- Response validation rejects malformed or mismatched DNS answers before relay.
- GET DoH responses relay a usable upstream `Cache-Control: max-age=N` as `private, max-age=N`, capped at 300 seconds. POST and error responses use `Cache-Control: no-store`. The proxy does not implement an application DNS cache.
- The strict document CSP is applied only to the homepage. Every route (API included) gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy` and `Cross-Origin-Resource-Policy: cross-origin`; the `X-Powered-By` header is disabled. A CSP has no effect on `application/dns-message` bodies.
- A public DoH service can still consume significant bandwidth under abuse, so platform or gateway traffic controls remain important.

## Deployment

### Managed Next.js hosting

The DoH route handlers and `proxy.ts` run on the **Node.js runtime**. Deploy the repository using the platform's normal Next.js integration and configure any platform-level WAF/rate limiting as an additional outer layer when needed.

`netlify.toml` pins `NODE_VERSION = 22` to match the Dockerfile and `package.json` `engines`. On Vercel/Netlify the build does not use standalone output.

Per-IP rate limiting and the per-IP in-flight cap are enabled by default. On Vercel and Netlify, set `TRUST_PROXY_HEADERS=1` explicitly in the project's environment variables (it matches the default, but keeps the setting visible and independent of any future default change). This is only safe because the platform front end sits in front of the app; verify that it overwrites `X-Real-IP` / `X-Forwarded-For` rather than passing client-supplied values through, for example by sending a request with a forged `X-Forwarded-For` and confirming it is not used as the client identity. Limits remain per instance on these platforms, so treat them as best-effort and add a platform WAF for hard limits.

If the app is directly exposed (no platform or reverse proxy in front), set `TRUST_PROXY_HEADERS=0` and rely on the platform WAF or another trusted source of client identity.

Verify:

```text
HEAD /api/doh/dns-query -> 204
```

### Docker (self-hosted)

```bash
docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

If the container is published directly without a reverse proxy in front, add `-e TRUST_PROXY_HEADERS=0` so forged `X-Real-IP` / `X-Forwarded-For` headers are not used as client identity (per-IP limits are then inactive; see [Client identity and rate limiting](#client-identity-and-rate-limiting)).

The Docker image (`node:22-alpine`, non-root `node` user, `NODE_OPTIONS=--max-old-space-size=320`, `PORT=8367`) uses Next.js standalone output, has a `HEALTHCHECK` on `/`, and starts the generated server with:

```text
node server.js
```

The manual `Docker Build and Publish` workflow passes the repository variable `NEXT_PUBLIC_SITE_URL` as the build argument and falls back to `http://localhost:8367` when it is unset.

`next.config.ts` uses standalone output unless the `VERCEL` or `NETLIFY` environment variable is set, so managed Vercel/Netlify builds use their native Next.js output handling. `NEXT_PUBLIC_SITE_URL` is inlined at build time, so it must be passed as a build argument.

For a self-hosted build outside Docker, run the generated server (`node .next/standalone/server.js`, after copying `.next/static` to `.next/standalone/.next/static` as the Dockerfile does) rather than `npm start`; `package.json`'s `start` script is plain `next start`, which is not meant for standalone output.

## Development

```bash
npm install
npm run dev
```

Requires Node.js 22 or newer (`engines` in `package.json`).

See [`CHANGELOG.md`](CHANGELOG.md) for release history. `PROXY_VERSION` in `src/lib/doh.ts` must match `package.json` (enforced by `npm test`).

Useful commands:

```bash
npm test
npm run lint
npm run build
```

`npm test` runs seven node:test suites: DNS parser/response-validation (`scripts/test-dns.mjs`), RR-type-aware RDATA validation (`scripts/test-dns-rdata.mjs`), DoH runtime behavior (`scripts/test-doh.mjs`: failover, timeouts, circuit breakers, GET/POST validation, redirect and content-type handling, response-size caps, cache-control handling, rotation settings, version and route-deadline checks), in-flight capacity (`scripts/test-capacity.mjs`), proxy source-IP handling (`scripts/test-proxy.mjs`), the limiter itself (`scripts/test-rate-limit.mjs`) and environment configuration (`scripts/test-config.mjs`: `HAGEZI_UPSTREAM_ENDPOINTS` and the default-on `TRUST_PROXY_HEADERS` boundary). The suites transpile the real `src/` TypeScript on the fly through `scripts/lib/transpile-source.mjs` (which also supplies the `next/server` stub and the shared `importDoh()` loader) and share the query/response builders in `scripts/lib/dns-fixtures.mjs`; they do not require a Next.js build. `typescript` (a dev dependency) must be installed for this helper to work.

`npm run test:integration` (`scripts/test-integration.mjs`) is separate: it needs `npm run build` first, starts the production server with `next start` against a local mock DoH upstream (via `HAGEZI_UPSTREAM_ENDPOINTS`) and checks GET/POST, content types, body-size caps, a slow upload, upstream failure and response headers over real HTTP. Its requests carry no forwarding headers, so the client address is unknown and rate limiting is not exercised.

CI (`.github/workflows/ci.yml`) runs on every push and pull request to `main`: lint, `npm test`, build, the integration suite, a Docker image build with a container smoke test, and a separate `npm audit` job (production dependencies gate the build; the full audit is advisory).

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
✓ Handler-level 405 with an Allow header for unsupported methods
✓ Upstream redirect blocking, content-type validation and response validation
✓ Upstream response size cap (declared and streamed) with continued failover
✓ POST body stream failure answered with 400 (no unhandled error)
✓ Sequential failover, retryable-status handling and bounded timeouts
✓ Circuit-breaker open/half-open behavior, including probe reservation only on real attempts
✓ GET max-age relay and POST no-store behavior
✓ Global/per-client in-flight ceilings
✓ Proxy source-IP normalization and rate limiting
✓ Trusted-proxy boundary: forwarding headers trusted by default, ignored when TRUST_PROXY_HEADERS is falsy or unrecognized
✓ Half-open probe slot released after a non-retryable or invalid upstream answer
✓ GET requests preserve an existing query string on the upstream endpoint
✓ HAGEZI_UPSTREAM_ENDPOINTS override and HAGEZI_ROTATION_MODE/SECONDS handling
✓ Rate-limiter expiry, capacity eviction and clock rollback handling
✓ PROXY_VERSION/package.json synchronization and route deadline checks
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

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

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
