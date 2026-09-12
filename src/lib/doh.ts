import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_QUERY_STRING_LENGTH = 8_192;
const MAX_DNS_MESSAGE_SIZE = 4_096;
const DNS_MESSAGE = "application/dns-message";
const PROXY_VERSION = "2.3.0";
const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function baseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    Vary: "Accept, Origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

function response(body: BodyInit | null, status: number, contentType = "text/plain; charset=utf-8"): NextResponse {
  const headers = baseHeaders();
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || value.length > MAX_QUERY_STRING_LENGTH || value.length % 4 === 1 || !BASE64URL.test(value)) {
    return null;
  }

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    if (binary.length < 12 || binary.length > MAX_DNS_MESSAGE_SIZE) return null;

    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const qdCount = (bytes[4] << 8) | bytes[5];
    if (qdCount < 1) return null;
    return bytes;
  } catch {
    return null;
  }
}

function validateGet(url: URL): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return response("Query string too long", 414);
  }

  const dns = url.searchParams.get("dns");
  if (!dns || decodeBase64Url(dns) === null) {
    return response("Invalid DNS message", 400);
  }

  return null;
}

async function readPostBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) {
    return response("Unsupported Content-Type", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size < 12) return response("Invalid DNS message", 400);
    if (size > MAX_DNS_MESSAGE_SIZE) return response("Payload too large", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength < 12) return response("Invalid DNS message", 400);
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return response("Payload too large", 413);
  return body;
}

export async function handleDoH(request: NextRequest, providerId: string, formatSegment?: string): Promise<NextResponse> {
  if (formatSegment !== "dns-query") {
    return response("Not Found", 404);
  }

  const provider = getProvider(providerId);
  if (!provider) return response("Not Found", 404);

  if (request.method === "OPTIONS") {
    return response(null, 204, "");
  }

  if (request.method === "HEAD") {
    const result = response(null, 204, "");
    result.headers.set("Content-Length", "0");
    return result;
  }

  if (request.method !== "GET" && request.method !== "POST") {
    const result = response("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
    return result;
  }

  const url = new URL(request.url);
  let body: ArrayBuffer | undefined;

  if (request.method === "GET") {
    const validationError = validateGet(url);
    if (validationError) return validationError;
  } else {
    const bodyResult = await readPostBody(request);
    if (bodyResult instanceof NextResponse) return bodyResult;
    body = bodyResult;
  }

  const upstreamUrl = new URL(provider.endpoint);
  if (request.method === "GET") {
    upstreamUrl.search = `?dns=${encodeURIComponent(url.searchParams.get("dns")!)}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamHeaders = new Headers({
      Accept: DNS_MESSAGE,
      "User-Agent": USER_AGENT,
    });
    if (request.method === "POST") upstreamHeaders.set("Content-Type", DNS_MESSAGE);

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    const headers = baseHeaders();
    headers.set("Content-Type", upstreamResponse.headers.get("content-type") || DNS_MESSAGE);

    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (caught: unknown) {
    const isTimeout = caught instanceof Error && caught.name === "AbortError";
    return response(isTimeout ? "DNS upstream timeout" : "DNS upstream unavailable", isTimeout ? 504 : 502);
  } finally {
    clearTimeout(timeoutId);
  }
}
