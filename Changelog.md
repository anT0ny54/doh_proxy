# FreeDNS DoH Proxy —  Changelog Notes

## Changes

- Kept `/api/doh/dns-query` as the primary HaGeZi-backed RFC 8484 endpoint.
- Kept GET `?dns=` and POST `application/dns-message` behavior.
- Kept deterministic HaGeZi rotation and sequential failover.
- Added four explicit provider DoH endpoints to the website:
  - `/api/doh/google/dns-query`
  - `/api/doh/cloudflare/dns-query`
  - `/api/doh/adguard/dns-query`
  - `/api/doh/dnssb/dns-query`
- Provider endpoints are now wire-format only and use fixed upstream URLs.
- Removed the legacy provider-root JSON routing layer and its client-side DNS tester dependency.
- Eliminated arbitrary upstream selection from the provider implementation.
- Extended the in-process rate limiter to all `/api/doh/*` routes.
- Preserved `no-store`, CORS, bounded timeouts, and 4 KiB message limits.
- Fixed the Docker build context conflict caused by copying a non-existent `public/` directory.
- Updated package metadata to version `2.3.0`.
- Rewrote the README to match the actual API surface instead of the inherited repository documentation.
- Simplified the homepage around the public service and the four fixed provider endpoints.

## Validation

- All TypeScript/TSX source files pass a TypeScript transpilation/syntax check using TypeScript 5 available in the environment.
- A full `npm run lint` / `npm run build` was not executable in the sandbox because the project dependencies could not be installed successfully; the initial `npm ci` attempt timed out and left no local Next.js/ESLint binaries.
- The live Vercel page was successfully inspected and confirmed to expose the existing public `/api/doh/dns-query` URL and HaGeZi-oriented service description at review time.

## Deployment note

The changes are contained in the supplied source tree. The live Vercel deployment is not modified by this archive; redeploy the repository to publish the new homepage and provider endpoints.
