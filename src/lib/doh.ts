import { NextRequest, NextResponse } from "next/server";
import { getProvider, type DoHProvider } from "@/lib/providers";

export const DNS_MESSAGE = "application/dns-message";
export const PROXY_VERSION = "2.4.0";

const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const MAX_DNS_MESSAGE_SIZE = 4_096;
const MAX_QUERY_STRING_LENGTH = 8_192;
const REQUEST_TIMEOUT_MS = 2_500;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export interface DoHUpstream {
  endpoint: string;
  name: string;
}

export interface DoHOptions {
  upstreams: readonly DoHUpstream[];
  timeoutMs?: number;
  failover?: boolean;
}

const HAGEZI_UPSTREAMS: readonly DoHUpstream[] = [
  { name: "HaGeZi root", endpoint: "https://root.hagezi.org/dns-query" },
  { name: "HaGeZi wurzn", endpoint: "https://wurzn.hagezi.org/dns-query" },
  { name: "HaGeZi juuri", endpoint: "https://juuri.hagezi.org/dns-query" },
];

export function getHageziUpstreams(): readonly DoHUpstream[] {
  const defaultSeconds = 1_800;
  const minSeconds = 60;
  const maxSeconds = 86_400;
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? defaultSeconds);
  const seconds = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), minSeconds), maxSeconds)
    : defaultSeconds;
  const slot = Math.floor(Date.now() / (seconds * 1_000)) % HAGEZI_UPSTREAMS.length;

  return Array.from({ length: HAGEZI_UPSTREAMS.length }, (_, offset) =>
    HAGEZI_UPSTREAMS[(slot + offset) % HAGEZI_UPSTREAMS.length],
  );
}

export function getProviderUpstream(providerId: string): DoHUpstream | undefined {
  const provider = getProvider(providerId);
  return provider ? { name: provider.name, endpoint: provider.endpoint } : undefined;
}

function baseHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'",
    Expires: "0",
    Pragma: "no-cache",
    Vary: "Accept, Origin",
    "X-Content-Type-Options": "nosniff",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

export function textResponse(message: string, status: number): NextResponse {
  const headers = baseHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new NextResponse(message, { status, headers });
}

function emptyResponse(status = 204): NextResponse {
  return new NextResponse(null, { status, headers: baseHeaders() });
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
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return textResponse("Query string too long", 414);

  const dns = url.searchParams.get("dns");
  if (!dns || decodeBase64Url(dns) === null) return textResponse("Invalid DNS message", 400);

  return null;
}

async function readPostBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) return textResponse("Unsupported Content-Type", 415);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size < 12) return textResponse("Invalid DNS message", 400);
    if (size > MAX_DNS_MESSAGE_SIZE) return textResponse("Payload too large", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength < 12) return textResponse("Invalid DNS message", 400);
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return textResponse("Payload too large", 413);
  return body;
}

async function fetchUpstream(
  request: NextRequest,
  upstream: DoHUpstream,
  body: ArrayBuffer | undefined,
  timeoutMs: number,
): Promise<Response> {
  const url = new URL(upstream.endpoint);
  if (request.method === "GET") {
    url.search = new URL(request.url).search;
  }

  const headers = new Headers({
    Accept: DNS_MESSAGE,
    "User-Agent": USER_AGENT,
  });
  if (request.method === "POST") headers.set("Content-Type", DNS_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyRequest(
  request: NextRequest,
  options: DoHOptions,
): Promise<NextResponse> {
  if (request.method === "OPTIONS") return emptyResponse();

  if (request.method === "HEAD") {
    const result = emptyResponse();
    result.headers.set("Content-Length", "0");
    return result;
  }

  if (request.method !== "GET" && request.method !== "POST") {
    const result = textResponse("Method Not Allowed", 405);
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

  const timeout = Math.max(250, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const deadline = Date.now() + timeout;
  const upstreams = options.failover === false ? options.upstreams.slice(0, 1) : options.upstreams;

  for (const upstream of upstreams) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const result = await fetchUpstream(request, upstream, body, remaining);
      if (!result.ok) continue;

      const headers = baseHeaders();
      headers.set("Content-Type", DNS_MESSAGE);
      if (result.headers.has("Content-Length")) headers.set("Content-Length", result.headers.get("Content-Length")!);
      if (result.headers.has("Cache-Control")) headers.set("Cache-Control", result.headers.get("Cache-Control")!);

      return new NextResponse(result.body, { status: 200, headers });
    } catch {
      // Fail closed and try the next fixed upstream, if one exists.
    }
  }

  return textResponse("DNS upstream unavailable", 502);
}

export async function handleDoH(
  request: NextRequest,
  providerId: string,
  formatSegment?: string,
): Promise<NextResponse> {
  if (formatSegment !== "dns-query") return textResponse("Not Found", 404);

  const upstream = getProviderUpstream(providerId);
  if (!upstream) return textResponse("Not Found", 404);

  return proxyRequest(request, { upstreams: [upstream], failover: false });
}

export async function handleHageziDoH(request: NextRequest): Promise<NextResponse> {
  return proxyRequest(request, {
    upstreams: getHageziUpstreams(),
    timeoutMs: 3_000,
    failover: true,
  });
}
