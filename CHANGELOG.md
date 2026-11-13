# Changelog

## [2.11.0] - 2026-11-06

The version is unchanged. The entry below is the latest modified log for this
release (review pass, 2026-11-14; fourth merged-tree audit).

### Modified

#### Fixed
- Docker image SemVer tags are now enabled only for a `push` event to a tag. A manual `workflow_dispatch` run against a version-tag ref could otherwise publish release tags and move `latest`, contradicting the documented branch/SHA-only behavior. The workflow and README now agree.
- The lockfile-updater and keep-alive workflows now skip manual runs dispatched from tag refs. Both workflows create commits and push to `GITHUB_REF_NAME`; a tag ref is not a writable branch target. Scheduled keep-alive runs and branch-based manual runs are unchanged.
- Cache-Control freshness parsing now recognizes commas only outside quoted
  extension values. A `max-age`-looking token inside a quoted extension could
  previously be mistaken for a real directive and grant freshness the upstream
  did not provide; real `no-cache`/`no-store` directives and malformed quoting
  now fail closed. Regression tests cover both false-positive and real directives.
- NSAP-PTR (type 23) RDATA is validated as its historical single
  character-string, not as a domain name. The prior layout could reject valid
  records and incorrectly treat string contents as eligible compression targets.
- DELEG/DELEGPARAM validation now rejects non-empty DelegInfo lists without
  exactly one allowed server-information set. Previously, incompatible sets
  such as IPv4 plus server-name could pass; tests cover the valid address/name
  alternatives and invalid mixtures.
- DNS compression suffix indexing now includes the root label. A valid backward
  pointer to the root QNAME or to the root suffix of another fully uncompressed
  name was previously rejected; regression tests cover both forms.
- `X-Forwarded-For` parsing now preserves empty list fields while counting
  `TRUSTED_PROXY_HOPS`. Previously, filtering empty fields could shift the
  selected position and use an earlier client-supplied address when a trusted
  proxy chain was malformed. An empty or invalid selected hop now fails closed
  to the socket-address fallback; regression coverage was added.
- DNSSEC response validation now parses RRSIG (type 46) Signer's Name and
  NSEC (type 47) Next Domain Name as uncompressed domain names, as required by
  RFC 4034. They were previously treated as opaque RDATA, so truncated or
  illegally compressed embedded names could pass structural validation, and
  valid names could not be used as compression targets by later records.
- DNS compression pointers now target only literal-label suffixes from earlier,
  fully uncompressed names. Nested pointer chains are rejected instead of
  followed, following RFC 9267 section 2; cached suffix lengths keep accepted
  pointer resolution bounded without repeated pointer traversal.
- Chunked framing: the DoH handler set a `Content-Length` header on successful
  answers, but Next.js discards that header from route handlers
  (`send-response.js`), so it never reached clients. The dead header is removed.
  `README.md` and the integration suite previously described and asserted an
  explicit `Content-Length` that the server never sent; they now state and test
  the real chunked framing.

#### Changed
- `fetchUpstream` names its per-attempt abort signal `attemptSignal` (it was
  called `deadline`, which was misleading). Behavior is unchanged.
- `README.md` now documents the DNSSEC RDATA layouts, their compression rules,
  the nested-pointer rejection policy, and fail-closed handling of empty
  `X-Forwarded-For` hop fields. The unrelated Bandwidth Hero Server blurb was
  removed from the related-projects section.
- The second full-project audit expanded the known DNS RDATA layouts to cover
  the historical NSAP-PTR character-string layout, A6, IPSECKEY, HIP, TALINK,
  LP, TKEY, TSIG, AMTRELAY, DSYNC, and the currently assigned DELEGPARAM/DELEG
  types. DNSSEC bitmap and ordered
  parameter framing checks were expanded at the same time. SVCB/HTTPS and
  DELEG/DELEGPARAM mandatory-key lists are now checked for ordering, valid
  contents, and the presence of every referenced key; invalid empty mandatory
  parameters previously used by SVCB regression fixtures were corrected.

#### Removed (no behavior change)
- The unused `corsHeaders` export in `src/lib/cors.ts`; it is only used inside
  that module.
- The obsolete NXT entry in the generic RDATA layout table (NXT now has a
  dedicated bitmap validator), and redundant SVCB/HTTPS opaque-tail flags
  (their SvcParam lists are parsed explicitly).
- A garbled comment in `scripts/test-doh.mjs` (the half-open breaker test).

#### Verified
- `npm test`: 144 of 144 pass on Node.js 22.16.0. The regression suite covers
  root-label compression targets, NSAP-PTR character-string framing, valid and
  invalid DELEG server-information sets, empty X-Forwarded-For hop fields, and
  the additional RR-layout, bitmap, and ordered-parameter cases, plus quoted
  Cache-Control extension handling. The test helper used the available
  TypeScript 5.8.3 transpiler through a temporary
  workspace symlink; the project manifest and lockfile remain pinned to
  TypeScript 6.0.3. A standalone strict TypeScript compile of `src/lib/dns.ts`
  also passed.
- The workspace has no installed Next.js, React or Node.js type dependencies.
  A full `tsc --noEmit` therefore cannot resolve those packages, and lint,
  production build and integration tests could not be rerun in this pass. The
  previous full-environment verification recorded for this release passed
  lint, typecheck and build, with 16 of 16 integration tests passing on Node.js
  22.23.4. The earlier `npm ci --ignore-scripts` attempt did not finish within
  its 120-second network window.
