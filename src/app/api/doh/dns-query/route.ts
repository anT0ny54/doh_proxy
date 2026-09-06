import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

const UPSTREAMS = [
  "https://root.hagezi.org/dns-query",
  "https://juuri.hagezi.org/dns-query",
  "https://wurzn.hagezi.org/dns-query",
] as const;

const UPSTREAM_TIMEOUT_MS = 2_500;
const GLOBAL_TIMEOUT_MS = 3_000;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Cache-Control": "no-store, max-age=0",
  "X-DoH-Proxy-Version": "v1.3.0",
};

function makeResponse(body: BodyInit | null, status: number, contentType?: string): NextResponse {
  const headers = new Headers(CORS);
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
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
  if (body.byteLength > MAX_BODY_SIZE) return makeResponse("Payload too large", 413);
  return body;
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
      Accept: request.headers.get("accept") || "application/dns-message",
      "User-Agent": "DoH-Proxy/v1.3.0",
    });
    if (request.method === "POST") {
      headers.set("Content-Type", request.headers.get("content-type") || "application/dns-message");
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
  if (request.method === "OPTIONS" || request.method === "HEAD") return makeResponse(null, 204);
  if (request.method !== "GET" && request.method !== "POST") {
    const result = makeResponse("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, OPTIONS, HEAD");
    return result;
  }

  const url = new URL(request.url);
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return makeResponse("Query string too long", 414);
  if (request.method === "GET" && !url.search) return makeResponse("Bad Request: Missing DNS query", 400);

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const result = await readBody(request);
    if (result instanceof NextResponse) return result;
    body = result;
  }

  const raceController = new AbortController();
  const globalTimeoutId = setTimeout(() => raceController.abort("GlobalTimeout"), GLOBAL_TIMEOUT_MS);

  try {
    const winner = await Promise.any(
      UPSTREAMS.map((upstream) => queryUpstream(upstream, request, body, raceController.signal)),
    );
    raceController.abort("RaceResolved");

    const headers = new Headers(CORS);
    headers.set("Content-Type", winner.headers.get("content-type") || "application/dns-message");
    return new NextResponse(winner.body, { status: 200, headers });
  } catch {
    raceController.abort("AllFailed");
    return makeResponse("All DNS upstreams failed or timed out", 502);
  } finally {
    clearTimeout(globalTimeoutId);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const HEAD = handle;
