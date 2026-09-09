# 🛡️ Secure DoH Proxy v1.4.1

A privacy-focused DNS-over-HTTPS proxy built with Next.js 16 and designed for edge/serverless deployments, including Vercel and Netlify.

## Public DoH features

- **Three HaGeZi upstreams:** `root → wurzn → juist → root`.
- **Stateless rotation:** the primary upstream changes every 30 minutes by default, without Redis/KV/SQLite.
- **Sequential failover:** if the selected upstream fails, the request tries the other two in order.
- **One upstream request at a time:** avoids the old three-way race and reduces unnecessary upstream traffic.
- **Global upstream budget:** one client query gets at most 3 seconds for all upstream attempts.
- **RFC 8484 wire format:** GET `dns=` and POST `application/dns-message` are supported on the public endpoint.
- **Strict request bounds:** query strings and DNS bodies are limited to 4 KiB; GET DNS messages must decode to a plausible DNS packet.
- **Application rate limit:** 120 DNS requests/minute/IP per running instance; health and preflight requests do not consume the budget.
- **Netlify edge rate limit:** 100 requests/minute/IP/domain on the public endpoint.
- **Vercel WAF support:** documented rule for edge rate limiting by IP.
- **No DNS query logging by default.**
- **No response caching:** DNS answers are not intentionally cached by the application.
- **No upstream disclosure:** the selected HaGeZi endpoint is not returned to clients.
- **SSRF hardening:** custom/manual upstreams reject common private and reserved targets.
- **Security headers:** enabled globally.
- **Non-root Docker runtime.**

## Public endpoint

After deployment, use:

```text
https://YOUR-VERCEL-DOMAIN/api/doh/dns-query
https://YOUR-NETLIFY-DOMAIN/api/doh/dns-query
```

Both deployments can use the same Git repository.

## HaGeZi rotation

The three upstreams are:

1. `https://root.hagezi.org/dns-query`
2. `https://wurzn.hagezi.org/dns-query`
3. `https://juuri.hagezi.org/dns-query`

Default:

```text
HAGEZI_ROTATION_SECONDS=1800
```

Rotation is calculated from the current UTC epoch time. This makes the selection deterministic across cold starts and multiple serverless instances.

Within each rotation slot the selected endpoint is tried first. Failures then fall through to the next endpoint, then the third endpoint. A single successful DNS query therefore normally creates only one upstream request.

The valid rotation range is 60 seconds to 24 hours.

## Public DoH API

### GET

Use standard RFC 8484 `dns` query encoding:

```text
GET /api/doh/dns-query?dns=<base64url DNS message>
```

The proxy rejects missing, malformed, or oversized DNS messages.

### POST

```text
POST /api/doh/dns-query
Content-Type: application/dns-message
```

The DNS wire message must be at least 12 bytes and no larger than 4096 bytes.

### OPTIONS / HEAD

Both return `204 No Content`. They do not consume the application DNS rate limit.

### Errors

- `400` malformed or missing DNS message
- `405` unsupported method
- `413` oversized request
- `415` unsupported POST content type
- `429` application rate limit exceeded
- `502` all upstreams failed
- `504` global upstream timeout

Rate-limited responses include `Retry-After` and standard `RateLimit-*` headers.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `HAGEZI_ROTATION_SECONDS` | HaGeZi primary-upstream rotation interval. | `1800` |
| `CUSTOM_DOH_URL` | Upstream URL for the `custom` provider. | unset |
| `DEBUG_LOG` | Set to `true` to log successful requests as well as errors. | `false` |
| `PORT` | Standalone Docker HTTP port. | `8367` |

## Vercel deployment

1. Push this repository to GitHub.
2. Import it into Vercel.
3. Keep the normal Next.js build settings.
4. Deploy.
5. Test `HEAD /api/doh/dns-query`.
6. Add a Vercel Firewall/WAF rate-limit rule for `/api/doh/dns-query`.

A good starting rule is:

```text
Path: /api/doh/dns-query
Limit: 120 requests/minute/IP
Action: rate limit
```

For a public resolver, start conservatively and tune from real traffic. Vercel Firewall supports custom WAF rules that can rate-limit by IP and path. The current Vercel CLI also supports adding a rule with a natural-language command, for example:

```bash
vercel firewall rules add --ai "Rate limit /api/doh/dns-query to 120 requests per minute by IP"
```

Vercel's WAF rate-limited/blocked traffic is currently excluded from CDN request and Fast Data Transfer charges. Verify the exact rule in the Vercel dashboard after creation. 

## Netlify deployment

1. Push this repository to GitHub.
2. Create a new Netlify site from the repository.
3. Let Netlify use its Next.js integration.
4. Deploy.
5. Check the deploy log for the code-based rate-limit rule.
6. Test `HEAD /api/doh/dns-query`.

This repository includes:

```text
netlify/edge-functions/doh-rate-limit.ts
```

It defines a Netlify Edge Function middleware rule:

```text
100 requests / 60 seconds / IP + domain
```

The middleware calls `context.next()` so the normal Next.js DoH route continues after Netlify applies the rate-limit policy.

Netlify documents code-based rate limiting for Edge Functions on all plans. Enforcement can take up to about 10 seconds to catch up after a client crosses the threshold, so the application limiter remains enabled as a second safety layer.

## Layered abuse protection

The public resolver intentionally uses multiple layers:

```text
Client
  ↓
Vercel WAF / Netlify DDoS + rate limiting
  ↓
Next.js application rate limiter
  ↓
Strict DNS request validation
  ↓
HaGeZi rotation + sequential failover
```

The application limiter is **per running instance**, not a global distributed counter. Platform-level protection is therefore recommended for public use.

## Rate-limit tuning

The application default is:

```text
120 DNS requests/minute/IP
```

This is deliberately higher than a very strict API limit because several devices can share one public IP through NAT.

If the service is private/personal, a lower platform limit such as 30–60/min/IP may be appropriate. For a genuinely public resolver, start around 60–120/min/IP and observe legitimate traffic before tightening it.

## Security and privacy

- DNS query contents are not intentionally written to application logs.
- `DEBUG_LOG=true` logs request metadata, not the DNS message body.
- The selected upstream URL is not returned to the client.
- `Cache-Control: no-store` is used for DNS responses.
- Manual/custom upstream URLs are checked against common localhost, private, link-local, multicast, and reserved IP ranges.
- DNS rebinding cannot be completely prevented in an Edge Runtime by hostname validation alone; do not expose arbitrary upstream selection unless the endpoint is trusted.
- A public DoH service can still be abused for bandwidth consumption even with rate limiting. Monitor platform usage and upstream traffic.

## Other providers

The existing provider routes remain available:

| Provider | Default | JSON | Wire format |
|---|---|---|---|
| Cloudflare | `/api/doh/cloudflare` | `/api/doh/cloudflare` | `/api/doh/cloudflare/dns-query` |
| Google | `/api/doh/google` | `/api/doh/google/resolve` | `/api/doh/google/dns-query` |
| AdGuard | `/api/doh/adguard` | `/api/doh/adguard/resolve` | `/api/doh/adguard/dns-query` |
| DNS.SB | `/api/doh/dnssb` | `/api/doh/dnssb` | `/api/doh/dnssb/dns-query` |
| Custom | `/api/doh/custom` | depends on upstream | depends on upstream |
| Manual | `/api/doh/manual?upstream=<url>` | depends on upstream | depends on upstream |

## Development

```bash
npm ci
npm run dev
```

Production build:

```bash
npm run lint
npm run build
```

## Docker

The included multi-stage Dockerfile builds a standalone Next.js image and runs it as a non-root user.

```bash
docker build -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

## Validation checklist

Before making the endpoint public:

```text
✓ HEAD /api/doh/dns-query → 204
✓ Valid GET dns= query → 200
✓ Valid POST application/dns-message → 200
✓ Missing GET dns → 400
✓ Malformed dns → 400
✓ Oversized body → 413
✓ Unsupported POST content type → 415
✓ Rate limit → 429 + Retry-After
✓ Upstream failure → fallback to next HaGeZi endpoint
✓ All upstreams unavailable → 502/504
```

## License

AGPL-3.0

## Repository

https://github.com/anT0ny54/doh_proxy


## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://freedns-six.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |

---

# ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/)


## Supporting the Project

If you find this project useful, donations are appreciated:
- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`
  
