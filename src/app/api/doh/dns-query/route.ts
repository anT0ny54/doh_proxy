import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

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
const PROXY_VERSION = "v2.1.0";
const DEFAULT_WIRE_ACCEPT = "application/dns-message";
const USER_AGENT = `DoH-Proxy/${PROXY_VERSION.slice(1)}`;
const DEFAULT_ROTATION_SECONDS = 1_800;
const MIN_ROTATION_SECONDS = 60;
const MAX_ROTATION_SECONDS = 86_400;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  Vary: "Accept, Origin",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-DoH-Proxy-Version": PROXY_VERSION,
};

function makeResponse(
  body: BodyInit | null,
  status: number,
  contentType?: string,
): NextResponse {
  const headers = new Headers(CORS);
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function rotationSeconds(): number {
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? DEFAULT_ROTATION_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_ROTATION_SECONDS;
  return Math.min(Math.max(Math.floor(configured), MIN_ROTATION_SECONDS), MAX_ROTATION_SECONDS);
}

/**
 * Select one primary upstream for the current time slot. This is deliberately
 * stateless so it behaves consistently across Vercel/Netlify cold starts and
 * multiple serverless instances.
 */
function getUpstreamOrder(): readonly string[] {
  const slot = Math.floor(Date.now() / (rotationSeconds() * 1_000)) % UPSTREAMS.length;
  return Array.from({ length: UPSTREAMS.length }, (_, offset) =>
    UPSTREAMS[(slot + offset) % UPSTREAMS.length],
  );
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
  if (!body.byteLength) return makeResponse("Bad Request: Empty request body", 400);
  if (body.byteLength < 12) return makeResponse("Bad Request: DNS message too short", 400);
  if (body.byteLength > MAX_BODY_SIZE) return makeResponse("Payload too large", 413);
  return body;
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

function validateDnsGet(url: URL): string | null {
  const dns = url.searchParams.get("dns");
  if (!dns || !isValidBase64Url(dns)) return "Invalid DNS message";
  return null;
}

async function queryUpstream(
  upstream: string,
  request: NextRequest,
  body: ArrayBuffer | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const upstreamUrl = new URL(upstream);
  if (request.method === "GET") upstreamUrl.search = new URL(request.url).search;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal.reason);

  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    const headers = new Headers({
      Accept: request.headers.get("accept") || DEFAULT_WIRE_ACCEPT,
      "User-Agent": USER_AGENT,
    });

    if (request.method === "POST") {
      headers.set(
        "Content-Type",
        request.headers.get("content-type") || DEFAULT_WIRE_ACCEPT,
      );
    }

    const result = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!result.ok) throw new Error(`Upstream HTTP ${result.status}`);
    return result;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", onAbort);
  }
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (request.method === "OPTIONS" || request.method === "HEAD") {
    return makeResponse(null, 204);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    const result = makeResponse("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, OPTIONS, HEAD");
    return result;
  }

  const url = new URL(request.url);
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return makeResponse("Query string too long", 414);
  }

  if (request.method === "GET") {
    const dnsError = validateDnsGet(url);
    if (dnsError) return makeResponse(dnsError, 400);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType && contentType !== "application/dns-message" && contentType !== "application/octet-stream") {
      return makeResponse("Unsupported Content-Type", 415);
    }

    const result = await readBody(request);
    if (result instanceof NextResponse) return result;
    body = result;
  }

  const controller = new AbortController();
  const globalTimeoutId = setTimeout(() => controller.abort("GlobalTimeout"), GLOBAL_TIMEOUT_MS);
  let lastError: unknown;

  try {
    // Primary = current rotation slot; the other two are sequential fallbacks.
    // This replaces the old 3-way race, which could send 3 upstream requests
    // for a single client query.
    for (const upstream of getUpstreamOrder()) {
      if (controller.signal.aborted) break;

      try {
        const result = await queryUpstream(upstream, request, body, controller.signal);
        const headers = new Headers(CORS);
        headers.set(
          "Content-Type",
          result.headers.get("content-type") || DEFAULT_WIRE_ACCEPT,
        );
        return new NextResponse(result.body, { status: 200, headers });
      } catch (error) {
        lastError = error;
      }
    }

    const timeout = controller.signal.aborted && controller.signal.reason === "GlobalTimeout";
    return makeResponse(
      timeout
        ? "DNS upstream timeout"
        : `All DNS upstreams failed${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
      502,
    );
  } finally {
    clearTimeout(globalTimeoutId);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const HEAD = handle;
