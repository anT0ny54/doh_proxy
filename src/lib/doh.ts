import { NextRequest, NextResponse } from "next/server";
import { getProvider, resolveProviderEndpoint } from "@/lib/providers";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const PROXY_VERSION = "v1.3.0";
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

function validateRequest(url: URL, method: string): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return response("Query string too long", 414);
  }

  if (method === "OPTIONS" || method === "HEAD" || method === "POST") {
    return null;
  }

  if (method !== "GET") return response("Method not allowed", 405);

  const dns = url.searchParams.get("dns");
  if (dns !== null) {
    if (!dns || dns.length > MAX_QUERY_STRING_LENGTH || !DNS_MESSAGE.test(dns)) {
      return response("Invalid DNS message parameter", 400);
    }
    return null;
  }

  const name = url.searchParams.get("name");
  if (!name) return response("Invalid domain: empty", 400);
  if (!isValidDomainName(name)) return response("Invalid domain name", 400);

  return null;
}

/**
 * Rejects obvious private/reserved literal addresses for caller-supplied URLs.
 * Hostname DNS rebinding cannot be completely prevented by an Edge Runtime
 * without a platform DNS/IP policy layer.
 */
function isSafeUpstreamUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    return false;
  }

  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;

    const [a, b] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  if (host.includes(":")) {
    const normalized = host.replace(/^::ffff:/, "");
    if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
      return isSafeUpstreamUrl(`${url.protocol}//${normalized}`);
    }

    return !(
      host === "::" ||
      host === "::1" ||
      /^fe[89ab]/.test(host) ||
      /^f[cd]/.test(host) ||
      host.startsWith("::ffff:")
    );
  }

  return host.length > 0;
}

function resolveUpstream(
  providerId: string,
  formatSegment: string | undefined,
  url: URL,
): string | NextResponse {
  const provider = getProvider(providerId);
  if (!provider) return response(`Provider '${providerId}' not found`, 404);

  if (providerId === "custom") {
    const customUrl = process.env.CUSTOM_DOH_URL;
    if (!customUrl) return response("Configuration Error: CUSTOM_DOH_URL missing", 500);
    if (!isSafeUpstreamUrl(customUrl)) {
      return response("Configuration Error: invalid CUSTOM_DOH_URL", 500);
    }
    return customUrl;
  }

  if (providerId === "manual") {
    const manualUrl = url.searchParams.get("upstream");
    if (!manualUrl) return response('Missing "upstream" parameter', 400);
    return isSafeUpstreamUrl(manualUrl)
      ? manualUrl
      : response("Invalid or disallowed upstream URL", 400);
  }

  const endpoint = resolveProviderEndpoint(provider, formatSegment);
  return endpoint
    ? endpoint
    : response(
        `Endpoint '${formatSegment}' not found for provider '${providerId}'`,
        404,
      );
}

function acceptHeader(request: NextRequest, url: URL): string {
  return (
    request.headers.get("accept") ||
    (request.method === "POST" || url.searchParams.has("dns")
      ? DEFAULT_WIRE_ACCEPT
      : DEFAULT_JSON_ACCEPT)
  );
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
    if (request.method === "OPTIONS" || request.method === "HEAD") {
      status = 204;
      return response(null, 204, "");
    }

    const url = new URL(request.url);
    const validationError = validateRequest(url, request.method);
    if (validationError) {
      status = validationError.status;
      if (status === 405) validationError.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
      return validationError;
    }

    let body: ArrayBuffer | undefined;
    if (request.method === "POST") {
      const bodyResult = await readBody(request);
      if (bodyResult instanceof NextResponse) {
        status = bodyResult.status;
        return bodyResult;
      }
      body = bodyResult;
    }

    const upstreamResult = resolveUpstream(providerId, formatSegment, url);
    if (upstreamResult instanceof NextResponse) {
      status = upstreamResult.status;
      return upstreamResult;
    }

    const upstreamUrl = new URL(upstreamResult);
    if (request.method === "GET") {
      for (const [key, value] of url.searchParams) {
        if (key !== "upstream") upstreamUrl.searchParams.append(key, value);
      }
    }

    const headers = new Headers({
      Accept: acceptHeader(request, url),
      "User-Agent": USER_AGENT,
    });

    if (request.method === "POST") {
      headers.set("Content-Type", request.headers.get("content-type") || DEFAULT_WIRE_ACCEPT);
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
    if (contentType) responseHeaders.set("Content-Type", contentType);

    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (caught: unknown) {
    const timeout = caught instanceof Error && caught.name === "AbortError";
    status = timeout ? 504 : 502;
    error = timeout ? "Upstream Timeout" : "Upstream Connection Failed";
    return response(JSON.stringify({ error }), status, "application/json; charset=utf-8");
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
