import { NextRequest, NextResponse } from "next/server";
import { getProvider, resolveProviderEndpoint } from "@/lib/providers";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const PROXY_VERSION = "v2.2.0";
const DEFAULT_JSON_ACCEPT = "application/dns-json";
const DEFAULT_WIRE_ACCEPT = "application/dns-message";
const USER_AGENT = `DoH-Proxy/${PROXY_VERSION.slice(1)}`;
const DNS_MESSAGE = "application/dns-message";
const DNS_JSON = "application/dns-json";

const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/;
const DNS_MESSAGE_B64 = /^[A-Za-z0-9_-]+={0,2}$/;

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

function isValidDomainName(value: string): boolean {
  if (value === ".") return true;
  if (value.length === 0 || value.length > 253) return false;

  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!normalized) return false;

  return normalized.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    DOMAIN_LABEL.test(label) &&
    !label.startsWith("-") &&
    !label.endsWith("-"),
  );
}

function isValidDnsMessage(value: string): boolean {
  if (!value || value.length > MAX_QUERY_STRING_LENGTH || !DNS_MESSAGE_B64.test(value)) {
    return false;
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return decoded.length >= 12 && decoded.length <= MAX_BODY_SIZE;
  } catch {
    return false;
  }
}

function validateJsonGet(url: URL): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return response("Query string too long", 414);

  const name = url.searchParams.get("name");
  if (!name || !isValidDomainName(name)) return response("Invalid domain name", 400);
  return null;
}

function validateWireGet(url: URL): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return response("Query string too long", 414);
  const dns = url.searchParams.get("dns");
  return dns && isValidDnsMessage(dns) ? null : response("Invalid DNS message", 400);
}

async function readWireBody(request: NextRequest): Promise<ArrayBuffer | NextResponse> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== DNS_MESSAGE) return response("Unsupported Content-Type", 415);

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
  if (request.method === "OPTIONS" || request.method === "HEAD") {
    return response(null, 204, "");
  }

  const provider = getProvider(providerId);
  if (!provider) return response(`Provider '${providerId}' not found`, 404);

  const isWire = formatSegment === "dns-query";
  const endpoint = resolveProviderEndpoint(provider, formatSegment);
  if (!endpoint) return response("Endpoint not found", 404);

  const url = new URL(request.url);
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return response("Query string too long", 414);

  // JSON /resolve endpoints are intentionally GET-only. RFC 8484 wire
  // requests use the explicit /dns-query endpoint and application/dns-message.
  if (!isWire) {
    if (request.method !== "GET") {
      const result = response("Method Not Allowed", 405);
      result.headers.set("Allow", "GET, HEAD, OPTIONS");
      return result;
    }

    const validation = validateJsonGet(url);
    if (validation) return validation;
  } else {
    if (request.method !== "GET" && request.method !== "POST") {
      const result = response("Method Not Allowed", 405);
      result.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
      return result;
    }

    if (request.method === "GET") {
      const validation = validateWireGet(url);
      if (validation) return validation;
    }
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const result = await readWireBody(request);
    if (result instanceof NextResponse) return result;
    body = result;
  }

  const upstreamUrl = new URL(endpoint);
  if (request.method === "GET") {
    for (const [key, value] of url.searchParams) upstreamUrl.searchParams.append(key, value);
  }

  const headers = new Headers({
    Accept: request.headers.get("accept") || (isWire ? DEFAULT_WIRE_ACCEPT : DNS_JSON),
    "User-Agent": USER_AGENT,
  });
  if (request.method === "POST") headers.set("Content-Type", DNS_MESSAGE);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    const responseHeaders = baseHeaders();
    responseHeaders.set("Content-Type", upstreamResponse.headers.get("content-type") || (isWire ? DNS_MESSAGE : DNS_JSON));

    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    return response(
      JSON.stringify({ error: timeout ? "Upstream Timeout" : "Upstream Connection Failed" }),
      timeout ? 504 : 502,
      "application/json; charset=utf-8",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
