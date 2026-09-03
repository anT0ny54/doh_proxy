import { NextRequest } from "next/server";

export function getClientIP(request: NextRequest): string {
  // 1. Cek header spesifik Netlify
  const netlifyIP = request.headers.get("x-nf-client-connection-ip");
  if (netlifyIP) return netlifyIP;

  // 2. Cek header standar proxy / Vercel
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const ip = forwardedFor.split(",")[0].trim();
    if (ip) return ip;
  }

  // 3. Fallback header umum lainnya
  const realIP = request.headers.get("x-real-ip");
  if (realIP) return realIP;

  return "127.0.0.1";
}

export function getNormalizedHeaders(request: NextRequest) {
  const clientIP = getClientIP(request);
  const acceptHeader = request.headers.get("accept") || "application/dns-json";

  return {
    "Accept": acceptHeader,
    "X-Forwarded-For": clientIP,
    "User-Agent": request.headers.get("user-agent") || "DoH-Proxy-Client",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  };
}
