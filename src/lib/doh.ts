import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";

export const DNS_MESSAGE = "application/dns-message";
export const PROXY_VERSION = "2.6.0";

const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const MIN_DNS_MESSAGE_SIZE = 12;
const MAX_DNS_MESSAGE_SIZE = 65_535;
const MAX_GET_QUERY_SIZE = 90_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const HAGEZI_TIMEOUT_MS = 3_000;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export interface DoHUpstream {
  readonly endpoint: string;
  readonly name: string;
}

export interface DoHOptions {
  readonly upstreams: readonly DoHUpstream[];
  readonly timeoutMs?: number;
  readonly failover?: boolean;
}

const HAGEZI_UPSTREAMS: readonly DoHUpstream[] = [
  { name: "HaGeZi root", endpoint: "https://root.hagezi.org/dns-query" },
  { name: "HaGeZi wurzn", endpoint: "https://wurzn.hagezi.org/dns-query" },
  { name: "HaGeZi juuri", endpoint: "https://juuri.hagezi.org/dns-query" },
];

function baseHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Expires: "0",
    Pragma: "no-cache",
    Vary: "Accept, Origin",
    "X-Content-Type-Options": "nosniff",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

function response(body: BodyInit | null, status: number, contentType?: string): NextResponse {
  const headers = baseHeaders();
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function emptyResponse(status = 204): NextResponse {
  return response(null, status);
}

function errorResponse(message: string, status: number, allow?: string): NextResponse {
  const result = response(message, status, "text/plain; charset=utf-8");
  if (allow) result.headers.set("Allow", allow);
  return result;
}

function clampTimeout(timeoutMs: number | undefined): number {
  const configured = Number.isFinite(timeoutMs) ? Math.floor(timeoutMs!) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(configured, 250), 5_000);
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || value.length > MAX_GET_QUERY_SIZE || value.length % 4 === 1 || !BASE64URL.test(value)) return null;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    if (binary.length < MIN_DNS_MESSAGE_SIZE || binary.length > MAX_DNS_MESSAGE_SIZE) return null;

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validateGet(url: URL): NextResponse | null {
  if (url.search.length > MAX_GET_QUERY_SIZE) return errorResponse("Query string too long", 414);

  const dns = url.searchParams.get("dns");
  if (!dns || decodeBase64Url(dns) === null) return errorResponse("Invalid DNS message", 400);

  return null;
}

async function readPostBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) return errorResponse("Unsupported Content-Type", 415);

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < MIN_DNS_MESSAGE_SIZE) {
      return errorResponse("Invalid DNS message", 400);
    }
    if (contentLength > MAX_DNS_MESSAGE_SIZE) return errorResponse("Payload too large", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength < MIN_DNS_MESSAGE_SIZE) return errorResponse("Invalid DNS message", 400);
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return errorResponse("Payload too large", 413);

  return body;
}

async function fetchUpstream(
  request: NextRequest,
  upstream: DoHUpstream,
  dnsQuery: string | undefined,
  body: ArrayBuffer | undefined,
  timeoutMs: number,
): Promise<Response> {
  const url = new URL(upstream.endpoint);
  if (dnsQuery !== undefined) url.searchParams.set("dns", dnsQuery);

  const headers = new Headers({
    Accept: DNS_MESSAGE,
    "User-Agent": USER_AGENT,
  });
  if (body !== undefined) headers.set("Content-Type", DNS_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: request.method,
      headers,
      // Keep the original buffer: no extra copy on the hot path.
      // Next.js 16 DOM typings reject ArrayBuffer here even though the Edge
      // fetch runtime accepts it, so cast only at this boundary.
      body: body as unknown as BodyInit,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function upstreamResponse(result: Response): NextResponse | null {
  if (!result.ok) return null;

  const contentType = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) return null;

  const headers = baseHeaders();
  headers.set("Content-Type", DNS_MESSAGE);

  // Do not trust an upstream Content-Length beyond our own safety bound.
  const contentLength = result.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size < MIN_DNS_MESSAGE_SIZE || size > MAX_DNS_MESSAGE_SIZE) return null;
    headers.set("Content-Length", String(size));
  }

  return new NextResponse(result.body, { status: 200, headers });
}

async function proxyRequest(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  if (request.method === "OPTIONS") return emptyResponse();
  if (request.method === "HEAD") return emptyResponse();

  if (request.method !== "GET" && request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "GET, POST, HEAD, OPTIONS");
  }

  const requestUrl = new URL(request.url);
  let dnsQuery: string | undefined;
  let body: ArrayBuffer | undefined;

  if (request.method === "GET") {
    const validationError = validateGet(requestUrl);
    if (validationError) return validationError;
    dnsQuery = requestUrl.searchParams.get("dns")!;
  } else {
    const bodyResult = await readPostBody(request);
    if (bodyResult instanceof NextResponse) return bodyResult;
    body = bodyResult;
  }

  const timeout = clampTimeout(options.timeoutMs);
  const deadline = Date.now() + timeout;
  const upstreams = options.failover === false ? options.upstreams.slice(0, 1) : options.upstreams;

  for (const upstream of upstreams) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const result = await fetchUpstream(request, upstream, dnsQuery, body, remaining);
      const proxied = upstreamResponse(result);
      if (proxied) return proxied;
    } catch {
      // Timeout/network/redirect errors are intentionally failover-able.
    }
  }

  return errorResponse("DNS upstream unavailable", 502);
}

export function getHageziUpstreams(): readonly DoHUpstream[] {
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? 1_800);
  const seconds = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), 60), 86_400)
    : 1_800;
  const slot = Math.floor(Date.now() / (seconds * 1_000)) % HAGEZI_UPSTREAMS.length;

  return HAGEZI_UPSTREAMS.map((_, offset) => HAGEZI_UPSTREAMS[(slot + offset) % HAGEZI_UPSTREAMS.length]);
}

export async function handleDoH(
  request: NextRequest,
  providerId: string,
  formatSegment?: string,
): Promise<NextResponse> {
  if (formatSegment !== "dns-query" || !getProvider(providerId)) return errorResponse("Not Found", 404);

  const provider = getProvider(providerId)!;
  return proxyRequest(request, {
    upstreams: [{ name: provider.name, endpoint: provider.endpoint }],
    failover: false,
  });
}

export async function handleHageziDoH(request: NextRequest): Promise<NextResponse> {
  return proxyRequest(request, {
    upstreams: getHageziUpstreams(),
    timeoutMs: HAGEZI_TIMEOUT_MS,
    failover: true,
  });
}
