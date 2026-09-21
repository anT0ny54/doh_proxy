/**
 * Node.js proxy for the public DoH endpoint.
 *
 * The limiter is enforced in-process before the request reaches the
 * Next.js route. For multi-instance deployments, use a shared reverse-proxy
 * or WAF rate limiter so the limit is shared across instances.
 *
 * Limit: 100 requests per 60 seconds per IP + host.
 *
 * IMPORTANT: When running behind a reverse proxy, configure that proxy to
 * sanitize X-Forwarded-For/X-Real-IP. Otherwise clients may spoof the IP.
 *
 * When neither header is present (for example the container is exposed
 * directly, without a reverse proxy) the client address is unknown, because
 * NextRequest does not expose the socket address. Such requests are NOT
 * limited: lumping every anonymous client into one shared bucket would cap the
 * whole service at 100 requests/minute and let one client lock out everyone.
 * Put a reverse proxy or WAF in front to get per-client limiting.
 */

import { NextResponse, type NextRequest } from "next/server";
import { RateLimiter } from "./src/lib/rate-limit";

// Header values are attacker-controlled; bound them so the bucket keys (and
// therefore memory) stay small. 64 covers the longest textual IPv6 address.
const MAX_IP_LENGTH = 64;
const MAX_HOST_LENGTH = 255;

const limiter = new RateLimiter();

function getClientIp(request: NextRequest): string | undefined {
  // Prefer X-Real-IP when supplied by a trusted reverse proxy.
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, MAX_IP_LENGTH);

  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (forwarded) return forwarded.slice(0, MAX_IP_LENGTH);

  return undefined;
}

export default function proxy(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith("/api/doh/")) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  if (ip === undefined) return NextResponse.next();

  const host = (request.headers.get("host") ?? request.nextUrl.host).slice(0, MAX_HOST_LENGTH);
  const result = limiter.check(`${ip}\u0000${host}`, Date.now());

  if (result.limited) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(result.retryAfterSeconds),
        // Browser-based DoH clients need CORS headers to read the 429.
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
