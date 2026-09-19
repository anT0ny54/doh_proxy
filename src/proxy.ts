import { NextRequest, NextResponse } from "next/server";

/**
 * Simple in-memory rate limiter for DoH API routes.
 * For production deployments on Vercel/Netlify, platform-level rate limiting
 * (e.g., Netlify edge functions) is preferred. This middleware provides
 * basic protection for self-hosted Docker deployments.
 */

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // requests per window per IP
const RATE_LIMIT_PATHS = ["/api/doh/"];

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

function cleanupExpiredEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;

  for (const [key, entry] of rateLimitMap.entries()) {
    if (now >= entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
  lastCleanup = now;
}

function getClientIp(request: NextRequest): string {
  // Check various headers for client IP
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  // Fallback to a default (unknown client)
  return "unknown";
}

function isRateLimited(ip: string): boolean {
  cleanupExpiredEntries();

  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetTime) {
    rateLimitMap.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

export default function proxy(request: NextRequest) {
  // Only apply rate limiting to DoH API routes
  const isDoHRoute = RATE_LIMIT_PATHS.some((path) => 
    request.nextUrl.pathname.startsWith(path)
  );

  if (!isDoHRoute) {
    return NextResponse.next();
  }

  const clientIp = getClientIp(request);

  if (isRateLimited(clientIp)) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/doh/:path*"],
};
