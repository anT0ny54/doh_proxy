/**
 * Node.js proxy for the public DoH endpoint.
 *
 * The limiter is enforced in-process before the request reaches the
 * Next.js route. For multi-instance deployments, use a shared reverse-proxy
 * or WAF rate limiter so the limit is shared across instances.
 *
 * Limit: 100 requests per 60 seconds per source IP by default (override with
 * RATE_LIMIT_PER_MINUTE). IPv6 clients are keyed by /64.
 *
 * TRUSTED-PROXY BOUNDARY: client identity comes from X-Real-IP /
 * X-Forwarded-For, which a direct client can forge. These headers are trusted
 * BY DEFAULT (TRUST_PROXY_HEADERS unset or truthy), so deploy behind a reverse
 * proxy (nginx, Caddy, a platform front end, ...) that overwrites or sanitizes
 * them on every request, and set TRUST_PROXY_HEADERS=0 when the app is exposed
 * directly. See src/lib/client-ip.ts. When trust is disabled, or when no
 * usable header is present, the client address is unknown and the request is
 * counted against a SHARED GLOBAL bucket (same limit) instead of being
 * unlimited, so identity cannot be evaded simply by omitting the headers.
 *
 * LOCATION: this file must live in `src/` because the app uses `src/app`.
 * Next.js only detects proxy.ts/middleware.ts next to the `app` directory, so
 * a copy at the repository root is silently ignored (no rate limiting at all).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp, isProxyTrustEnabled } from "./lib/client-ip";
import { RateLimiter, WINDOW_LIMIT } from "./lib/rate-limit";

function readLimit(): number {
  const configured = Number(process.env.RATE_LIMIT_PER_MINUTE?.trim());
  return Number.isInteger(configured) && configured > 0 ? configured : WINDOW_LIMIT;
}

const limiter = new RateLimiter(readLimit());

// Bucket key for requests without a trusted identity (TRUST_PROXY_HEADERS=0
// or no usable X-Real-IP / X-Forwarded-For). One shared bucket means the
// per-IP limit cannot be dodged by forging or omitting forwarding headers.
// Deliberately distinct from any normalized IP shape (no ":" or "/64").
const UNKNOWN_CLIENT_KEY = "unknown-client";

function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return new NextResponse("Too Many Requests", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds),
      // Browser-based DoH clients need CORS headers to read the 429.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Retry-After",
    },
  });
}

export default function proxy(request: NextRequest) {
  const ip = getClientIp(request.headers, isProxyTrustEnabled());

  // Rate-limit strictly by source IP. Including Host lets one client fragment
  // its quota across arbitrary Host values while adding no protection value.
  // Requests without a trusted identity share one global bucket.
  const result = limiter.check(ip ?? UNKNOWN_CLIENT_KEY, Date.now());

  if (result.limited) return tooManyRequests(result.retryAfterSeconds);

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
