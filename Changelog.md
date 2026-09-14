# FreeDNS DoH Proxy — Changelog

## v2.5.0 — Vercel + Netlify optimization

- Preserved all five public DoH endpoint paths and their RFC 8484 GET/POST behavior.
- Added bounded streaming POST-body reads so oversized chunked uploads are rejected without buffering an unbounded request body.
- Forwarded only the validated `dns` query parameter to GET upstreams, preventing unrelated query parameters from being propagated.
- Kept `Cache-Control: no-store` authoritative instead of allowing an upstream cache header to override the proxy policy.
- Preferred Vercel's `x-vercel-forwarded-for` client-IP header for the application rate limiter.
- Expanded Netlify's platform rate-limit rule from the primary route to every `/api/doh/*` route.
- Removed the self-hosting-only Next.js standalone output from the Vercel/Netlify build target.
- Bumped the application/proxy version to 2.5.0.

## v2.4.0 — Codebase cleanup

- Removed a dead, unused `DoHProvider` type import in `src/lib/doh.ts`.
- Removed duplicated provider data: the homepage (`src/app/page.tsx`) now derives its provider endpoint list from `src/lib/providers.ts` instead of maintaining a second hardcoded copy.
- Avoided redundant URL re-parsing on every upstream failover attempt in `src/lib/doh.ts` (the request URL is now parsed once and passed through).
- Removed `wrangler.toml`: it had no CI workflow wiring it up, and its `pages_build_output_dir` setting was inconsistent with this project's actual (Vercel/Netlify-focused) build output. Not needed for the stated Vercel/Netlify deployment targets.
- Rewrote `README.md` to remove contradictory statements left over from prior edits (it simultaneously claimed Netlify/Wrangler/Docker artifacts were both "removed" and "retained"), merged two duplicate `## Deployment` sections, and removed documentation for a `DEBUG_LOG` variable that was never actually implemented anywhere in the code.
- Rewrote this changelog: the previous "Changes v1" and "Changes v2" sections were byte-for-byte identical, which was itself a leftover duplication bug.
- No public API, route, or wire-format behavior changed. `/api/doh/dns-query` and the four provider routes (`google`, `cloudflare`, `adguard`, `dnssb`) behave exactly as before.

## v2.3.0 and earlier

- Established `/api/doh/dns-query` as the primary HaGeZi-backed RFC 8484 endpoint, with GET `?dns=` and POST `application/dns-message` support.
- Added deterministic HaGeZi upstream rotation and sequential failover.
- Added four fixed, wire-format-only provider endpoints: `google`, `cloudflare`, `adguard`, `dnssb`.
- Removed the legacy provider-root JSON routing layer and its client-side DNS tester dependency; eliminated arbitrary upstream selection.
- Extended the in-process rate limiter to all `/api/doh/*` routes.
- Preserved `no-store`, CORS, bounded timeouts, and 4 KiB message limits throughout.
- Fixed a Docker build context conflict caused by copying a non-existent `public/` directory.
