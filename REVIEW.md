# FreeDNS DoH Proxy 2.6.0 review

## Optimization focus

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

### Runtime/code improvements

- Removed duplicated request/proxy logic across provider and primary routes.
- Provider lookup uses a prebuilt `Map`.
- Constants and immutable provider/upstream definitions are shared and readonly.
- Response headers are generated consistently from one helper.
- Added `typecheck` and combined `check` scripts.

## API surface

Supported:

- `/api/doh/dns-query`
- `/api/doh/google/dns-query`
- `/api/doh/cloudflare/dns-query`
- `/api/doh/adguard/dns-query`
- `/api/doh/dnssb/dns-query`

Removed/unsupported:

- `/api/doh/custom`
- `/api/doh/manual?upstream=...`
- arbitrary upstream forwarding
- provider-root JSON routing

## Validation

A source-level audit was performed after the optimization. Full dependency installation/build could not be completed in the sandbox because `npm ci --ignore-scripts` timed out, so no claim of a completed production Next.js build is made here.

## v2.6.0 compatibility-first revision

- Restored broad RFC 8484 DNS wire-message compatibility.
- Removed the v2.5 semantic restrictions on opcode, QDCOUNT, and other DNS flags.
- Raised the wire-message limit to the RFC 8484 maximum of 65,535 bytes.
- Reusable POST payloads are now `Uint8Array` values, so HaGeZi failover does not reuse a consumed `ArrayBuffer` body.
- Added separate per-upstream and total failover time budgets.
- Kept fixed provider upstreams and SSRF-safe routing.
- Retained redirect blocking, request-size protection, CORS, and consistent security headers.
