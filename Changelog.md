# FreeDNS DoH Proxy —  Changelog Notes

## Changes v1

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

## Changes v2

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

## Optimization focus v3

This release consolidates all DoH request handling into one bounded proxy path so `/api/doh/dns-query` and every fixed provider endpoint share the same validation, timeout, failover, response, CORS, and security behavior.

### Request path improvements

- RFC 8484 GET and POST handling remain supported.
- Only the `dns` query parameter is forwarded for GET requests; unrelated client query parameters never reach an upstream.
- DNS queries are checked for minimum size, one question, normal opcode, and query direction (`QR=0`).
- POST bodies are bounded before/after reading when `Content-Length` is available.
- Upstream redirects are rejected instead of followed.
- Only `application/dns-message` upstream responses are accepted.
- Upstream response size is bounded when `Content-Length` is supplied.
- A single total timeout budget is shared by the HaGeZi failover chain, preventing N x timeout latency.
- Fixed provider routes intentionally have no failover to a different provider.
- Arbitrary/custom upstream forwarding remains disabled.