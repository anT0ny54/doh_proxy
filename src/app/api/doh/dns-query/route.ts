import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

// Keep the original HaGeZi public DoH upstream set and behavior.
const UPSTREAMS = [
  "https://root.hagezi.org/dns-query",
  "https://wurzn.hagezi.org/dns-query",
  "https://juuri.hagezi.org/dns-query",
] as const;

const UPSTREAM_TIMEOUT_MS = 1_000;
const GLOBAL_TIMEOUT_MS = 3_000;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const MAX_DNS_MESSAGE_SIZE = 4_096;
const DEFAULT_ROTATION_SECONDS = 1_800;
const MIN_ROTATION_SECONDS = 60;
const MAX_ROTATION_SECONDS = 86_400;
const PROXY_VERSION = "v2.2.0";
const DNS_MESSAGE = "application/dns-message";
const USER_AGENT = `DoH-Proxy/${PROXY_VERSION.slice(1)}`;

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

function makeResponse(body: BodyInit | null, status: number, contentType?: string): NextResponse {
  const headers = new Headers(CORS_HEADERS);
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function rotationSeconds(): number {
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? DEFAULT_ROTATION_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_ROTATION_SECONDS;
  return Math.min(Math.max(Math.floor(configured), MIN_ROTATION_SECONDS), MAX_ROTATION_SECONDS);
}

/**
 * Rotate the primary HaGeZi upstream every 30 minutes by default.
 * The remaining upstreams are tried only as sequential fallbacks.
 */
function getUpstreamOrder(): readonly string[] {
  const slot = Math.floor(Date.now() / (rotationSeconds() * 1_000)) % UPSTREAMS.length;
  return Array.from(
    { length: UPSTREAMS.length },
    (_, offset) => UPSTREAMS[(slot + offset) % UPSTREAMS.length],
  );
}

function isValidBase64Url(value: string): boolean {
  if (
    !value ||
    value.length > MAX_QUERY_STRING_LENGTH ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  ) {
    return false;
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return decoded.length >= 12 && decoded.length <= MAX_DNS_MESSAGE_SIZE;
  } catch {
    return false;
  }
}

function validateDnsGet(url: URL): boolean {
  const dns = url.searchParams.get("dns");
  return dns !== null && isValidBase64Url(dns);
}

async function readBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    const size = Number(length);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BODY_SIZE) {
      return makeResponse("Payload too large", 413);
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return makeResponse("Bad Request: Empty request body", 400);
  if (body.byteLength < 12) return makeResponse("Bad Request: DNS message too short", 400);
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return makeResponse("Payload too large", 413);
  return body;
}

async function queryUpstream(
  upstream: string,
  request: NextRequest,
  body: ArrayBuffer | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const upstreamUrl = new URL(upstream);
  if (request.method === "GET") {
    upstreamUrl.search = new URL(request.url).search;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);

  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", abort, { once: true });

  try {
    const headers = new Headers({
      Accept: request.headers.get("accept") || DNS_MESSAGE,
      "User-Agent": USER_AGENT,
    });

    if (request.method === "POST") headers.set("Content-Type", DNS_MESSAGE);

    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) throw new Error("Upstream request failed");
    return response;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", abort);
  }
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (request.method === "OPTIONS" || request.method === "HEAD") {
    return makeResponse(null, 204);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    const response = makeResponse("Method Not Allowed", 405);
    response.headers.set("Allow", "GET, POST, OPTIONS, HEAD");
    return response;
  }

  const url = new URL(request.url);
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return makeResponse("Query string too long", 414);
  }

  if (request.method === "GET" && !validateDnsGet(url)) {
    return makeResponse("Invalid DNS message", 400);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== DNS_MESSAGE) {
      return makeResponse("Unsupported Content-Type", 415);
    }

    const result = await readBody(request);
    if (result instanceof NextResponse) return result;
    body = result;
  }

  // One shared three-second budget for the entire request. Fallbacks are
  // strictly sequential: never race multiple HaGeZi upstreams.
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;
  let lastFailure = false;

  for (const upstream of getUpstreamOrder()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const attemptController = new AbortController();
    const timeoutId = setTimeout(
      () => attemptController.abort(),
      Math.min(UPSTREAM_TIMEOUT_MS, remaining),
    );

    try {
      const response = await queryUpstream(upstream, request, body, attemptController.signal);
      const headers = new Headers(CORS_HEADERS);
      headers.set("Content-Type", response.headers.get("content-type") || DNS_MESSAGE);
      return new NextResponse(response.body, { status: 200, headers });
    } catch {
      lastFailure = true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Do not expose the selected/failed HaGeZi upstream URL or fetch error.
  return makeResponse(
    Date.now() >= deadline && !lastFailure ? "DNS upstream timeout" : "DNS upstream unavailable",
    502,
  );
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const HEAD = handle;
