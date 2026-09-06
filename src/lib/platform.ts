import { NextRequest } from "next/server";

export function getClientIP(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function getNormalizedHeaders(request: NextRequest): Record<string, string> {
  return {
    Accept: request.headers.get("accept") || "application/dns-json",
    "X-Forwarded-For": getClientIP(request),
    "User-Agent": request.headers.get("user-agent") || "DoH-Proxy-Client",
    "Cache-Control": "no-store",
  };
}
