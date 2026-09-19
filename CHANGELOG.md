# FreeDNS DoH Proxy — Changelog

## v2.6.0 — Build/tooling conflict fixes

- Fixed a regression from v2.5.0: removing the standalone Next.js output (to stop it breaking the Vercel/Netlify build) had left `Dockerfile` still copying `.next/standalone`, so `docker build` no longer produced a working image. `next.config.ts` now emits `output: "standalone"` only when neither `VERCEL` nor `NETLIFY` is set in the build environment, so Docker gets its standalone bundle back without reintroducing the managed-platform build failure.
- Pinned `typescript` to `^6.0.3` instead of `^7`. TypeScript 7's npm package dropped the classic JS compiler API that `typescript-eslint` needs (it's pulled in by `eslint-config-next`'s `next/typescript` preset in `eslint.config.mjs`), so `npm run lint` would fail under TypeScript 7 as installed. `next build`'s own type-checking is unaffected by this change either way.
- Removed the now-stale `package-lock.json` rather than leave it out of sync with the `typescript` version change; the repo's existing "Generate package-lock.json" workflow regenerates it. `Dockerfile`'s dependency stage now uses `npm install` instead of `npm ci` so a regenerating/absent lockfile doesn't hard-fail the build; `README.md` updated to match.
- Documented the previously-undocumented Docker self-host path in `README.md`.
- Bumped the application/proxy version to 2.6.0.
- No public API, route, or wire-format behavior changed.

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
