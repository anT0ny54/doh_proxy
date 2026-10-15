/**
 * Node.js proxy for the DoH endpoints: per-client rate limiting.
 *
 * Limit: 100 requests per rolling 60 seconds per client (RATE_LIMIT_PER_MINUTE),
 * in BOTH trust modes:
 *
 * - TRUST_PROXY_HEADERS=1 (default): the client is identified by the trusted
 *   forwarding header (CLIENT_IP_HEADERS / TRUSTED_PROXY_HOPS; platform default
 *   otherwise), falling back to the socket address.
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
  // CORS preflights do no upstream work, and browsers cannot read a non-2xx
  // preflight answer, so they are not rate limited.
  if (request.method === "OPTIONS") return NextResponse.next();

  const ip = getClientIp(request.headers);
  const result = limiter.check(ip ?? UNKNOWN_CLIENT_KEY, Date.now());
  if (result.limited) return tooManyRequests(result.retryAfterSeconds);

  const headers = new Headers(request.headers);
  if (ip === undefined) headers.delete(CLIENT_KEY_HEADER);
  else headers.set(CLIENT_KEY_HEADER, ip);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
