import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

// Public HaGeZi upstreams. Do not expose the selected URL to clients.
const UPSTREAMS = [
  "https://root.hagezi.org/dns-query",
  "https://wurzn.hagezi.org/dns-query",
  "https://juuri.hagezi.org/dns-query",
] as const;

const DEFAULT_ROTATION_SECONDS = 1_800;
const MIN_ROTATION_SECONDS = 60;
const MAX_ROTATION_SECONDS = 86_400;
const GLOBAL_TIMEOUT_MS = 3_000;
const UPSTREAM_TIMEOUT_MS = 1_000;
const MAX_DNS_MESSAGE_SIZE = 4_096;
// A 4096-byte DNS message becomes ~5462 base64url characters, plus "dns=".
const MAX_QUERY_STRING_LENGTH = 8_192;
const DNS_MESSAGE = "application/dns-message";
const PROXY_VERSION = "v2.2.1";
const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  Vary: "Accept, Origin",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-DoH-Proxy-Version": PROXY_VERSION,
};

function response(body: BodyInit | null, status: number, contentType?: string): NextResponse {
  const headers = new Headers(CORS_HEADERS);
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function rotationSeconds(): number {
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? DEFAULT_ROTATION_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_ROTATION_SECONDS;
  return Math.min(Math.max(Math.floor(configured), MIN_ROTATION_SECONDS), MAX_ROTATION_SECONDS);
}

function getUpstreamOrder(): readonly string[] {
  const slot = Math.floor(Date.now() / (rotationSeconds() * 1_000)) % UPSTREAMS.length;
  return Array.from({ length: UPSTREAMS.length }, (_, offset) =>
    UPSTREAMS[(slot + offset) % UPSTREAMS.length],
  );
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || value.length > MAX_QUERY_STRING_LENGTH || value.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    if (binary.length < 12 || binary.length > MAX_DNS_MESSAGE_SIZE) return null;

    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // Minimal DNS wire-format validation: header exists and at least one question.
    const qdCount = (bytes[4] << 8) | bytes[5];
    if (qdCount < 1) return null;
    return bytes;
  } catch {
    return null;
  }
}

function validateDnsGet(url: URL): boolean {
  const dns = url.searchParams.get("dns");
  return dns !== null && decodeBase64Url(dns) !== null;
}

async function readBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    const size = Number(length);
    if (!Number.isInteger(size) || size < 12 || size > MAX_DNS_MESSAGE_SIZE) {
      return response(size > MAX_DNS_MESSAGE_SIZE ? "Payload too large" : "Bad Request", size > MAX_DNS_MESSAGE_SIZE ? 413 : 400);
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength < 12) return response("Bad Request: DNS message too short", 400);
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return response("Payload too large", 413);
  return body;
}

async function queryUpstream(
  upstream: string,
  request: NextRequest,
  body: ArrayBuffer | undefined,
  timeoutMs: number,
): Promise<Response> {
  const upstreamUrl = new URL(upstream);
  if (request.method === "GET") {
    upstreamUrl.search = new URL(request.url).search;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers({
      Accept: DNS_MESSAGE,
      "User-Agent": USER_AGENT,
    });

    if (request.method === "POST") headers.set("Content-Type", DNS_MESSAGE);

    const result = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (request.method === "OPTIONS" || request.method === "HEAD") {
    return response(null, 204);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    const result = response("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, OPTIONS, HEAD");
    return result;
  }

  const url = new URL(request.url);
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return response("Query string too long", 414);
  }

  if (request.method === "GET" && !validateDnsGet(url)) {
    return response("Invalid DNS message", 400);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== DNS_MESSAGE) return response("Unsupported Content-Type", 415);

    const result = await readBody(request);
    if (result instanceof NextResponse) return result;
    body = result;
  }

  // One shared 3-second budget for all upstream attempts combined.
  // Attempts are strictly sequential: at most one HaGeZi request is active.
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  for (const upstream of getUpstreamOrder()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const result = await queryUpstream(
        upstream,
        request,
        body,
        Math.min(UPSTREAM_TIMEOUT_MS, remaining),
      );

      const headers = new Headers(CORS_HEADERS);
      headers.set("Content-Type", result.headers.get("content-type") || DNS_MESSAGE);
      return new NextResponse(result.body, { status: result.status, headers });
    } catch {
      // Deliberately hide which upstream failed and continue to the next one.
    }
  }

  // Never reveal upstream URLs, internal fetch errors, or provider topology.
  return response("DNS upstream unavailable", 502);
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const HEAD = handle;
