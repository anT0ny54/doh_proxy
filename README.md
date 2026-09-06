# 🛡️ Secure DoH Proxy

A privacy-focused DNS-over-HTTPS proxy built with Next.js 16 and designed for edge/serverless deployments.

## Features

- **Multiple upstreams:** Cloudflare, Google, AdGuard, DNS.SB, custom environment URL, and manual URL.
- **RFC 8484 + JSON:** Supports `application/dns-message` and `application/dns-json` where the selected upstream supports them.
- **Bounded requests:** Query-string and POST body limits prevent oversized requests.
- **Upstream timeout:** Requests are aborted after 2.5 seconds.
- **SSRF hardening:** Manual/custom upstreams reject non-HTTP(S), credentials, localhost, local/internal names, and common private/reserved IP ranges. DNS rebinding still requires platform-level controls.
- **Edge-friendly rate limiting:** A small in-memory per-IP limiter protects each running edge instance without background cleanup timers.
- **Security headers:** `nosniff`, frame protection, strict referrer policy, and a restrictive permissions policy are enabled globally.
- **No application query logging by default:** Structured request logs are emitted only for errors, or for all requests when `DEBUG_LOG=true`.
- **Built-in DNS tester:** Resolve records from the browser through the proxy.

## API

| Provider | Default | JSON | Wire format |
|---|---|---|---|
| Cloudflare | `/api/doh/cloudflare` | `/api/doh/cloudflare` | `/api/doh/cloudflare/dns-query` |
| Google | `/api/doh/google` | `/api/doh/google/resolve` | `/api/doh/google/dns-query` |
| AdGuard | `/api/doh/adguard` | `/api/doh/adguard/resolve` | `/api/doh/adguard/dns-query` |
| DNS.SB | `/api/doh/dnssb` | `/api/doh/dnssb` | `/api/doh/dnssb/dns-query` |
| Custom | `/api/doh/custom` | Depends on configured upstream | Depends on configured upstream |
| Manual | `/api/doh/manual?upstream=<url>` | Depends on upstream | Depends on upstream |

The dedicated `/api/doh/dns-query` endpoint races three HaGeZi DNS upstreams and returns the first successful response.

### Health check

`HEAD /api/doh/<provider>` returns `204 No Content` without contacting an upstream.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `CUSTOM_DOH_URL` | Upstream URL used by the `custom` provider. | unset |
| `DEBUG_LOG` | Set to `true` to emit structured logs for successful requests too. | `false` |
| `PORT` | HTTP port for the standalone Docker server. | `8367` |

Example:

```bash
CUSTOM_DOH_URL=https://cloudflare-dns.com/dns-query npm run dev
```

## Development

```bash
npm ci
npm run dev
```

Production build:

```bash
npm run lint
npm run build
npm start
```

## Docker

The included multi-stage Dockerfile produces a standalone Next.js image and runs it as a non-root user.

```bash
docker build -t doh-proxy .
docker run --rm -p 8367:8367 doh-proxy
```

## Deployment

The project can run on platforms that support Next.js Edge/serverless routes or as a standalone Node.js container. The included `wrangler.toml` is provided for Cloudflare-oriented deployments.

## License

AGPL-3.0

## Repository

https://github.com/anT0ny54/doh_proxy
