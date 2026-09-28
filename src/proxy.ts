/**
 * Node.js proxy for the public DoH endpoint.
 *
 * The limiter is enforced in-process before the request reaches the
 * Next.js route. For multi-instance deployments, use a shared reverse-proxy
 * or WAF rate limiter so the limit is shared across instances.
 *
 * Limit: 600 requests per 60 seconds per source IP by default (override with
 * RATE_LIMIT_PER_MINUTE). IPv6 clients are keyed by /64.
 *
 * IMPORTANT: When running behind a reverse proxy, configure that proxy to
 * sanitize X-Forwarded-For/X-Real-IP. Otherwise clients may spoof the IP.
 *
 * When neither header is present (for example the container is exposed
 * directly, without a reverse proxy) the client address is unknown, because
 * NextRequest does not expose the socket address. Such requests are NOT
 * limited: lumping every anonymous client into one shared bucket would cap the
 * whole service at a single client's quota and let one client lock out
 * everyone. Put a reverse proxy or WAF in front to get per-client limiting.
 *
 * LOCATION: this file must live in `src/` because the app uses `src/app`.
 * Next.js only detects proxy.ts/middleware.ts next to the `app` directory, so
 * a copy at the repository root is silently ignored (no rate limiting at all).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "./lib/client-ip";
import { RateLimiter, WINDOW_LIMIT } from "./lib/rate-limit";

function readLimit(): number {
  const configured = Number(process.env.RATE_LIMIT_PER_MINUTE?.trim());
  return Number.isInteger(configured) && configured > 0 ? configured : WINDOW_LIMIT;
}

const limiter = new RateLimiter(readLimit());

export default function proxy(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (ip === undefined) return NextResponse.next();

  // Rate-limit strictly by source IP. Including Host lets one client fragment
  // its quota across arbitrary Host values while adding no protection value.
  const result = limiter.check(ip, Date.now());

  if (result.limited) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(result.retryAfterSeconds),
        // Browser-based DoH clients need CORS headers to read the 429.
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Retry-After",
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
