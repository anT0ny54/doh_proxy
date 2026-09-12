# FreeDNS DoH Proxy

A lightweight, mobile-friendly DNS-over-HTTPS proxy for the public FreeDNS endpoint.


## Public DoH endpoint

`https://freedns-six.vercel.app/api/doh/dns-query`

The public endpoint keeps the existing `/api/doh/dns-query` wire-format behavior and uses the supported HaGeZi upstream resolvers with sequential failover.


The V2 cleanup keeps the existing public DoH route and its wire-format behavior while reducing frontend work, removing unused deployment files/utilities, and making the website mobile-first.

## What changed in V2

- Kept `/api/doh/dns-query` as the primary public endpoint.
- Kept RFC 8484 GET and POST support.
- Kept stateless HaGeZi rotation and sequential failover.
- Reduced the per-upstream timeout from 1.2s to 1.0s while keeping the 3s global budget.
- Removed the unused `src/lib/platform.ts` helper.
- Removed committed TypeScript build output (`tsconfig.tsbuildinfo`).
- Removed unused Netlify, Wrangler, Docker and keep-alive deployment artifacts from the Vercel-focused project.
- Removed `clsx` and `lucide-react`; the UI now uses small local class expressions and a CSS spinner.
- Removed the blurred/dotted page background and heavy backdrop filters for better mobile rendering.
- Reduced excessive vertical spacing and improved touch target sizing.
- Added a prominent one-tap public DoH endpoint copy control.
- Corrected site metadata to use `https://freedns-six.vercel.app` instead of the GitHub repository as `metadataBase`.
- Added canonical, robots and Open Graph metadata.
- Disabled TypeScript incremental build artifacts in the repository.
- Kept the older provider routes for compatibility with the built-in diagnostic tester; they are no longer presented as the primary public FreeDNS service.

## V2.2 highlights

- Removed the `Custom` and `Manual Input` provider entries and their request-time upstream code.
- Fixed provider JSON routing so `/api/doh/google` uses Google `/resolve` and `/api/doh/adguard` uses AdGuard `/resolve`.
- Prevented RFC 8484 `dns=` payloads from being incorrectly forwarded to JSON `/resolve` endpoints.
- Kept `/api/doh/dns-query` unchanged as the primary public wire-format service.
- Kept provider-specific RFC 8484 routes such as `/api/doh/google/dns-query` and `/api/doh/adguard/dns-query`.
- Fixed OPTIONS handling and kept HEAD health responses local so upstreams do not need to support HEAD.
- Forwarded only allowlisted DNS query parameters to JSON upstreams, reducing accidental/conflicting parameters.
- Removed DNS.SB from the JSON tester because its configured route is wire-format oriented.

## V2.1 highlights

- Vercel deployment support retained.
- Netlify deployment support retained, including the Edge Function rate limiter.
- Existing `/api/doh/dns-query` route and request/response behavior preserved.
- Mobile UI simplified for faster rendering and less visual overhead.
- Removed unused frontend dependencies (`clsx`, `lucide-react`).
- Added a lightweight copy-to-clipboard control for the public endpoint.
- Reduced unnecessary CSS effects and spacing while preserving responsive behavior.
- Added `Vary: Accept, Origin` to improve cache correctness.
- Public upstream timeout reduced from 1200 ms to 1000 ms without changing the failover architecture.
- Removed unused `src/lib/platform.ts` and TypeScript incremental build state.

## Public DoH API

### GET

### RFC 8484 usage

- **GET:** send the DNS wire message in the `dns` query parameter.
- **POST:** send an `application/dns-message` request body.
- The endpoint does not accept arbitrary upstream URLs.


### Response behavior

The public route:

- rotates the primary HaGeZi upstream every 30 minutes by default;
- tries only one upstream at a time;
- falls through to the next upstream after a failure;
- gives the complete request a maximum 3-second upstream budget;
- does not intentionally cache DNS responses;
- does not expose the selected upstream URL;
- validates GET DNS messages and POST size/content type;
- returns CORS headers for public DoH clients.

The three upstreams are:

```text
https://root.hagezi.org/dns-query
https://wurzn.hagezi.org/dns-query
https://juuri.hagezi.org/dns-query
```

Rotation can be changed with:

```text
HAGEZI_ROTATION_SECONDS=1800
```

The allowed range is 60 seconds to 24 hours.

## Rate limiting and abuse protection

The application limiter remains:

```text
120 DNS requests/minute/IP per running instance
```

This is intentionally not treated as a global distributed limiter because serverless instances do not share an in-memory counter. For a public Vercel deployment, use the Vercel Firewall/WAF as the platform-level control and keep the application limiter as a second safety layer.

Recommended starting rule:

```text
Path: /api/doh/dns-query
Limit: 120 requests/minute/IP
Action: rate limit
```

Vercel provides a global firewall/WAF layer that can apply application-aware traffic rules at the edge.

## Website

The homepage is intentionally focused on the actual FreeDNS service rather than advertising the legacy multi-provider proxy as the main product.

It provides:

- the public DoH URL with a copy button;
- a compact DNS diagnostic tester;
- a short explanation of rotation/failover and abuse protection;
- mobile-friendly spacing and controls;
- lightweight CSS without the previous blurred background layers.

The diagnostic tester exposes only providers that support the JSON API. Google and AdGuard use their `/resolve` JSON APIs, while RFC 8484 wire-format clients should use their `/dns-query` routes.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `HAGEZI_ROTATION_SECONDS` | Primary-upstream rotation interval. | `1800` |
| `DEBUG_LOG` | Set to `true` to log successful request metadata as well as errors. | `false` |
| `PORT` | Standalone server port when using a custom Next.js deployment. | `8367` |

## Security notes

- DNS query bodies are not intentionally written to application logs.
- `DEBUG_LOG=true` logs request metadata, not the DNS message body.
- `Cache-Control: no-store` is used for DNS responses.
- The public endpoint does not accept arbitrary upstream URLs.
- The provider JSON routes are diagnostic compatibility endpoints; the hardened public service remains `/api/doh/dns-query`.
- A public DoH service can still consume substantial bandwidth under abuse, so platform-level traffic controls remain important.

## Deployment

This V2 package is focused on Vercel/Next.js deployment.

1. Push the repository to GitHub.
2. Import it into Vercel.
3. Deploy using the normal Next.js settings.
4. Test `HEAD /api/doh/dns-query`.
5. Add a Vercel Firewall rate-limit rule for `/api/doh/dns-query`.

Before production deployment, use the latest patched Next.js release available for your environment. Vercel's May 2026 security release notes specifically recommend upgrading affected Next.js applications to patched releases.
## Deployment

### Vercel

This repository is ready for Vercel deployment using the existing Next.js configuration.

### Netlify

Netlify support is intentionally preserved. The repository includes:

- `netlify.toml`
- `netlify/edge-functions/doh-rate-limit.ts`

The Netlify Edge Function provides the existing per-IP/domain rate-limit layer while the Next.js application handles the DoH proxy route.

### Other deployment files

The existing Docker, Wrangler, and GitHub Actions deployment/maintenance files are retained to avoid breaking previously supported workflows.

## Compatibility

The provider JSON routes and DNS tester remain for diagnostics. Custom/manual upstream selection is intentionally not exposed.

## Development

```bash
npm ci
npm run dev
```

Production checks:

```bash
npm run lint
npm run build
```

## Validation checklist

```text
✓ HEAD /api/doh/dns-query → 204
✓ Valid GET dns= query → 200
✓ Valid POST application/dns-message → 200
✓ Missing GET dns → 400
✓ Malformed dns → 400
✓ Oversized body → 413
✓ Unsupported POST content type → 415
✓ Application rate limit → 429 + Retry-After
✓ Upstream failure → sequential HaGeZi fallback
✓ Global timeout → bounded failure response
✓ No intentional DNS response caching
```


## 🏪 My Free DNS Server

Use **HaGeZi Blocklists Multi Pro + TIF** with My Free DNS.

| Service | DNS-over-HTTPS URL |
| --- | --- |
| Multi Pro + TIF (Recommended) | `https://freedns.koyeb.app/dns-query` |
| Multi Pro + TIF (Recommended) | `https://freedns-six.vercel.app/api/doh/dns-query` |
| Multi Pro + TIF (Backup) | `https://dnssix.netlify.app/api/doh/dns-query` |

## ⚡ Bandwidth Hero Server

A lightweight image proxy that cuts bandwidth and speeds up browsing. Fetches remote images, compresses them, and returns optimized versions for faster loading and lower data use.

🖥️ **Try it out:** https://bhserv.netlify.app/


## 💜 Support This Project

If you'd like to support development, consider donating:

**Bitcoin:** `1HntwKxyGCfnSGvGLMUTRAqLnTvLarAQP`


## License

AGPL-3.0

## Repository

https://github.com/anT0ny54/doh_proxy
