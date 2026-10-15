# Public Instances and Related Projects

These are deployments and projects run by the author of [FreeDNS DoH Proxy](README.md). They are listed here, not in the README, because they are not part of this codebase. Some instances run a different implementation.

## Free DNS services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF). Entries whose path is `/dns-query` (without `/api/doh/`) use a different path layout from this codebase's `/api/doh/dns-query`.

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

## Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

**Live demo:** [Bandwidth Hero](https://bhserv.netlify.app/).
