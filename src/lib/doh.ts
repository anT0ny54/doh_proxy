import { NextResponse, type NextRequest } from "next/server";
import { DOH_PROVIDERS } from "@/lib/providers";
import {
  DNS_MESSAGE,
  isValidDnsQuery,
  isValidDnsResponse,
  MAX_DNS_MESSAGE_SIZE,
  MAX_DNS_RESPONSE_SIZE,
} from "@/lib/dns";
import { HAGEZI_UPSTREAMS } from "@/lib/upstreams";

export const PROXY_VERSION = "2.7.3";

const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const MAX_QUERY_STRING_LENGTH = 8_192;
const DEFAULT_TIMEOUT_MS = 2_500;
const MIN_TIMEOUT_MS = 250;
// An attempt with less budget than this cannot realistically finish (TLS + RTT)
// and would only be recorded as a bogus upstream failure, e.g. when a slow
// client consumed most of the request deadline while sending its POST body.
const MIN_ATTEMPT_TIMEOUT_MS = 100;
const HAGEZI_TIMEOUT_MS = 2_500;
const MAX_HAGEZI_ROTATION_SECONDS = 86_400;
const MIN_HAGEZI_ROTATION_SECONDS = 60;
const DEFAULT_HAGEZI_ROTATION_SECONDS = 1_800;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const STREAM_CANCEL_TIMEOUT_MS = 25;
// A small public instance can be overwhelmed by many simultaneous POST bodies
// or slow upstream connections. Refuse excess work rather than queueing it in
// memory and consuming the entire Node.js process.
export const MAX_IN_FLIGHT_REQUESTS = 32;
const BUSY_RETRY_AFTER_SECONDS = 1;
let inFlightRequests = 0;

// Circuit breaker configuration. State is per runtime instance/isolate (best
// effort), which is enough to avoid hammering an upstream that is clearly down.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

interface UpstreamInput {
  readonly endpoint: string;
}

interface NormalizedDoHUpstream extends UpstreamInput {
  readonly url: URL;
}

interface DoHOptions {
  /** Resolved lazily so HEAD/OPTIONS/validation failures never pay for rotation. */
  readonly upstreams: readonly UpstreamInput[] | (() => readonly UpstreamInput[]);
  readonly timeoutMs?: number;
  readonly failover?: boolean;
}

// Circuit breaker state
interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

function getCircuitBreaker(endpoint: string): CircuitBreakerState {
  let cb = circuitBreakers.get(endpoint);
  if (!cb) {
    cb = { failures: 0, lastFailureTime: 0, open: false };
    circuitBreakers.set(endpoint, cb);
  }
  return cb;
}

function isCircuitBreakerOpen(endpoint: string): boolean {
  const cb = getCircuitBreaker(endpoint);
  if (!cb.open) return false;

  // Cooldown elapsed: go half-open. One more failure re-opens the breaker
  // immediately instead of burning THRESHOLD slow attempts again.
  if (Date.now() - cb.lastFailureTime >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    cb.open = false;
    cb.failures = CIRCUIT_BREAKER_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordFailure(endpoint: string): void {
  const cb = getCircuitBreaker(endpoint);
  cb.failures += 1;
  cb.lastFailureTime = Date.now();
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    cb.open = true;
  }
}

function recordSuccess(endpoint: string): void {
  const cb = circuitBreakers.get(endpoint);
  if (cb) {
    cb.failures = 0;
    cb.open = false;
  }
}

const NORMALIZED_PROVIDER_UPSTREAMS = new Map(
  DOH_PROVIDERS.map((provider) => [
    provider.id,
    { endpoint: provider.endpoint, url: new URL(provider.endpoint) } satisfies NormalizedDoHUpstream,
  ]),
);

const NORMALIZED_HAGEZI_UPSTREAMS: readonly NormalizedDoHUpstream[] = HAGEZI_UPSTREAMS.map((upstream) => ({
  endpoint: upstream.endpoint,
  url: new URL(upstream.endpoint),
}));

function normalizeUpstream(upstream: UpstreamInput): NormalizedDoHUpstream {
  // Fixed upstreams are pre-parsed at module load; only parse injected ones.
  if ("url" in upstream && upstream.url instanceof URL) return upstream as NormalizedDoHUpstream;
  return { endpoint: upstream.endpoint, url: new URL(upstream.endpoint) };
}

export function getHageziUpstreams(): readonly NormalizedDoHUpstream[] {
  const raw = process.env.HAGEZI_ROTATION_SECONDS?.trim();
  const configured = raw ? Number(raw) : DEFAULT_HAGEZI_ROTATION_SECONDS;
  const seconds = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), MIN_HAGEZI_ROTATION_SECONDS), MAX_HAGEZI_ROTATION_SECONDS)
    : DEFAULT_HAGEZI_ROTATION_SECONDS;
  const slot = Math.floor(Date.now() / (seconds * 1_000)) % HAGEZI_UPSTREAMS.length;

  return Array.from(
    { length: HAGEZI_UPSTREAMS.length },
    (_, offset) => NORMALIZED_HAGEZI_UPSTREAMS[(slot + offset) % NORMALIZED_HAGEZI_UPSTREAMS.length],
  );
}

function getProviderUpstream(providerId: string): NormalizedDoHUpstream | undefined {
  return NORMALIZED_PROVIDER_UPSTREAMS.get(providerId);
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

function busyResponse(): NextResponse {
  const response = textResponse("DNS proxy busy", 503);
  response.headers.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
  return response;
}

function tryAcquireInFlight(): boolean {
  if (inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) return false;
  inFlightRequests += 1;
  return true;
}

function releaseInFlight(): void {
  inFlightRequests = Math.max(0, inFlightRequests - 1);
}

function getEarlyMethodResponse(request: NextRequest): NextResponse | null {
  if (request.method === "OPTIONS") return emptyResponse();

  // RFC 9110: a 204 response must not include Content-Length.
  if (request.method === "HEAD") return emptyResponse();

  if (request.method !== "GET" && request.method !== "POST") {
    const result = textResponse("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
    return result;
  }

  return null;
}

async function cancelReaderBestEffort<T>(reader: ReadableStreamDefaultReader<T>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.cancel().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), STREAM_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await cancelReaderBestEffort(reader);
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
          await cancelReaderBestEffort(reader);
          return textResponse("Payload too large", 413);
        }

        chunks.push(result.value);
        total = nextTotal;
      } catch (error) {
        await cancelReaderBestEffort(reader);
        if (error === timeoutToken) return textResponse("Request body timeout", 408);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A best-effort cancellation may still be settling a pending read.
    }
  }

  const body = concatChunks(chunks, total);
  if (!isValidDnsQuery(body)) return textResponse("Invalid DNS message", 400);
  return body;
}

async function readResponseBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size > MAX_DNS_RESPONSE_SIZE) return null;
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const nextTotal = total + value.byteLength;
      if (nextTotal > MAX_DNS_RESPONSE_SIZE) {
        await cancelReaderBestEffort(reader);
        return null;
      }

      chunks.push(value);
      total = nextTotal;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A best-effort cancellation may still be settling a pending read.
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  return concatChunks(chunks, total);
}

function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (!body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    body.cancel(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STREAM_CANCEL_TIMEOUT_MS);
    }),
  ])
    .catch(() => undefined)
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

/**
 * TypeScript 6 models Uint8Array as possibly backed by SharedArrayBuffer,
 * while fetch()/NextResponse BodyInit requires an ArrayBuffer in this context.
 * Copying into a fresh ArrayBuffer preserves the bytes and satisfies the
 * server-side fetch/Response body types.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }

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
  upstream: NormalizedDoHUpstream,
  body: Uint8Array | undefined,
  timeoutMs: number,
): Promise<UpstreamFetch> {
  const isGet = request.method === "GET" && dnsParam !== undefined;
  // Copy the pre-parsed URL only when it must be mutated.
  const url = isGet ? new URL(upstream.url) : upstream.url;
  if (isGet) url.searchParams.set("dns", dnsParam);

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
      cache: "no-store",
      redirect: "error",
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

export async function proxyRequest(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  const earlyResponse = getEarlyMethodResponse(request);
  if (earlyResponse) return earlyResponse;
  if (!tryAcquireInFlight()) return busyResponse();

  try {
    return await proxyRequestInternal(request, options);
  } finally {
    releaseInFlight();
  }
}

async function proxyRequestInternal(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  let queryBody: Uint8Array;
  let dnsParam: string | undefined;
  const timeout = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeout;

  if (request.method === "GET") {
    const validation = validateGet(new URL(request.url));
    if (validation instanceof NextResponse) return validation;
    dnsParam = validation.dnsParam;
    queryBody = validation.queryBody;
  } else {
    const bodyResult = await readPostBody(request, deadline);
    if (bodyResult instanceof NextResponse) return bodyResult;
    queryBody = bodyResult;
  }

  const failover = options.failover !== false;
  const configured = typeof options.upstreams === "function" ? options.upstreams() : options.upstreams;
  const normalizedUpstreams = configured.map(normalizeUpstream);
  let upstreams = failover ? normalizedUpstreams : normalizedUpstreams.slice(0, 1);

  // Skip upstreams whose breaker is open, but never fail fast when *all* of
  // them are open: a probe request is what lets a recovered upstream close its
  // breaker sooner, and a dead-looking upstream may still answer.
  const healthy = upstreams.filter((upstream) => !isCircuitBreakerOpen(upstream.endpoint));
  if (healthy.length > 0) upstreams = healthy;

  const perAttemptTimeout = failover
    ? Math.max(750, Math.floor(timeout / Math.max(upstreams.length, 1)))
    : timeout;

  // Last non-200 status seen from the most recent attempt, if that attempt was a
  // definite upstream rejection (as opposed to a timeout/invalid body).
  let lastRejectedStatus: number | undefined;

  for (const upstream of upstreams) {
    const attemptTimeout = Math.min(deadline - Date.now(), perAttemptTimeout);
    if (attemptTimeout < MIN_ATTEMPT_TIMEOUT_MS) break;
    lastRejectedStatus = undefined;

    try {
      const upstreamFetch = await fetchUpstream(
        request,
        dnsParam,
        upstream,
        request.method === "POST" ? queryBody : undefined,
        attemptTimeout,
      );
      const result = upstreamFetch.response;

      try {
        // Only retryable availability problems (timeouts, network errors, and
        // retryable upstream statuses) count toward the breaker. Client-influenced outcomes — upstream 4xx,
        // oversized or otherwise rejected responses — must not let one caller
        // take an upstream offline for everybody.
        if (result.status !== 200) {
          cancelResponseBody(result);
          if (RETRYABLE_UPSTREAM_STATUSES.has(result.status)) {
            recordFailure(upstream.endpoint);
            continue;
          }
          // A non-retryable status (403 from an egress-IP block, 404 from a
          // misconfigured node, ...) says nothing about the *next* upstream, so
          // keep failing over and only relay the status if nothing else answers.
          // It does not count against the breaker: it may be client-influenced.
          // Only 4xx/5xx statuses are retained for a final relay; other non-200
          // statuses are invalid for DoH and fall back to a generic 502.
          lastRejectedStatus = result.status >= 400 && result.status <= 599 ? result.status : 502;
          continue;
        }

        const contentType = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (contentType !== DNS_MESSAGE) {
          cancelResponseBody(result);
          continue;
        }

        const responseBody = await readResponseBody(result);
        if (responseBody === null || !isValidDnsResponse(responseBody, queryBody)) {
          cancelResponseBody(result);
          continue;
        }

        recordSuccess(upstream.endpoint);

        const headers = baseHeaders();
        headers.set("Content-Type", DNS_MESSAGE);
        headers.set("Content-Length", String(responseBody.byteLength));
        return new NextResponse(toArrayBuffer(responseBody), { status: 200, headers });
      } finally {
        upstreamFetch.cleanup();
      }
    } catch {
      // Network errors and timeouts are retryable; try the next fixed upstream.
      recordFailure(upstream.endpoint);
    }
  }

  if (lastRejectedStatus !== undefined) return textResponse("DNS upstream rejected request", lastRejectedStatus);
  return textResponse("DNS upstream unavailable", 502);
}

export async function handleDoH(
  request: NextRequest,
  providerId: string,
): Promise<NextResponse> {
  const upstream = getProviderUpstream(providerId);
  if (!upstream) return textResponse("Not Found", 404);

  return proxyRequest(request, { upstreams: [upstream], failover: false });
}

export async function handleHageziDoH(request: NextRequest): Promise<NextResponse> {
  return proxyRequest(request, {
    upstreams: getHageziUpstreams,
    timeoutMs: HAGEZI_TIMEOUT_MS,
    failover: true,
  });
}
