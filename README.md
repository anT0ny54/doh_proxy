# FreeDNS DoH Proxy

A lightweight public DNS-over-HTTPS (DoH) proxy built with Next.js and the Node.js runtime. The service is designed around a small, fixed upstream set, bounded request/response handling, sequential failover, and bounded request handling in the Next.js Node.js runtime.

## What this project provides

The project exposes a public DoH service and a small homepage. The proxy never accepts a user-supplied upstream URL: every upstream is compiled into the application configuration.

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

## Runtime architecture

```text
Client
  |
  +--> Node.js `proxy.ts`
  |      |
  |      +--> match `/api/doh/*`
  |      +--> enforce 600 requests / 60 seconds per source IP (RATE_LIMIT_PER_MINUTE)
  |      +--> return 429 when the process-local rate window is exceeded
  |      |
  |      +--> continue to the Next.js Route Handler
  |
  +--> GET/POST /api/doh/dns-query
  |      |
  |      +--> enforce 32-request (8 per client IP) in-flight ceiling
  |      |      +--> return 503 when a ceiling is reached
  |      +--> validate DNS wire message
  |      +--> select rotated HaGeZi order
  |      +--> sequential upstream fetch
  |      +--> validate response + match ID/Question
  |      +--> return application/dns-message
  |
  +--> GET/POST /api/doh/<provider>/dns-query
         |
         +--> enforce 32-request (8 per client IP) in-flight ceiling
         |      +--> return 503 when a ceiling is reached
         +--> validate DNS wire message
         +--> use one fixed provider upstream
         +--> validate response + match ID/Question
         +--> return application/dns-message
```

The implementation is intentionally small: there is no server-side DNS cache (for GET, the upstream `max-age` is relayed as `private, max-age=N`, capped at 300 s, so clients can cache) and no arbitrary proxy target. Public DoH requests use fixed upstreams, bounded message handling, sequential failover, a process-local request-rate limit, and a process-local in-flight ceiling.

## API behavior

The proxy implements the RFC 8484 DoH request format:

- **GET** uses the `dns` query parameter containing a base64url-encoded DNS wire message.
- **POST** uses the raw DNS wire message with `Content-Type: application/dns-message`.
- **HEAD** and **OPTIONS** return `204` for health checks and CORS preflight.
- Unsupported methods are handled by the Next.js route and return `405`.

Request handling is bounded:

- Client queries are capped at **4 KiB** (`MAX_DNS_MESSAGE_SIZE = 4096`); upstream responses at **64 KiB** (`MAX_DNS_RESPONSE_SIZE = 65535`, the RFC 8484 maximum).
- GET query strings are capped at **8192 characters**.
- POST bodies are read as a stream with a running 4 KiB cap; the read is aborted as soon as the cap or the request deadline is exceeded.
- Upstream response bodies are read the same way (64 KiB cap plus the upstream deadline).
- The primary HaGeZi path uses a **2.5 second** application deadline, inside the 5 second route `maxDuration`.
- Per-attempt upstream timeouts are bounded so one failed resolver cannot consume the whole request indefinitely.
- On the primary endpoint, any failed attempt (timeout, network error, 4xx/5xx, wrong content type, invalid or mismatched DNS body) falls through to the next fixed upstream; if none answers, the last upstream rejection status (or `502`) is returned. The proxy never launches the full failover set concurrently.
- An attempt is skipped when less than 100 ms of the request deadline remains, so a slow client cannot make healthy upstreams look unhealthy.

DNS validation checks message size, header flags/opcode, exactly one Question, section boundaries, name encoding, backward compression pointers, and the complete message structure. Upstream responses must be `200 application/dns-message`, structurally valid, and match the original query transaction ID and Question section before they are relayed.

### Size limits

Queries are limited to 4 KiB and responses to 64 KiB so memory and bandwidth stay bounded while DNSSEC and large TXT answers (which routinely exceed 4 KiB) still work. Anything larger is rejected instead of being buffered without a bound.

## Primary upstreams

The server-owned HaGeZi list is compiled in under `src/lib/upstreams.ts`:

| Host | Location in source configuration | Purpose |
|---|---|---|
| `root.hagezi.org` | Falkenstein, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `wurzn.hagezi.org` | Nuremberg, Germany | Balanced protection with Multi Pro + Threat Intelligence Feed |
| `juuri.hagezi.org` | Helsinki, Finland | Balanced protection with Multi Pro + Threat Intelligence Feed |

The starting position rotates periodically, but each request still has a deterministic sequential failover order. The default rotation interval is 30 minutes.

## Request protection

The application uses two process-local protections before expensive upstream work begins.

The first is a **600 requests per 60 seconds per source IP** fixed window (set `RATE_LIMIT_PER_MINUTE` to change; IPv6 clients are keyed by /64, and ports/IPv4-mapped forms are normalized) in `proxy.ts`. It applies to `/api/doh/*`; requests over the window receive `429 Too Many Requests` with `Retry-After`. The limiter is intentionally local to each runtime instance, and forwarding headers must be sanitized by the front proxy when they are used to identify the client.

The second is a **32-request in-flight ceiling** (at most 8 per identified client IP) in the DoH handler. POST bodies must arrive within 1 second. This includes slow POST-body reads and upstream waits, so stalled clients cannot consume the whole Node.js process. Requests that arrive after the ceiling is reached receive `503 Service Unavailable` with `Retry-After: 1` rather than waiting in an unbounded queue.

The in-flight ceilings, circuit breakers and request-rate limiter are process-local (on serverless hosts such as Vercel or Netlify each instance has its own copy, so treat them as best-effort and use a platform WAF for hard limits). Platform-level WAF, firewall, connection, or traffic controls can still provide cross-instance protection when required.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | Per-source-IP request limit per 60 s window enforced by `proxy.ts`. | `600` |
| `HAGEZI_ROTATION_MODE` | Set to `request` to round-robin the primary HaGeZi resolver per request instead of per time slot. | time slot |
| `HAGEZI_ROTATION_SECONDS` | Primary HaGeZi rotation interval. Values are clamped to 60–86400 seconds. | `1800` |
| `NEXT_PUBLIC_SITE_URL` | Public origin used by the homepage and metadata when explicitly set. **Build-time only** (the homepage is statically generated); for Docker pass it as `--build-arg`. | platform-derived or `http://localhost:3000`; Docker image: `http://localhost:8367` |

The provider endpoints and HaGeZi endpoint URLs are source-controlled in `src/lib/providers.ts` and `src/lib/upstreams.ts`; they are not configurable through request parameters.

## Security and privacy

- The application does not contain query-content logging code.
- GET requests place the encoded DNS message in the URL. Hosting, reverse-proxy, or access logs outside the application can therefore potentially record the URL. Use POST when avoiding DNS data in URL paths matters.
- Only fixed, compiled-in upstream URLs are forwarded; arbitrary/custom upstream targets and redirects are not supported.
- Request and response sizes are explicitly bounded to keep memory use predictable.
- Response validation rejects malformed or mismatched DNS answers before relay.
- GET DoH responses relay a usable upstream `Cache-Control: max-age=N` as `private, max-age=N`, capped at 300 seconds. POST and error responses use `Cache-Control: no-store`. The proxy does not implement an application DNS cache.
- The strict document CSP is applied only to the homepage; API responses carry `nosniff` and the other global security headers (a CSP has no effect on `application/dns-message` bodies).
- A public DoH service can still consume significant bandwidth under abuse, so platform or gateway traffic controls remain important.

## Deployment

### Managed Next.js hosting

The DoH route handlers and `proxy.ts` run on the **Node.js runtime**. Deploy the repository using the platform's normal Next.js integration and configure any platform-level WAF/rate limiting as an additional outer layer when needed.

Verify:

```text
HEAD /api/doh/dns-query -> 204
```

### Docker (self-hosted)

```bash
docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

The Docker image uses Next.js standalone output and starts the generated server with:

```text
node server.js
```

`next.config.ts` uses standalone output for self-hosted Node.js builds while allowing managed Vercel/Netlify builds to use their native Next.js output handling.

## Development

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm test
npm run lint
npm run build
```

`npm test` runs the DNS parser/response-validation tests (`scripts/test-dns.mjs`), DoH runtime tests (`scripts/test-doh.mjs`: failover, timeouts, circuit breaker, GET/POST validation, redirect blocking), in-flight capacity tests (`scripts/test-capacity.mjs`), proxy source-IP rate-limit tests (`scripts/test-proxy.mjs`), and limiter unit tests (`scripts/test-rate-limit.mjs`).

The project currently stays on the TypeScript 6.x line through the `package.json` dependency range; move to a newer major only alongside compatible Next.js ESLint tooling.

## Validation checklist

The repository includes checks for:

```text
✓ Normal DNS query structure
✓ Query/response message-type validation
✓ First-question compression rejection
✓ Backward compression handling
✓ Forward / invalid compression rejection
✓ DNS name length bounds
✓ Response transaction-ID matching
✓ Response Question matching
✓ Case-insensitive DNS Question-name matching
```

Runtime behavior should additionally be checked after deployment with:

```text
✓ HEAD /api/doh/dns-query              → 204
✓ Valid GET ?dns=<base64url>           → 200 application/dns-message
✓ Valid POST application/dns-message   → 200 application/dns-message
✓ Invalid or missing GET dns           → 400
✓ Oversized request                    → 413 / bounded rejection
✓ Unsupported POST content type        → 415
✓ In-flight overload protection         → 503 once 32 requests are active
✓ Request rate limiting                  → 600 req / 60 s per source IP (configurable)
✓ Upstream failure                     → bounded sequential failover
✓ No intentional DNS response caching
```

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
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |

## ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
