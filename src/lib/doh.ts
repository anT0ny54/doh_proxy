import { NextRequest, NextResponse } from 'next/server';
import { getProvider, resolveProviderEndpoint } from '@/lib/providers';

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_QUERY_STRING_LENGTH = 1_024;
const MAX_BODY_SIZE = 4_096;
const PROXY_VERSION = 'v1.2.0';

const ALLOWED_DOMAIN_REGEX = /^[a-zA-Z0-9._-]+$/;
const DNS_MESSAGE_REGEX = /^[A-Za-z0-9_-]+={0,2}$/;

interface LogEntry {
  timestamp: string;
  provider: string;
  durationMs: number;
  status: number;
  method: string;
  error?: string;
}

function getBaseHeaders(): Headers {
  const headers = new Headers();

  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('Vary', 'Accept, Accept-Encoding, Origin');

  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Accept, Content-Type, Content-Length'
  );

  headers.set('X-DoH-Proxy-Version', PROXY_VERSION);

  return headers;
}

function createResponse(
  body: BodyInit | null,
  status: number,
  contentType = 'text/plain; charset=utf-8'
): NextResponse {
  const headers = getBaseHeaders();

  if (contentType) {
    headers.set('Content-Type', contentType);
  }

  return new NextResponse(body, {
    status,
    headers,
  });
}

function logRequest(entry: LogEntry): void {
  if (process.env.DEBUG_LOG === 'true' || entry.status >= 400) {
    console.log(JSON.stringify(entry));
  }
}

function isValidDomainName(value: string): boolean {
  if (value === '.') {
    return true;
  }

  if (
    value.length === 0 ||
    value.length > 253 ||
    !ALLOWED_DOMAIN_REGEX.test(value)
  ) {
    return false;
  }

  const labels = value.endsWith('.') ? value.slice(0, -1).split('.') : value.split('.');

  return labels.every((label) => {
    if (label.length === 0 || label.length > 63) {
      return false;
    }

    if (label.startsWith('-') || label.endsWith('-')) {
      return false;
    }

    return true;
  });
}

function validateRequest(
  url: URL,
  method: string
): NextResponse | null {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) {
    return createResponse('Query string too long', 414);
  }

  if (method === 'OPTIONS' || method === 'HEAD') {
    return null;
  }

  if (method === 'POST') {
    return null;
  }

  if (method !== 'GET') {
    return createResponse('Method not allowed', 405);
  }

  const dnsParam = url.searchParams.get('dns');

  if (dnsParam !== null) {
    if (
      dnsParam.length === 0 ||
      dnsParam.length > MAX_QUERY_STRING_LENGTH ||
      !DNS_MESSAGE_REGEX.test(dnsParam)
    ) {
      return createResponse('Invalid DNS message parameter', 400);
    }

    return null;
  }

  const nameParam = url.searchParams.get('name');

  if (!nameParam) {
    return createResponse('Invalid domain: empty', 400);
  }

  if (!isValidDomainName(nameParam)) {
    return createResponse('Invalid domain name', 400);
  }

  return null;
}

/**
 * Validates caller-supplied upstream URLs used by the manual provider.
 *
 * DNS resolution is not available from the Edge Runtime, so hostname-based
 * DNS rebinding cannot be completely prevented here. Literal private,
 * loopback, link-local, multicast, and reserved addresses are rejected.
 */
function isSafeUpstreamUrl(rawUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }

  if (url.username || url.password || url.hash) {
    return false;
  }

  let host = url.hostname.toLowerCase();

  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }

  const ipv4 = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );

  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);

    if (octets.some((octet) => octet < 0 || octet > 255)) {
      return false;
    }

    const [a, b] = octets;

    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    ) {
      return false;
    }

    return true;
  }

  if (host.includes(':')) {
    if (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('::ffff:')
    ) {
      return false;
    }

    return true;
  }

  return host.length > 0;
}

function getUpstreamUrl(
  providerId: string,
  providerEndpoint: string | undefined,
  url: URL
): string | NextResponse {
  const provider = getProvider(providerId);

  if (!provider) {
    return createResponse(`Provider '${providerId}' not found`, 404);
  }

  if (providerId === 'custom') {
    const customUrl = process.env.CUSTOM_DOH_URL;

    if (!customUrl) {
      return createResponse(
        'Configuration Error: CUSTOM_DOH_URL missing',
        500
      );
    }

    let parsedCustomUrl: URL;

    try {
      parsedCustomUrl = new URL(customUrl);
    } catch {
      return createResponse('Configuration Error: invalid CUSTOM_DOH_URL', 500);
    }

    if (
      parsedCustomUrl.protocol !== 'https:' &&
      parsedCustomUrl.protocol !== 'http:'
    ) {
      return createResponse(
        'Configuration Error: CUSTOM_DOH_URL must use HTTP or HTTPS',
        500
      );
    }

    return parsedCustomUrl.toString();
  }

  if (providerId === 'manual') {
    const manualUrl = url.searchParams.get('upstream');

    if (!manualUrl) {
      return createResponse('Missing "upstream" parameter', 400);
    }

    if (!isSafeUpstreamUrl(manualUrl)) {
      return createResponse('Invalid or disallowed upstream URL', 400);
    }

    return manualUrl;
  }

  const resolvedEndpoint = resolveProviderEndpoint(
    provider,
    providerEndpoint
  );

  if (!resolvedEndpoint) {
    return createResponse(
      `Endpoint '${providerEndpoint}' not found for provider '${providerId}'`,
      404
    );
  }

  return resolvedEndpoint;
}

function getAcceptHeader(request: NextRequest, url: URL): string {
  const clientAccept = request.headers.get('accept');

  if (clientAccept) {
    return clientAccept;
  }

  if (request.method === 'POST' || url.searchParams.has('dns')) {
    return 'application/dns-message';
  }

  return 'application/dns-json';
}

export async function handleDoH(
  request: NextRequest,
  providerId: string,
  formatSegment?: string
): Promise<NextResponse> {
  const startedAt = Date.now();

  let responseStatus = 500;
  let errorMessage: string | undefined;

  try {
    if (request.method === 'OPTIONS') {
      responseStatus = 204;
      return createResponse(null, 204, '');
    }

    if (request.method === 'HEAD') {
      responseStatus = 204;
      return createResponse(null, 204, '');
    }

    const url = new URL(request.url);
    const validationError = validateRequest(url, request.method);

    if (validationError) {
      responseStatus = validationError.status;
      return validationError;
    }

    let requestBody: ArrayBuffer | undefined;

    if (request.method === 'POST') {
      const contentLengthHeader = request.headers.get('content-length');

      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);

        if (
          !Number.isFinite(contentLength) ||
          contentLength < 0 ||
          contentLength > MAX_BODY_SIZE
        ) {
          responseStatus = 413;
          return createResponse('Payload too large', 413);
        }
      }

      requestBody = await request.arrayBuffer();

      if (requestBody.byteLength === 0) {
        responseStatus = 400;
        return createResponse('Empty DNS request body', 400);
      }

      if (requestBody.byteLength > MAX_BODY_SIZE) {
        responseStatus = 413;
        return createResponse('Payload too large', 413);
      }
    }

    const upstreamResult = getUpstreamUrl(
      providerId,
      formatSegment,
      url
    );

    if (upstreamResult instanceof NextResponse) {
      responseStatus = upstreamResult.status;
      return upstreamResult;
    }

    const upstreamUrl = new URL(upstreamResult);

    if (request.method === 'GET') {
      url.searchParams.forEach((value, key) => {
        if (key !== 'upstream') {
          upstreamUrl.searchParams.append(key, value);
        }
      });
    }

    const upstreamHeaders = new Headers();

    upstreamHeaders.set('Accept', getAcceptHeader(request, url));
    upstreamHeaders.set('User-Agent', 'Secure-DoH-Proxy/1.2');

    if (request.method === 'POST') {
      upstreamHeaders.set(
        'Content-Type',
        request.headers.get('content-type') || 'application/dns-message'
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    let upstreamResponse: Response;

    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === 'POST' ? requestBody : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timeoutId);
    }

    responseStatus = upstreamResponse.status;

    const responseHeaders = getBaseHeaders();
    const responseContentType =
      upstreamResponse.headers.get('content-type');

    if (responseContentType) {
      responseHeaders.set('Content-Type', responseContentType);
    }

    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    const isTimeout =
      error instanceof Error && error.name === 'AbortError';

    responseStatus = isTimeout ? 504 : 502;
    errorMessage = isTimeout
      ? 'Upstream Timeout'
      : 'Upstream Connection Failed';

    return createResponse(
      JSON.stringify({ error: errorMessage }),
      responseStatus,
      'application/json; charset=utf-8'
    );
  } finally {
    logRequest({
      timestamp: new Date().toISOString(),
      provider: providerId,
      durationMs: Date.now() - startedAt,
      status: responseStatus,
      method: request.method,
      error: errorMessage,
    });
  }
}
