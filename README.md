# FreeDNS DoH Proxy

A lightweight public DNS-over-HTTPS (DoH) proxy built on Next.js, tuned for low-latency Edge execution on **Vercel** and **Netlify**.

## Public DoH endpoint

```text
https://freedns-six.vercel.app/api/doh/dns-query
```

This is the primary, recommended endpoint. It proxies requests to a rotating set of HaGeZi resolvers (balanced protection: Multi Pro + Threat Intelligence Feed) with sequential failover, and never exposes which upstream served the request.

## Built-in provider endpoints

Fixed, wire-format-only endpoints for testing against a specific upstream through the same proxy. No arbitrary/custom upstream URL is ever accepted — the provider list is a compiled-in allowlist (see `src/lib/providers.ts`).

| Provider | Endpoint |
|---|---|
| Google | `/api/doh/google/dns-query` |
| Cloudflare | `/api/doh/cloudflare/dns-query` |
| AdGuard | `/api/doh/adguard/dns-query` |
| DNS.SB | `/api/doh/dnssb/dns-query` |

## API behavior

Both the primary endpoint and the provider endpoints implement [RFC 8484](https://www.rfc-editor.org/rfc/rfc8484):

- **GET** — the DNS wire message is base64url-encoded in the `dns` query parameter.
- **POST** — the DNS wire message is the raw request body with `Content-Type: application/dns-message`.
- **HEAD** / **OPTIONS** — return `204` for health checks and CORS preflight.
- Any other method returns `405` with an `Allow` header.

The proxy:

- rotates the primary HaGeZi upstream every 30 minutes by default (`HAGEZI_ROTATION_SECONDS`);
- tries one upstream at a time and falls through to the next on failure or timeout, within a 3-second global budget for the primary endpoint;
- validates GET message encoding/size and POST content type/size before forwarding anything upstream;
- sets `Cache-Control: no-store` on every response — no intentional DNS response caching;
- returns CORS headers (`Access-Control-Allow-Origin: *`) so browser-based DoH clients can call it directly.

## Rate limiting

Two independent layers are provided; use whichever fit your deployment target, or both:

1. **Application-level (`src/middleware.ts`)** — an in-memory per-IP limiter (120 requests/minute) applied to every `/api/doh/*` route, on any platform. Because serverless/edge instances don't share memory, this is a best-effort per-instance safety net, not a global limiter.
2. **Netlify Edge Function (`netlify/edge-functions/doh-rate-limit.ts`)** — uses Netlify's platform-level `rateLimit` config (100 requests/minute, aggregated by IP + domain) for all `/api/doh/*` routes.

For a public deployment on either platform, also add a platform firewall/WAF rule (e.g. Vercel Firewall) on `/api/doh/*` as the primary line of defense — the application limiter is a second safety layer, not a replacement for it.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `HAGEZI_ROTATION_SECONDS` | How often the primary HaGeZi upstream rotates. Clamped to 60–86400 seconds. | `1800` |

## Security notes

- DNS query bodies are never logged.
- The public endpoints only ever forward to the fixed, compiled-in upstream set — no arbitrary upstream URL is accepted at any layer.
- `Content-Security-Policy: default-src 'none'` and standard hardening headers are set on every response (see `next.config.ts` and `src/lib/doh.ts`).
- A public DoH service can still consume significant bandwidth under abuse; keep a platform-level traffic control in place regardless of the application-level limiter.

## Deployment

### Vercel

1. Push the repository to GitHub.
2. Import it into Vercel and deploy with the default Next.js settings.
3. Add a Vercel Firewall rate-limit rule for `/api/doh/*`.
4. Verify with `HEAD /api/doh/dns-query` → expect `204`.

### Netlify

1. Import the repository into Netlify.
2. Netlify picks up `netlify.toml` and `netlify/edge-functions/doh-rate-limit.ts` automatically; the edge function's `rateLimit` config is validated at deploy time.
3. Verify with `HEAD /api/doh/dns-query` → expect `204`.

### Docker (self-hosted)

```bash
docker build -t doh-proxy .
docker run -p 8367:8367 doh-proxy
```

`next.config.ts` only emits the standalone server bundle the `Dockerfile` copies (`.next/standalone`) when neither `VERCEL` nor `NETLIFY` is set in the build environment — both platforms run their own build-output tracing and fail if `output: "standalone"` is on, so this keeps the same `next.config.ts` correct for all three targets.

## Development

```bash
npm install
npm run dev
```

`package-lock.json` is regenerated automatically by the "Generate package-lock.json" GitHub Actions workflow whenever `package.json` changes (also runs weekly), so it doesn't need to be hand-maintained.

Before shipping:

```bash
npm run lint
npm run build
```

`typescript` is pinned to the 6.x line rather than 7.x: TypeScript 7's package no longer ships the classic JS compiler API, and `typescript-eslint` (pulled in by `eslint-config-next`'s `next/typescript` preset, used in `eslint.config.mjs`) still requires it, so `npm run lint` fails on TypeScript 7 today. `next build`'s own type-checking is unaffected either way. Revisit this pin once `typescript-eslint` supports TypeScript 7 (tracking: their `>=4.8.4 <6.1.0` peer range).

## Validation checklist

```text
✓ HEAD /api/doh/dns-query              → 204
✓ Valid GET  ?dns=<b64url>             → 200
✓ Valid POST application/dns-message   → 200
✓ Missing GET dns                      → 400
✓ Malformed dns                        → 400
✓ Oversized body                       → 413
✓ Unsupported POST content type        → 415
✓ Over the application rate limit      → 429 + Retry-After
✓ Upstream failure                     → sequential HaGeZi fallback
✓ Global timeout                       → bounded failure response
✓ No intentional DNS response caching
```

## Related services

| Service | DNS-over-HTTPS URL |
| --- | --- |
| HaGeZi Multi Pro + TIF (this project, Vercel) | `https://freedns-six.vercel.app/api/doh/dns-query` |
| HaGeZi Multi Pro + TIF (this project, Netlify) | `https://dnssix.netlify.app/api/doh/dns-query` |
| HaGeZi Multi Pro + TIF (alternate host) | `https://freedns.koyeb.app/dns-query` |

## 🚀 Bandwidth Hero Server

A lightweight image proxy designed to slash bandwidth usage and accelerate your browsing experience. 

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to your device for faster loading and lower data consumption.

🖥️ **Try it out:** [Bandwidth Hero](https://bhserv.netlify.app/)

## Support

If you'd like to support development, donations are accepted at:

**Bitcoin:** `1HntwKxyGCfnSGvGLMUTRAqLnTvLarAQP`

## License

AGPL-3.0

## Repository

https://github.com/anT0ny54/doh_proxy
