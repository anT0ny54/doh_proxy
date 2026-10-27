/**
 * Node.js proxy for the DoH endpoints: per-client rate limiting.
 *
 * Limit: RATE_LIMIT_PER_MINUTE requests (default 100) per rolling 60 seconds
 * per client, in BOTH trust modes:
 *
 * - TRUST_PROXY_HEADERS=1 (default): the client is identified by the trusted
 *   forwarding header (CLIENT_IP_HEADERS / TRUSTED_PROXY_HOPS; platform default
 *   otherwise), falling back to the socket address. When the socket address
 *   is known, the header is honored only if the TCP peer matches
 *   TRUSTED_PROXIES (default: loopback and private ranges).
 * - TRUST_PROXY_HEADERS=0: forwarding headers are ignored and the TCP socket
 *   address recorded by `server/socket-ip-preload.cjs` is used (the Docker
 *   image and `npm start` load it).
 *
 * Only when no address is available at all (trust disabled on a platform
 * without the preload) is the request counted against one shared bucket.
 * IPv6 clients are keyed by /64. State is per process; use a shared WAF for
 * cross-instance limits.
 *
 * The resolved client key is handed to the route in CLIENT_KEY_HEADER (always
 * overwritten or removed here, so a client cannot inject it); the route uses it
 * for the per-client in-flight cap without re-parsing headers.
 *
 * LOCATION: this file must live in `src/` because the app uses `src/app`.
 * Next.js only detects proxy.ts next to the `app` directory.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { CLIENT_KEY_HEADER, CONFIG } from "@/lib/config";
import { corsHeaders } from "@/lib/cors";
import { RateLimiter } from "@/lib/rate-limit";

const limiter = new RateLimiter(CONFIG.rateLimitPerMinute);

// Bucket for requests whose client address is unknown. Deliberately distinct
// from any normalized IP shape (no "." / ":" / "/64").
const UNKNOWN_CLIENT_KEY = "unknown-client";

function tooManyRequests(retryAfterSeconds: number): NextResponse {
  const headers = corsHeaders();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Retry-After", String(retryAfterSeconds));
  return new NextResponse("Too Many Requests", { status: 429, headers });
}

export default function proxy(request: NextRequest) {
  // OPTIONS (CORS preflight) and HEAD (health checks) are answered with a 204
  // before any upstream work, so they are not rate limited: browsers cannot
  // read a non-2xx preflight answer, and a monitor sharing a NAT/edge address
  // with real users must not consume their budget.
  if (request.method === "OPTIONS" || request.method === "HEAD") return NextResponse.next();

  const ip = getClientIp(request.headers);
  // Monotonic clock, not Date.now(): wall-clock corrections (NTP, VM resume)
  // must neither reset budgets nor freeze windows. RateLimiter also clamps
  // backwards input defensively, though performance.now() should not regress.
  const result = limiter.check(ip ?? UNKNOWN_CLIENT_KEY, Math.floor(performance.now()));
  if (result.limited) return tooManyRequests(result.retryAfterSeconds);

  const headers = new Headers(request.headers);
  if (ip === undefined) headers.delete(CLIENT_KEY_HEADER);
  else headers.set(CLIENT_KEY_HEADER, ip);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
