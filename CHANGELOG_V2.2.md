FreeDNS DoH Proxy V2.2 review/fix

Changes:
- Removed Custom and Manual Input provider code and UI.
- Fixed Google JSON endpoint: /api/doh/google -> https://dns.google/resolve.
- Fixed AdGuard JSON endpoint: /api/doh/adguard -> https://dns.adguard-dns.com/resolve.
- Kept /api/doh/dns-query source and behavior intact.
- Kept provider RFC 8484 routes, including /google/dns-query and /adguard/dns-query.
- Prevented dns= wire queries from being sent to JSON /resolve endpoints.
- JSON provider requests now use an explicit application/dns-json Accept header.
- Only allowlisted JSON query parameters are forwarded upstream.
- Fixed OPTIONS/HEAD handling so diagnostic routes do not depend on upstream HEAD support.
- Removed DNS.SB from the JSON tester because its configured route is wire-format oriented.
- Bumped project/proxy version to 2.2.0.
- Updated README to reflect the new architecture.

Validation:
- TypeScript/TSX syntax transpilation check passed for all modified TS/TSX files.
- Full npm lint/build could not be completed because the sandbox dependency installation timed out and left node_modules incomplete.
