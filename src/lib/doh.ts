import { NextRequest, NextResponse } from "next/server";
import { getProvider, resolveProviderEndpoint } from "@/lib/providers";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const MAX_DNS_MESSAGE_SIZE = 4_096;
const PROXY_VERSION = "v2.2.0";
const DEFAULT_JSON_ACCEPT = "application/dns-json";
const DEFAULT_WIRE_ACCEPT = "application/dns-message";
const USER_AGENT = `DoH-Proxy/${PROXY_VERSION.slice(1)}`;

const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/;
const DNS_MESSAGE = /^[A-Za-z0-9_-]+={0,2}$/;

interface LogEntry {
  timestamp: string;
  provider: string;
  durationMs: number;
  status: number;
  method: string;
  error?: string;
}

function baseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    Vary: "Accept, Accept-Encoding, Origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Content-Length",
    "X-DoH-Proxy-Version": PROXY_VERSION,
  });
}

function response(
  body: BodyInit | null,
  status: number,
  contentType = "text/plain; charset=utf-8",
): NextResponse {
  const headers = baseHeaders();
  if (contentType) headers.set("Content-Type", contentType);
  return new NextResponse(body, { status, headers });
}

function logRequest(entry: LogEntry): void {
  if (process.env.DEBUG_LOG === "true" || entry.status >= 400) {
    console.log(JSON.stringify(entry));
  }
}

function isValidDomainName(value: string): boolean {
  if (value === ".") return true;
  if (value.length === 0 || value.length > 253) return false;

  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!normalized) return false;

  return normalized.split(".").every((label) => {
    if (label.length === 0 || label.length > 63 || !DOMAIN_LABEL.test(label)) {
      return false;
    }
    return !label.startsWith("-") && !label.endsWith("-");
  });
}

function isValidDnsMessage(value: string): boolean {
  if (
    !value ||
    value.length > MAX_QUERY_STRING_LENGTH ||
    value.length % 4 === 1 ||
    !DNS_MESSAGE.test(value)
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

function validateRequest(
  url: URL,
  method: string,
  isWireEndpoint: boolean,
): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return response("Query string too long", 414);
  }

  if (method === "OPTIONS" || method === "HEAD") return null;

  if (isWireEndpoint) {
    if (method !== "GET" && method !== "POST") {
      const result = response("Method not allowed", 405);
      result.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
      return result;
    }

    if (method === "GET") {
      const dns = url.searchParams.get("dns");
      if (!dns || !isValidDnsMessage(dns)) {
        return response("Invalid DNS message parameter", 400);
      }
    }

    return null;
  }

  // The legacy/provider root is a JSON API. Do not pass RFC 8484 `dns=`
  // payloads to /resolve; use /api/doh/<provider>/dns-query instead.
  if (method !== "GET") {
    const result = response("JSON DNS endpoint only supports GET", 405);
    result.headers.set("Allow", "GET, HEAD, OPTIONS");
    return result;
  }

  if (url.searchParams.has("dns")) {
    return response(
      "RFC 8484 wire queries must use /dns-query",
      400,
      "text/plain; charset=utf-8",
    );
  }

  const name = url.searchParams.get("name");
  if (!name || !isValidDomainName(name)) {
    return response("Invalid domain name", 400);
  }

  return null;
}

function resolveUpstream(
  providerId: string,
  formatSegment: string | undefined,
): string | NextResponse {
  const provider = getProvider(providerId);
  if (!provider) return response(`Provider '${providerId}' not found`, 404);

  const endpoint = resolveProviderEndpoint(provider, formatSegment);
  return endpoint
    ? endpoint
    : response(
        `Endpoint '${formatSegment}' not found for provider '${providerId}'`,
        404,
      );
}

function acceptHeader(
  request: NextRequest,
  isWireEndpoint: boolean,
): string {
  if (isWireEndpoint) {
    return request.headers.get("accept") || DEFAULT_WIRE_ACCEPT;
  }
  // JSON endpoints should always ask the upstream for the JSON representation.
  // This is especially important for Google /resolve and AdGuard /resolve.
  return DEFAULT_JSON_ACCEPT;
}

async function readBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BODY_SIZE) {
      return response("Payload too large", 413);
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return response("Empty DNS request body", 400);
  if (body.byteLength < 12) return response("DNS message too short", 400);
  if (body.byteLength > MAX_BODY_SIZE) return response("Payload too large", 413);
  return body;
}

export async function handleDoH(
  request: NextRequest,
  providerId: string,
  formatSegment?: string,
): Promise<NextResponse> {
  const startedAt = Date.now();
  let status = 500;
  let error: string | undefined;

  try {
    if (request.method === "OPTIONS") {
      status = 204;
      return response(null, 204, "");
    }

    const isWireEndpoint = formatSegment === "dns-query";
    const url = new URL(request.url);
    const validationError = validateRequest(url, request.method, isWireEndpoint);
    if (validationError) {
      status = validationError.status;
      return validationError;
    }

    // HEAD is handled locally. Some upstream JSON APIs do not implement HEAD.
    if (request.method === "HEAD") {
      status = 204;
      return response(null, 204, "");
    }

    let body: ArrayBuffer | undefined;
    if (request.method === "POST") {
      const contentType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();

      if (
        contentType &&
        contentType !== "application/dns-message" &&
        contentType !== "application/octet-stream"
      ) {
        status = 415;
        return response("Unsupported Content-Type", 415);
      }

      const bodyResult = await readBody(request);
      if (bodyResult instanceof NextResponse) {
        status = bodyResult.status;
        return bodyResult;
      }
      body = bodyResult;
    }

    const upstreamResult = resolveUpstream(providerId, formatSegment);
    if (upstreamResult instanceof NextResponse) {
      status = upstreamResult.status;
      return upstreamResult;
    }

    const upstreamUrl = new URL(upstreamResult);

    // Forward only the query parameters that belong to the selected API.
    // Never forward arbitrary proxy-control parameters.
    if (request.method === "GET") {
      if (isWireEndpoint) {
        const dns = url.searchParams.get("dns");
        if (dns) upstreamUrl.searchParams.set("dns", dns);
      } else {
        for (const key of ["name", "type", "cd", "do", "edns_client_subnet", "ct"]) {
          const value = url.searchParams.get(key);
          if (value !== null) upstreamUrl.searchParams.set(key, value);
        }
      }
    }

    const headers = new Headers({
      Accept: acceptHeader(request, isWireEndpoint),
      "User-Agent": USER_AGENT,
    });

    if (request.method === "POST") {
      headers.set("Content-Type", "application/dns-message");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeoutId);
    }

    status = upstreamResponse.status;

    const responseHeaders = baseHeaders();
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("Content-Type", contentType);
    } else {
      responseHeaders.set(
        "Content-Type",
        isWireEndpoint ? DEFAULT_WIRE_ACCEPT : DEFAULT_JSON_ACCEPT,
      );
    }

    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (caught: unknown) {
    const timeout = caught instanceof Error && caught.name === "AbortError";
    status = timeout ? 504 : 502;
    error = timeout ? "Upstream Timeout" : "Upstream Connection Failed";
    return response(
      JSON.stringify({ error }),
      status,
      "application/json; charset=utf-8",
    );
  } finally {
    logRequest({
      timestamp: new Date().toISOString(),
      provider: providerId,
      durationMs: Date.now() - startedAt,
      status,
      method: request.method,
      error,
    });
  }
}
