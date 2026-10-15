import { NextResponse, type NextRequest } from "next/server";
import packageJson from "../../package.json";
import { CLIENT_KEY_HEADER, CONFIG } from "@/lib/config";
import { corsHeaders } from "@/lib/cors";
import {
  DNS_MESSAGE,
  isValidDnsResponse,
  MAX_DNS_MESSAGE_SIZE,
  MAX_DNS_RESPONSE_SIZE,
  parseQuery,
  type ParsedQuery,
} from "@/lib/dns";
import { DOH_PROVIDERS } from "@/lib/providers";
import { HAGEZI_UPSTREAMS } from "@/lib/upstreams";

/** Single source of truth: package.json. */
export const PROXY_VERSION: string = packageJson.version;

const USER_AGENT = `FreeDNS-DoH/${PROXY_VERSION}`;
const MAX_QUERY_STRING_LENGTH = 8_192;
// Longest base64url string that can encode a maximum-size query.
const MAX_ENCODED_QUERY_LENGTH = Math.ceil((MAX_DNS_MESSAGE_SIZE * 4) / 3);
const DEFAULT_TIMEOUT_MS = 2_500;
// A client must deliver its POST body within this window (or the overall
// request deadline, if shorter), so slow senders cannot pin in-flight slots.
const MAX_BODY_READ_MS = 1_000;
// Smallest slice of the budget a failover attempt is given.
const MIN_FAILOVER_SLICE_MS = 750;
const MIN_TIMEOUT_MS = 250;
// An attempt with less budget than this cannot realistically finish (TLS + RTT)
// and would only be recorded as a bogus upstream failure, e.g. when a slow
// client consumed most of the request deadline while sending its POST body.
const MIN_ATTEMPT_TIMEOUT_MS = 100;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const STREAM_CANCEL_TIMEOUT_MS = 25;
// A small public instance can be overwhelmed by many simultaneous POST bodies
// or slow upstream connections. Refuse excess work rather than queueing it in
// memory and consuming the entire Node.js process.
export const MAX_IN_FLIGHT_REQUESTS = 32;
// One identified client may hold at most this many of those slots.
export const MAX_IN_FLIGHT_PER_IP = 8;
const BUSY_RETRY_AFTER_SECONDS = 1;
// Upstream Cache-Control max-age is relayed for GET (capped) so clients can
// cache answers; the proxy itself keeps no DNS cache.
const MAX_RELAYED_MAX_AGE_SECONDS = 300;

// Circuit breaker configuration (failover endpoint only). State is per
// runtime instance (best effort), which is enough to avoid hammering an
// upstream that is clearly down.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
// Failures further apart than this do not accumulate toward the threshold.
const CIRCUIT_BREAKER_FAILURE_WINDOW_MS = 30_000;
// Safety net only: every attempt is bounded by the request deadline (<= 5 s
// maxDuration) and every exit path reports back, so in practice a probe slot is
// always released explicitly. This frees it if that ever fails to happen.
const CIRCUIT_BREAKER_PROBE_TTL_MS = 5_000;

interface UpstreamInput {
  readonly endpoint: string;
}

interface NormalizedDoHUpstream extends UpstreamInput {
  /** Endpoint URL without fragment, used for POST. */
  readonly href: string;
  /** `href` plus "?" or "&", ready for the GET `dns=` parameter. */
  readonly getPrefix: string;
}

interface DoHOptions {
  /** Resolved lazily so HEAD/OPTIONS/validation failures never pay for rotation. */
  readonly upstreams: readonly UpstreamInput[] | (() => readonly UpstreamInput[]);
  readonly timeoutMs?: number;
  readonly failover?: boolean;
}

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  /** Owner of the in-flight half-open probe, or 0 when none is active. */
  probeToken: number;
  probeStartedAt: number;
}

interface ProxyState {
  inFlight: number;
  inFlightByIp: Map<string, number>;
  circuitBreakers: Map<string, CircuitBreakerState>;
  rotationCounter: number;
  probeCounter: number;
}

// Kept on globalThis so that if the bundler instantiates this module more than
// once in a process (e.g. one copy per route), the counters and breakers are
// still shared instead of silently split.
const globalStore = globalThis as typeof globalThis & { __dohProxyState?: ProxyState };
const state: ProxyState = (globalStore.__dohProxyState ??= {
  inFlight: 0,
  inFlightByIp: new Map(),
  circuitBreakers: new Map(),
  rotationCounter: 0,
  probeCounter: 0,
});

/**
 * Open = THRESHOLD failures without an intervening success. While open, the
 * breaker blocks traffic during the cooldown and, afterwards, while a half-open
 * probe is in flight. Read-only on purpose: filtering a list of upstreams must
 * not reserve a probe for one that is never actually contacted.
 */
function isCircuitBreakerOpen(endpoint: string): boolean {
  const cb = state.circuitBreakers.get(endpoint);
  if (!cb || cb.failures < CIRCUIT_BREAKER_THRESHOLD) return false;

  const now = Date.now();
  if (now - cb.lastFailureTime < CIRCUIT_BREAKER_COOLDOWN_MS) return true;
  return cb.probeToken !== 0 && now - cb.probeStartedAt < CIRCUIT_BREAKER_PROBE_TTL_MS;
}

/**
 * Reserves the half-open probe slot of a tripped breaker right before an
 * attempt starts and returns an ownership token (0 when there is nothing to
 * reserve). Only the owner may later release the slot.
 */
function claimProbe(endpoint: string): number {
  const cb = state.circuitBreakers.get(endpoint);
  if (!cb || cb.failures < CIRCUIT_BREAKER_THRESHOLD) return 0;
  state.probeCounter += 1;
  cb.probeToken = state.probeCounter;
  cb.probeStartedAt = Date.now();
  return cb.probeToken;
}

/**
 * Frees a half-open probe slot after an attempt that ended without a verdict
 * (non-retryable status, wrong content type, invalid body, client gone), but
 * only if this attempt still owns it.
 */
function releaseProbe(endpoint: string, token: number): void {
  if (token === 0) return;
  const cb = state.circuitBreakers.get(endpoint);
  if (cb && cb.probeToken === token) {
    cb.probeToken = 0;
    cb.probeStartedAt = 0;
  }
}

function recordFailure(endpoint: string): void {
  const now = Date.now();
  let cb = state.circuitBreakers.get(endpoint);
  if (!cb) {
    cb = { failures: 0, lastFailureTime: 0, probeToken: 0, probeStartedAt: 0 };
    state.circuitBreakers.set(endpoint, cb);
  }
  // Isolated, old failures expire; a tripped breaker keeps its count so that a
  // failed half-open probe re-opens it immediately.
  if (cb.failures < CIRCUIT_BREAKER_THRESHOLD && now - cb.lastFailureTime > CIRCUIT_BREAKER_FAILURE_WINDOW_MS) {
    cb.failures = 0;
  }
  cb.failures += 1;
  cb.lastFailureTime = now;
  cb.probeToken = 0;
  cb.probeStartedAt = 0;
}

function recordSuccess(endpoint: string): void {
  state.circuitBreakers.delete(endpoint);
}

function normalize(endpoint: string): NormalizedDoHUpstream {
  const url = new URL(endpoint);
  url.hash = "";
  return { endpoint, href: url.href, getPrefix: `${url.href}${url.search ? "&" : "?"}` };
}

function normalizeUpstream(upstream: UpstreamInput): NormalizedDoHUpstream {
  // Fixed upstreams are pre-parsed at module load; only parse injected ones.
  return "getPrefix" in upstream ? (upstream as NormalizedDoHUpstream) : normalize(upstream.endpoint);
}

const NORMALIZED_PROVIDER_UPSTREAMS = new Map(
  DOH_PROVIDERS.map((provider) => [provider.id, normalize(provider.endpoint)]),
);

const NORMALIZED_HAGEZI_UPSTREAMS = HAGEZI_UPSTREAMS.map((upstream) => normalize(upstream.endpoint));

const ROTATED_HAGEZI_UPSTREAMS: readonly (readonly NormalizedDoHUpstream[])[] = NORMALIZED_HAGEZI_UPSTREAMS.map(
  (_, slot) =>
    NORMALIZED_HAGEZI_UPSTREAMS.map(
      (__, offset) => NORMALIZED_HAGEZI_UPSTREAMS[(slot + offset) % NORMALIZED_HAGEZI_UPSTREAMS.length],
    ),
);

/** Operator override (HAGEZI_UPSTREAM_ENDPOINTS), used as given without rotation. */
const OVERRIDE_UPSTREAMS: readonly NormalizedDoHUpstream[] | undefined =
  CONFIG.hageziUpstreamEndpoints.length > 0 ? CONFIG.hageziUpstreamEndpoints.map(normalize) : undefined;
const ROTATION_SLOT_MS = CONFIG.hageziRotationSeconds * 1_000;

/**
 * Failover order for the primary endpoint. By default the first choice changes
 * on a time slot (consistent across instances); with
 * HAGEZI_ROTATION_MODE=request it round-robins per request to spread load. A
 * valid HAGEZI_UPSTREAM_ENDPOINTS override replaces the rotated built-in list.
 */
export function getHageziUpstreams(): readonly NormalizedDoHUpstream[] {
  if (OVERRIDE_UPSTREAMS) return OVERRIDE_UPSTREAMS;
  const count = ROTATED_HAGEZI_UPSTREAMS.length;
  const slot = CONFIG.hageziRotationPerRequest
    ? state.rotationCounter++ % count
    : Math.floor(Date.now() / ROTATION_SLOT_MS) % count;
  return ROTATED_HAGEZI_UPSTREAMS[slot];
}

function baseHeaders(): Headers {
  const headers = corsHeaders();
  headers.set("Cache-Control", "no-store, max-age=0");
  return headers;
}

function textResponse(message: string, status: number): NextResponse {
  const headers = baseHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new NextResponse(message, { status, headers });
}

function busyResponse(): NextResponse {
  const response = textResponse("DNS proxy busy", 503);
  response.headers.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
  return response;
}

function tryAcquireInFlight(clientKey: string | null): boolean {
  if (state.inFlight >= MAX_IN_FLIGHT_REQUESTS) return false;
  if (clientKey !== null) {
    const current = state.inFlightByIp.get(clientKey) ?? 0;
    if (current >= MAX_IN_FLIGHT_PER_IP) return false;
    state.inFlightByIp.set(clientKey, current + 1);
  }
  state.inFlight += 1;
  return true;
}

function releaseInFlight(clientKey: string | null): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (clientKey === null) return;
  const current = state.inFlightByIp.get(clientKey) ?? 0;
  if (current <= 1) state.inFlightByIp.delete(clientKey);
  else state.inFlightByIp.set(clientKey, current - 1);
}

/**
 * Cancels a stream or reader but never waits longer than
 * STREAM_CANCEL_TIMEOUT_MS for it to settle. Never rejects; resolves `true`
 * when the cancellation settled in time.
 */
async function cancelBestEffort(target: { cancel(): Promise<void> }): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.cancel().then(
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

interface ValidatedQuery {
  readonly body: Uint8Array;
  readonly parsed: ParsedQuery;
}

/** Strips optional trailing `=` padding (RFC 8484 omits it, but clients send it). */
function stripPadding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x3d && value.length - end < 2) end -= 1;
  return value.slice(0, end);
}

/** Decodes the `dns` parameter; returns the canonical unpadded form with it. */
function decodeBase64Url(value: string): { readonly unpadded: string; readonly query: ValidatedQuery } | null {
  if (!value || value.length > MAX_ENCODED_QUERY_LENGTH + 2 || !BASE64URL.test(value)) return null;
  const unpadded = stripPadding(value);
  if (!unpadded || unpadded.length > MAX_ENCODED_QUERY_LENGTH || unpadded.length % 4 === 1) return null;

  const body = Buffer.from(unpadded, "base64url");
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return null;

  const parsed = parseQuery(body);
  return parsed === null ? null : { unpadded, query: { body, parsed } };
}

interface QueryUrl {
  readonly search: string;
  readonly searchParams: URLSearchParams;
}

function validateGet(url: QueryUrl): { readonly dnsParam: string; readonly query: ValidatedQuery } | NextResponse {
  // `url.search` includes the leading "?".
  if (url.search.length > MAX_QUERY_STRING_LENGTH + 1) return textResponse("Query string too long", 414);

  const dnsValues = url.searchParams.getAll("dns");
  if (dnsValues.length !== 1) return textResponse("Invalid DNS message", 400);

  const decoded = decodeBase64Url(dnsValues[0]);
  if (decoded === null) return textResponse("Invalid DNS message", 400);

  // Forward the canonical unpadded form to the upstream.
  return { dnsParam: decoded.unpadded, query: decoded.query };
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

async function readPostBody(request: NextRequest, deadline: number): Promise<ValidatedQuery | NextResponse> {
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
        await cancelBestEffort(reader);
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
          await cancelBestEffort(reader);
          return textResponse("Payload too large", 413);
        }

        chunks.push(result.value);
        total = nextTotal;
      } catch (error) {
        await cancelBestEffort(reader);
        if (error === timeoutToken) return textResponse("Request body timeout", 408);
        // The client's body stream failed (e.g. the upload was aborted). Answer
        // instead of letting the error escape the handler as an unhandled 500.
        return textResponse("Request body error", 400);
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

  const body = chunks.length === 1 ? chunks[0] : concatChunks(chunks, total);
  const parsed = parseQuery(body);
  if (parsed === null) return textResponse("Invalid DNS message", 400);
  return { body, parsed };
}

function cancelResponseBody(response: Response): void {
  if (response.body) void cancelBestEffort(response.body);
}

async function readResponseBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size < 0 || size > MAX_DNS_RESPONSE_SIZE) {
      cancelResponseBody(response);
      return null;
    }
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Keep the lock while a best-effort cancel may still be settling; only a
  // fully settled stream may have its lock released.
  let settled = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        settled = true;
        break;
      }

      const nextTotal = total + value.byteLength;
      if (nextTotal > MAX_DNS_RESPONSE_SIZE) {
        settled = await cancelBestEffort(reader);
        return null;
      }

      chunks.push(value);
      total = nextTotal;
    }
  } finally {
    if (settled) {
      try {
        reader.releaseLock();
      } catch {
        // A best-effort cancellation may still be settling a pending read.
      }
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  return concatChunks(chunks, total);
}

/**
 * TypeScript 6 models Uint8Array as possibly backed by SharedArrayBuffer,
 * while fetch()/NextResponse BodyInit requires an ArrayBuffer in this context.
 * Copying into a fresh ArrayBuffer (only when needed) satisfies those types.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * One upstream attempt. `signal` stays attached to the response body, so
 * reading the body is bounded by the same deadline. Client disconnects abort
 * the attempt immediately via `request.signal` (absent on the plain objects
 * some unit tests pass).
 *
 * The deadline is an AbortController + timer owned by the caller, NOT
 * AbortSignal.timeout(): a timeout signal referenced only through
 * AbortSignal.any() can be garbage-collected and then never fires (Node.js
 * holds composite sources weakly), which would silently disable the deadline.
 */
function fetchUpstream(
  request: NextRequest,
  upstream: NormalizedDoHUpstream,
  dnsSearch: string | undefined,
  body: ArrayBuffer | undefined,
  deadline: AbortSignal,
): Promise<Response> {
  const headers = new Headers({ Accept: DNS_MESSAGE, "User-Agent": USER_AGENT });
  if (body !== undefined) headers.set("Content-Type", DNS_MESSAGE);

  return fetch(dnsSearch === undefined ? upstream.href : upstream.getPrefix + dnsSearch, {
    method: request.method,
    headers,
    body,
    signal: request.signal ? AbortSignal.any([deadline, request.signal]) : deadline,
    cache: "no-store",
    redirect: "error",
  });
}

/**
 * Remaining freshness (seconds, capped) to relay from an upstream response:
 * Cache-Control max-age minus the Age the answer has already spent in an
 * upstream cache. 0 means "do not cache".
 */
function relayedMaxAge(cacheControl: string | null, age: string | null): number {
  if (!cacheControl || /(?:^|[\s,])(?:no-store|no-cache)(?:$|[\s,=])/i.test(cacheControl)) return 0;
  const match = /(?:^|[\s,])max-age=(\d{1,9})(?:$|[\s,])/i.exec(cacheControl);
  if (!match) return 0;
  const spent = age !== null && /^\d{1,9}$/.test(age.trim()) ? Number(age.trim()) : 0;
  return Math.min(Math.max(Number(match[1]) - spent, 0), MAX_RELAYED_MAX_AGE_SECONDS);
}

export async function proxyRequest(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  // RFC 9110: a 204 response must not include Content-Length. Other methods
  // never get here: the routes export only GET/POST/HEAD/OPTIONS, and the
  // Next.js router answers 405 for anything else.
  if (request.method === "OPTIONS" || request.method === "HEAD") {
    return new NextResponse(null, { status: 204, headers: baseHeaders() });
  }

  // Set (or removed) by src/proxy.ts on every request, so it is trustworthy.
  const clientKey = request.headers.get(CLIENT_KEY_HEADER);
  if (!tryAcquireInFlight(clientKey)) return busyResponse();

  try {
    return await proxyRequestInternal(request, options);
  } finally {
    releaseInFlight(clientKey);
  }
}

async function proxyRequestInternal(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  let query: ValidatedQuery;
  let dnsParam: string | undefined;
  const timeout = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  if (request.method === "GET") {
    const validation = validateGet(request.nextUrl ?? new URL(request.url));
    if (validation instanceof NextResponse) return validation;
    dnsParam = validation.dnsParam;
    query = validation.query;
  } else {
    const bodyResult = await readPostBody(request, Math.min(deadline, startedAt + MAX_BODY_READ_MS));
    if (bodyResult instanceof NextResponse) return bodyResult;
    query = bodyResult;
  }

  const failover = options.failover !== false;
  // The circuit breaker only matters when there is a next upstream to fail
  // over to; a single fixed upstream is always tried.
  const useBreaker = failover;
  const configured = typeof options.upstreams === "function" ? options.upstreams() : options.upstreams;
  // Provider routes try exactly one upstream, so only that one is normalized.
  let upstreams = (failover ? configured : configured.slice(0, 1)).map(normalizeUpstream);

  // Copy the POST body into a fresh ArrayBuffer once per request, and
  // pre-encode the GET dns parameter once, instead of per attempt.
  const postBody = request.method === "POST" ? toArrayBuffer(query.body) : undefined;
  const dnsSearch = dnsParam === undefined ? undefined : `dns=${encodeURIComponent(dnsParam)}`;

  // Skip upstreams whose breaker is open, but never fail fast when *all* of
  // them are open: a probe request is what lets a recovered upstream close its
  // breaker sooner, and a dead-looking upstream may still answer.
  let probeAll = true;
  if (useBreaker) {
    const healthy = upstreams.filter((upstream) => !isCircuitBreakerOpen(upstream.endpoint));
    probeAll = healthy.length === 0;
    if (!probeAll) upstreams = healthy;
  }

  // Last definite upstream rejection (non-200 status) seen across attempts. A
  // later timeout or invalid body does not erase it; it is relayed only if no
  // upstream ends up answering.
  let lastRejectedStatus: number | undefined;

  for (let index = 0; index < upstreams.length; index += 1) {
    const upstream = upstreams[index];
    // An earlier attempt may have taken a while, and another request may have
    // claimed this upstream's half-open probe in the meantime.
    if (useBreaker && !probeAll && isCircuitBreakerOpen(upstream.endpoint)) continue;
    // Share what is left of the budget across the attempts still to come, so
    // time saved by fast failures flows to later upstreams (the last one gets
    // everything that remains).
    const remaining = deadline - Date.now();
    const share = failover
      ? Math.max(MIN_FAILOVER_SLICE_MS, Math.floor(remaining / (upstreams.length - index)))
      : remaining;
    const attemptTimeout = Math.min(remaining, share);
    if (attemptTimeout < MIN_ATTEMPT_TIMEOUT_MS) break;

    const probe = useBreaker ? claimProbe(upstream.endpoint) : 0;
    // Kept active until the response body has been consumed (see fetchUpstream).
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), attemptTimeout);
    try {
      const result = await fetchUpstream(request, upstream, dnsSearch, postBody, attempt.signal);

      // Only retryable availability problems (timeouts, network errors and
      // retryable upstream statuses) count toward the breaker. Client-influenced
      // outcomes (upstream 4xx, oversized or otherwise rejected responses) must
      // not let one caller take an upstream offline for everybody.
      if (result.status !== 200) {
        cancelResponseBody(result);
        if (RETRYABLE_UPSTREAM_STATUSES.has(result.status)) {
          if (useBreaker) recordFailure(upstream.endpoint);
          continue;
        }
        // A non-retryable status (403 from an egress-IP block, 404 from a
        // misconfigured node, ...) says nothing about the *next* upstream, so
        // keep failing over and only relay the status if nothing else answers.
        // Only 4xx/5xx statuses are retained; others fall back to 502.
        lastRejectedStatus = result.status >= 400 && result.status <= 599 ? result.status : 502;
        releaseProbe(upstream.endpoint, probe);
        continue;
      }

      const contentType = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== DNS_MESSAGE) {
        cancelResponseBody(result);
        releaseProbe(upstream.endpoint, probe);
        continue;
      }

      // readResponseBody cancels the stream itself on its early-exit paths.
      const responseBody = await readResponseBody(result);
      if (responseBody === null || !isValidDnsResponse(responseBody, query.parsed)) {
        releaseProbe(upstream.endpoint, probe);
        continue;
      }

      if (useBreaker) recordSuccess(upstream.endpoint);

      const headers = baseHeaders();
      headers.set("Content-Type", DNS_MESSAGE);
      // Next.js streams ArrayBuffer bodies with chunked encoding unless the
      // length is declared; DoH clients and caches expect Content-Length.
      headers.set("Content-Length", String(responseBody.byteLength));
      if (request.method === "GET") {
        const maxAge = relayedMaxAge(result.headers.get("cache-control"), result.headers.get("age"));
        if (maxAge > 0) headers.set("Cache-Control", `private, max-age=${maxAge}`);
      }
      return new NextResponse(toArrayBuffer(responseBody), { status: 200, headers });
    } catch {
      if (request.signal?.aborted) {
        // The client disconnected: stop failing over without blaming the
        // upstream or holding its half-open circuit-breaker probe slot.
        releaseProbe(upstream.endpoint, probe);
        break;
      }
      // Network errors and timeouts are retryable; try the next fixed upstream.
      if (useBreaker) recordFailure(upstream.endpoint);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastRejectedStatus !== undefined) return textResponse("DNS upstream rejected request", lastRejectedStatus);
  return textResponse("DNS upstream unavailable", 502);
}

export async function handleDoH(request: NextRequest, providerId: string): Promise<NextResponse> {
  const upstream = NORMALIZED_PROVIDER_UPSTREAMS.get(providerId);
  if (!upstream) return textResponse("Not Found", 404);

  return proxyRequest(request, { upstreams: [upstream], failover: false });
}

export async function handleHageziDoH(request: NextRequest): Promise<NextResponse> {
  return proxyRequest(request, {
    upstreams: getHageziUpstreams,
    failover: true,
  });
}
