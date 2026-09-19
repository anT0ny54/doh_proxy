import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";
import { DNS_MESSAGE, isValidDnsQuery, isValidDnsResponse, MAX_DNS_MESSAGE_SIZE } from "@/lib/dns";
import { HAGEZI_UPSTREAMS, type DoHUpstream as ConfiguredUpstream } from "@/lib/upstreams";

export const PROXY_VERSION = "2.7.1";

const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const MAX_QUERY_STRING_LENGTH = 8_192;
const DEFAULT_TIMEOUT_MS = 2_500;
const MIN_TIMEOUT_MS = 250;
const HAGEZI_TIMEOUT_MS = 3_500;
const MAX_HAGEZI_ROTATION_SECONDS = 86_400;
const MIN_HAGEZI_ROTATION_SECONDS = 60;
const DEFAULT_HAGEZI_ROTATION_SECONDS = 1_800;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type DoHUpstream = Pick<ConfiguredUpstream, "endpoint">;

interface DoHOptions {
  readonly upstreams: readonly DoHUpstream[];
  readonly timeoutMs?: number;
  readonly failover?: boolean;
}

export function getHageziUpstreams(): readonly DoHUpstream[] {
  const configured = Number(process.env.HAGEZI_ROTATION_SECONDS ?? DEFAULT_HAGEZI_ROTATION_SECONDS);
  const seconds = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), MIN_HAGEZI_ROTATION_SECONDS), MAX_HAGEZI_ROTATION_SECONDS)
    : DEFAULT_HAGEZI_ROTATION_SECONDS;
  const slot = Math.floor(Date.now() / (seconds * 1_000)) % HAGEZI_UPSTREAMS.length;

  return Array.from(
    { length: HAGEZI_UPSTREAMS.length },
    (_, offset) => HAGEZI_UPSTREAMS[(slot + offset) % HAGEZI_UPSTREAMS.length],
  );
}

function baseHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Cache-Control",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store, max-age=0",
    Expires: "0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

function textResponse(message: string, status: number): NextResponse {
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
    if (binary.length > MAX_DNS_MESSAGE_SIZE) return null;

    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return isValidDnsQuery(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function validateGet(url: URL): { readonly dnsParam: string; readonly queryBody: Uint8Array } | NextResponse {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return textResponse("Query string too long", 414);

  const dnsValues = url.searchParams.getAll("dns");
  if (dnsValues.length !== 1) return textResponse("Invalid DNS message", 400);

  const decoded = decodeBase64Url(dnsValues[0]);
  if (decoded === null) return textResponse("Invalid DNS message", 400);

  return { dnsParam: dnsValues[0], queryBody: decoded };
}

async function readPostBody(request: NextRequest, deadline: number): Promise<Uint8Array | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) return textResponse("Unsupported Content-Type", 415);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size < 12) return textResponse("Invalid DNS message", 400);
    if (size > MAX_DNS_MESSAGE_SIZE) return textResponse("Payload too large", 413);
  }

  if (!request.body) return textResponse("Invalid DNS message", 400);

  const reader = request.body.getReader();
  const buffer = new Uint8Array(MAX_DNS_MESSAGE_SIZE);
  let total = 0;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return textResponse("Request body timeout", 408);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutToken = {};
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timeoutToken), remaining);
          }),
        ]);

        if (result.done) break;

        const nextTotal = total + result.value.byteLength;
        if (nextTotal > MAX_DNS_MESSAGE_SIZE) {
          await reader.cancel().catch(() => undefined);
          return textResponse("Payload too large", 413);
        }

        buffer.set(result.value, total);
        total = nextTotal;
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (error === timeoutToken) return textResponse("Request body timeout", 408);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const body = buffer.subarray(0, total);
  if (!isValidDnsQuery(body)) return textResponse("Invalid DNS message", 400);
  return body;
}

async function readResponseBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size > MAX_DNS_MESSAGE_SIZE) return null;
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_DNS_MESSAGE_SIZE);
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const nextTotal = total + value.byteLength;
      if (nextTotal > MAX_DNS_MESSAGE_SIZE) {
        await reader.cancel().catch(() => undefined);
        return null;
      }

      buffer.set(value, total);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }

  return buffer.subarray(0, total);
}

function cancelResponseBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/**
 * TypeScript 6 models Uint8Array as possibly backed by SharedArrayBuffer,
 * while fetch()/NextResponse BodyInit requires an ArrayBuffer in this context.
 * Copying into a fresh ArrayBuffer preserves the bytes and satisfies the
 * server-side fetch/Response body types.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

interface UpstreamFetch {
  readonly response: Response;
  readonly cleanup: () => void;
}

async function fetchUpstream(
  request: NextRequest,
  dnsParam: string | undefined,
  upstream: DoHUpstream,
  body: Uint8Array | undefined,
  timeoutMs: number,
): Promise<UpstreamFetch> {
  const url = new URL(upstream.endpoint);
  if (request.method === "GET" && dnsParam !== undefined) url.searchParams.set("dns", dnsParam);

  const headers = new Headers({
    Accept: DNS_MESSAGE,
    "User-Agent": USER_AGENT,
  });
  if (request.method === "POST") headers.set("Content-Type", DNS_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: body === undefined ? undefined : toArrayBuffer(body),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });

    // Keep the deadline active until the response body has been consumed.
    return {
      response,
      cleanup: () => clearTimeout(timer),
    };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function proxyRequest(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
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
  let queryBody: Uint8Array | undefined;
  let dnsParam: string | undefined;
  const timeout = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeout;

  if (request.method === "GET") {
    const validation = validateGet(url);
    if (validation instanceof NextResponse) return validation;
    dnsParam = validation.dnsParam;
    queryBody = validation.queryBody;
  } else {
    const bodyResult = await readPostBody(request, deadline);
    if (bodyResult instanceof NextResponse) return bodyResult;
    queryBody = bodyResult;
  }

  const failover = options.failover !== false;
  const upstreams = failover ? options.upstreams : options.upstreams.slice(0, 1);
  const perAttemptTimeout = failover
    ? Math.max(750, Math.floor(timeout / Math.max(upstreams.length, 1)))
    : timeout;

  for (const upstream of upstreams) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const upstreamFetch = await fetchUpstream(
        request,
        dnsParam,
        upstream,
        request.method === "POST" ? queryBody : undefined,
        Math.min(remaining, perAttemptTimeout),
      );
      const result = upstreamFetch.response;

      try {
        if (result.status !== 200) {
          const retryable = RETRYABLE_UPSTREAM_STATUSES.has(result.status);
          cancelResponseBody(result);
          if (retryable) continue;
          return textResponse("DNS upstream rejected request", result.status);
        }

        const contentType = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (contentType !== DNS_MESSAGE) {
          cancelResponseBody(result);
          continue;
        }

        const responseBody = await readResponseBody(result);
        if (responseBody === null || queryBody === undefined || !isValidDnsResponse(responseBody, queryBody)) {
          cancelResponseBody(result);
          continue;
        }

        const headers = baseHeaders();
        headers.set("Content-Type", DNS_MESSAGE);
        headers.set("Content-Length", String(responseBody.byteLength));
        return new NextResponse(toArrayBuffer(responseBody), { status: 200, headers });
      } finally {
        upstreamFetch.cleanup();
      }
    } catch {
      // Network errors and timeouts are retryable; try the next fixed upstream.
    }
  }

  return textResponse("DNS upstream unavailable", 502);
}

export async function handleDoH(request: NextRequest, providerId: string): Promise<NextResponse> {
  const provider = getProvider(providerId);
  if (!provider) return textResponse("Not Found", 404);

  return proxyRequest(request, {
    upstreams: [{ endpoint: provider.endpoint }],
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
