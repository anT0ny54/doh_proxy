# FreeDNS DoH Proxy

A lightweight public DNS-over-HTTPS (DoH) proxy built with Next.js. The service is designed around a small, fixed upstream set, bounded request/response handling, sequential failover, and deployment-platform rate limiting.

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
  +--> GET/POST /api/doh/dns-query
  |      |
  |      +--> validate DNS wire message
  |      +--> select rotated HaGeZi order
  |      +--> sequential upstream fetch
  |      +--> validate response + match ID/Question
  |      +--> return application/dns-message
  |
  +--> GET/POST /api/doh/<provider>/dns-query
         |
         +--> validate DNS wire message
         +--> use one fixed provider upstream
         +--> validate response + match ID/Question
         +--> return application/dns-message
```

The implementation is intentionally small: there is no local DNS cache, no arbitrary proxy target, and no per-instance in-memory rate limiter.

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

## Rate limiting

The application does not keep a local IP rate-limit map. Rate limiting is expected to be enforced by the deployment platform or an external gateway so the control is shared across instances.

### Netlify

`netlify/edge-functions/doh-rate-limit.ts` defines a Netlify edge rate-limit rule for:

```text
/api/doh/*
```

The configured rule is **100 requests per 60 seconds**, aggregated by **IP + domain**. Note that a busy household/office behind one NAT address, or a router that does not cache, can exceed 100 DNS queries per minute and receive `429` responses; raise `windowLimit` in that file if that matches your traffic. The edge function itself calls `context.next()`; the rate-limit configuration is the platform-enforced control.

This rate-limit layer is an Edge Function. The Next.js DoH Route Handler is still a Next.js/Netlify-managed application route; the presence of the edge limiter should not be interpreted as meaning that the route handler is a separately deployed custom Edge Function.

### Vercel

The repository does not contain an application-level Vercel limiter. Configure an appropriate Vercel Firewall/WAF rate-limit rule for `/api/doh/*`.

### Docker / self-hosted

Put the container behind a reverse proxy, firewall, API gateway, or load balancer that provides shared rate limiting and traffic controls.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `HAGEZI_ROTATION_SECONDS` | Primary HaGeZi rotation interval. Values are clamped to 60–86400 seconds. | `1800` |
| `NEXT_PUBLIC_SITE_URL` | Public origin used by the homepage and metadata when explicitly set. **Build-time only** (the homepage is statically generated); for Docker pass it as `--build-arg`. | platform-derived or `http://localhost:3000` |

The provider endpoints and HaGeZi endpoint URLs are source-controlled in `src/lib/providers.ts` and `src/lib/upstreams.ts`; they are not configurable through request parameters.

## Security and privacy

- The application does not contain query-content logging code.
- GET requests place the encoded DNS message in the URL. Hosting, reverse-proxy, or access logs outside the application can therefore potentially record the URL. Use POST when avoiding DNS data in URL paths matters.
- Only fixed, compiled-in upstream URLs are forwarded; arbitrary/custom upstream targets are not supported.
- Request and response sizes are explicitly bounded to keep memory use predictable.
- Response validation rejects malformed or mismatched DNS answers before relay.
- All DoH responses use `Cache-Control: no-store` and do not implement an application DNS cache.
- The strict document CSP is applied only to the homepage; API responses carry `nosniff` and the other global security headers (a CSP has no effect on `application/dns-message` bodies).
- A public DoH service can still consume significant bandwidth under abuse, so platform or gateway traffic controls remain important.

## Deployment

### Vercel

1. Import the repository into Vercel and deploy with the normal Next.js build settings.
2. Add a Vercel Firewall/WAF rate-limit rule covering `/api/doh/*`.
3. Set `NEXT_PUBLIC_SITE_URL` when you want an explicit canonical public origin in generated metadata.
4. Verify `HEAD /api/doh/dns-query` returns `204`.

### Netlify

1. Import the repository into Netlify.
2. Netlify uses `netlify.toml` for the build command and deploys the Next.js application through its Next.js integration.
3. `netlify/edge-functions/doh-rate-limit.ts` supplies the platform rate-limit configuration for `/api/doh/*`.
4. Set `NEXT_PUBLIC_SITE_URL` when you want an explicit canonical public origin in generated metadata.
5. Verify `HEAD /api/doh/dns-query` returns `204`.

### Docker (self-hosted)

```bash
docker build --build-arg NEXT_PUBLIC_SITE_URL=https://dns.example.com -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

The Docker image uses Next.js standalone output and starts the generated server with:

```text
node server.js
```

`next.config.ts` enables `output: "standalone"` for self-hosted builds while leaving managed Vercel/Netlify builds on their platform-specific output handling.

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

`npm test` runs the DNS parser/response-validation tests (`scripts/test-dns.mjs`) and the DoH runtime tests (`scripts/test-doh.mjs`: failover, timeouts, circuit breaker, GET/POST validation).

The project currently stays on the TypeScript 6.x line because the configured `typescript-eslint` / Next.js ESLint integration still has a peer-range constraint below TypeScript 7. Revisit that pin when the linting toolchain supports TypeScript 7 cleanly.

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
✓ Deployment-edge rate limiting        → platform/WAF enforced
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

No deployment-specific hostname is hardcoded in the project documentation.

## License

AGPL-3.0

## Repository

https://github.com/anT0ny54/doh_proxy

## Related services

| Service | DNS-over-HTTPS URL |
| --- | --- |
| HaGeZi Multi Pro + TIF (this project, Vercel) | `https://dns-pi.vercel.app/api/doh/dns-query` |
| HaGeZi Multi Pro + TIF (this project, Netlify) | `https://dnssix.netlify.app/api/doh/dns-query` |
| HaGeZi Multi Pro + TIF (alternate host) | `https://freedns.koyeb.app/dns-query` |

## 🚀 Bandwidth Hero Server

A lightweight image proxy designed to slash bandwidth usage and accelerate your browsing experience. 

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to your device for faster loading and lower data consumption.

🖥️ **Try it out:** [Bandwidth Hero](https://bhserv.netlify.app/)

## Support

If you'd like to support development, donations are accepted at:

**Bitcoin:** `1HntwKxyGCfnSGvGLMUTRAqLnTvLarAQP`
