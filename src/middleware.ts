import { NextRequest, NextResponse } from "next/server";

// Konfigurasi Rate Limit
const WINDOW_MS = 60 * 1000; // Jendela waktu: 1 Menit
const MAX_REQUESTS = 60;     // Maksimal 60 request per IP per menit

// Penyimpanan in-memory sederhana di Edge (Map)
// Catatan: Efektif untuk membatasi lonjakan instan di masing-masing region edge node.
const ipRequestMap = new Map<string, { count: number; resetTime: number }>();

// Membersihkan data lama secara berkala agar memori tidak penuh
setInterval(() => {
  const now = Date.now();
  ipRequestMap.forEach((data, ip) => {
    if (now > data.resetTime) {
      ipRequestMap.delete(ip);
    }
  }, 30000);
}, 30000);

export function middleware(request: NextRequest) {
  // Hanya terapkan rate limiting pada rute API DoH
  if (!request.nextUrl.pathname.startsWith("/api/doh")) {
    return NextResponse.next();
  }

  // Deteksi IP klien secara multi-platform (Vercel & Netlify)
  const netlifyIP = request.headers.get("x-nf-client-connection-ip");
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");

  const clientIP = netlifyIP || (forwardedFor ? forwardedFor.split(",")[0].trim() : null) || realIP || "127.0.0.1";

  const now = Date.now();
  let record = ipRequestMap.get(clientIP);

  if (!record || now > record.resetTime) {
    record = {
      count: 1,
      resetTime: now + WINDOW_MS,
    };
    ipRequestMap.set(clientIP, record);
  } else {
    record.count += 1;
  }

  // Hitung sisa kuota
  const remaining = Math.max(0, MAX_REQUESTS - record.count);
  const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

  // Jika melebihi batas, kembalikan HTTP 429 Too Many Requests
  if (record.count > MAX_REQUESTS) {
    return NextResponse.json(
      {
        error: "Too Many Requests",
        message: "Batas permintaan DoH terlampaui. Silakan coba beberapa saat lagi.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(resetSeconds),
          "X-RateLimit-Limit": String(MAX_REQUESTS),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(record.resetTime),
        },
      }
    );
  }

  // Lanjutkan request dan sisipkan header informasi rate limit
  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Limit", String(MAX_REQUESTS));
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  response.headers.set("X-RateLimit-Reset", String(record.resetTime));

  return response;
}

// Konfigurasi matcher agar middleware hanya berjalan pada rute API yang dituju
export const config = {
  matcher: "/api/doh/:path*",
};