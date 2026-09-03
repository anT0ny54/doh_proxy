import { NextRequest, NextResponse } from "next/server";
import { getNormalizedHeaders } from "@/lib/platform";
import { DOH_PROVIDERS } from "@/lib/providers"; // Memastikan daftar provider internal tetap terbaca

// Memaksa Route ini berjalan di Edge Runtime milik Vercel & Netlify untuk latensi ultra rendah
export const runtime = "edge";
export const dynamic = "force-dynamic";

const GLOBAL_TIMEOUT = 3000; // 3000ms global budget

export async function GET(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  return handleDohRequest(request, params.provider);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  return handleDohRequest(request, params.provider);
}

export async function HEAD() {
  // Health check standar load balancer (204 No Content)
  return new NextResponse(null, { status: 204 });
}

async function handleDohRequest(request: NextRequest, providerId: string) {
  // Support untuk format sub-paths seperti /dns-query atau /resolve secara transparan
  const { searchParams } = new URL(request.url);
  
  // Mencari provider dari daftar berkas konfigurasi lokal
  let upstreamUrl = "";
  
  if (providerId === "custom") {
    upstreamUrl = process.env.CUSTOM_DOH_URL || "";
  } else {
    const provider = DOH_PROVIDERS.find((p) => p.id === providerId);
    upstreamUrl = provider ? provider.endpoint : "";
  }

  // Proteksi jika provider tidak ditemukan atau Custom URL kosong
  if (!upstreamUrl) {
    return NextResponse.json(
      { error: `Provider '${providerId}' tidak dikonfigurasi atau tidak valid.` },
      { status: 400 }
    );
  }

  // Normalisasi query string untuk wire-format (?dns=...) maupun JSON
  const targetUrl = new URL(upstreamUrl);
  searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const headers = getNormalizedHeaders(request);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT);

  try {
    const method = request.method;
    const body = method === "POST" ? await request.arrayBuffer() : undefined;

    const upstreamResponse = await fetch(targetUrl.toString(), {
      method,
      headers: {
        ...headers,
        // Teruskan Content-Type asli jika ada (sangat penting untuk POST wire-format)
        "Content-Type": request.headers.get("content-type") || "application/dns-message",
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Membaca response stream dari upstream DNS
    const responseData = await upstreamResponse.arrayBuffer();

    return new NextResponse(responseData, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("content-type") || "application/dns-message",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });

  } catch (error: any) {
    clearTimeout(timeoutId);
    const isTimeout = error.name === "AbortError";
    
    return NextResponse.json(
      { 
        error: isTimeout ? "Upstream DNS Timeout" : "Bad Gateway",
        details: error.message 
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
