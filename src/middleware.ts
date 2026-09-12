import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 120;
const MAX_TRACKED_IPS = 10_000;
const DOH_PREFIX = "/api/doh/";

type RateLimitRecord = { count: number; resetTime: number };
const rateLimits = new Map<string, RateLimitRecord>();

function getClientIP(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function pruneExpired(now: number): void {
  if (rateLimits.size < MAX_TRACKED_IPS) return;
  for (const [ip, record] of rateLimits) {
    if (record.resetTime <= now) rateLimits.delete(ip);
  }
  if (rateLimits.size >= MAX_TRACKED_IPS) {
    const oldest = rateLimits.keys().next().value as string | undefined;
    if (oldest) rateLimits.delete(oldest);
  }
}

export function middleware(request: NextRequest): NextResponse {
  if (!request.nextUrl.pathname.startsWith(DOH_PREFIX) || request.method === "OPTIONS" || request.method === "HEAD") {
    return NextResponse.next();
  }

  const now = Date.now();
  const ip = getClientIP(request);
  pruneExpired(now);

  let record = rateLimits.get(ip);
  if (!record || record.resetTime <= now) {
    record = { count: 0, resetTime: now + WINDOW_MS };
    rateLimits.set(ip, record);
  }

  record.count += 1;
  const remaining = Math.max(0, MAX_REQUESTS - record.count);
  const resetSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
  const headers = new Headers({
    "RateLimit-Limit": String(MAX_REQUESTS),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(Math.ceil(record.resetTime / 1000)),
    "X-RateLimit-Limit": String(MAX_REQUESTS),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(record.resetTime),
  });

  if (record.count > MAX_REQUESTS) {
    headers.set("Retry-After", String(resetSeconds));
    return NextResponse.json(
      { error: "Too Many Requests", message: "DoH request rate limit exceeded. Please try again later." },
      { status: 429, headers },
    );
  }

  const response = NextResponse.next();
  for (const [key, value] of headers) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: "/api/doh/:path*",
};
