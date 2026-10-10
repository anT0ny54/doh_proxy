import { NextResponse, type NextRequest } from "next/server";
import { getClientIp, isProxyTrustEnabled } from "@/lib/client-ip";
import { DOH_PROVIDERS } from "@/lib/providers";
import {
  DNS_MESSAGE,
  isValidDnsResponse,
  MAX_DNS_MESSAGE_SIZE,
  MAX_DNS_RESPONSE_SIZE,
  parseQuery,
  type ParsedQuery,
} from "@/lib/dns";
import { HAGEZI_UPSTREAMS } from "@/lib/upstreams";

export const PROXY_VERSION = "2.8.1";

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
const MAX_HAGEZI_ROTATION_SECONDS = 86_400;
const MIN_HAGEZI_ROTATION_SECONDS = 60;
const DEFAULT_HAGEZI_ROTATION_SECONDS = 1_800;
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

// Circuit breaker configuration. State is per runtime instance/isolate (best
// effort), which is enough to avoid hammering an upstream that is clearly down.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
// A half-open probe that never reports back frees the slot after this long.
const CIRCUIT_BREAKER_PROBE_TTL_MS = 5_000;

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

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  /** Start of the in-flight half-open probe, or 0 when none is active. */
  probeStartedAt: number;
}

interface ProxyState {
  inFlight: number;
  inFlightByIp: Map<string, number>;
  circuitBreakers: Map<string, CircuitBreakerState>;
  rotationCounter: number;
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
});

/**
 * Open = THRESHOLD failures without an intervening success. While open, the
 * breaker blocks traffic during the cooldown and, afterwards, while a half-open
 * probe is in flight. Read-only on purpose: filtering a list of upstreams must
 * not reserve a probe for one that is never actually contacted (see
 * {@link claimProbe}).
 */
function isCircuitBreakerOpen(endpoint: string): boolean {
  const cb = state.circuitBreakers.get(endpoint);
  if (!cb || cb.failures < CIRCUIT_BREAKER_THRESHOLD) return false;

  const now = Date.now();
  if (now - cb.lastFailureTime < CIRCUIT_BREAKER_COOLDOWN_MS) return true;
  return cb.probeStartedAt !== 0 && now - cb.probeStartedAt < CIRCUIT_BREAKER_PROBE_TTL_MS;
}

/**
 * Reserves the half-open probe slot of a tripped breaker right before an
 * attempt starts, so concurrent requests skip that upstream until the probe
 * reports back (failure re-opens the breaker, success resets it) or the slot
 * expires. Doing this at attempt time, not while filtering, keeps a recovered
 * upstream from being locked out when an earlier upstream answers first.
 */
function claimProbe(endpoint: string): void {
  const cb = state.circuitBreakers.get(endpoint);
  if (cb && cb.failures >= CIRCUIT_BREAKER_THRESHOLD) cb.probeStartedAt = Date.now();
}

function recordFailure(endpoint: string): void {
  let cb = state.circuitBreakers.get(endpoint);
  if (!cb) {
    cb = { failures: 0, lastFailureTime: 0, probeStartedAt: 0 };
    state.circuitBreakers.set(endpoint, cb);
  }
  cb.failures += 1;
  cb.lastFailureTime = Date.now();
  cb.probeStartedAt = 0;
}

function recordSuccess(endpoint: string): void {
  state.circuitBreakers.delete(endpoint);
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

const ROTATED_HAGEZI_UPSTREAMS: readonly (readonly NormalizedDoHUpstream[])[] = NORMALIZED_HAGEZI_UPSTREAMS.map(
  (_, slot) =>
    NORMALIZED_HAGEZI_UPSTREAMS.map(
      (__, offset) => NORMALIZED_HAGEZI_UPSTREAMS[(slot + offset) % NORMALIZED_HAGEZI_UPSTREAMS.length],
    ),
);

interface RotationConfig {
  readonly seconds: number;
  readonly perRequest: boolean;
}

let rotationConfigCache: { readonly key: string; readonly config: RotationConfig } | undefined;

function getRotationConfig(): RotationConfig {
  const rawSeconds = process.env.HAGEZI_ROTATION_SECONDS?.trim() ?? "";
  const rawMode = process.env.HAGEZI_ROTATION_MODE?.trim().toLowerCase() ?? "";
  const key = `${rawSeconds}|${rawMode}`;
  if (rotationConfigCache?.key === key) return rotationConfigCache.config;

  const configured = rawSeconds ? Number(rawSeconds) : DEFAULT_HAGEZI_ROTATION_SECONDS;
  const seconds = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), MIN_HAGEZI_ROTATION_SECONDS), MAX_HAGEZI_ROTATION_SECONDS)
    : DEFAULT_HAGEZI_ROTATION_SECONDS;
  const config = { seconds, perRequest: rawMode === "request" };
  rotationConfigCache = { key, config };
  return config;
}

let overrideUpstreams: readonly NormalizedDoHUpstream[] | null | undefined;

/**
 * Optional comma-separated endpoint override (HAGEZI_UPSTREAM_ENDPOINTS).
 * Primarily for the integration test-suite and self-hosted deployments that
 * pin their own resolvers; unset in production. Invalid entries are ignored.
 */
function getOverrideUpstreams(): readonly NormalizedDoHUpstream[] | undefined {
  if (overrideUpstreams !== undefined) return overrideUpstreams ?? undefined;
  const raw = process.env.HAGEZI_UPSTREAM_ENDPOINTS?.trim() ?? "";
  const endpoints = raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  const parsed: NormalizedDoHUpstream[] = [];
  for (const endpoint of endpoints) {
    try {
      parsed.push({ endpoint, url: new URL(endpoint) });
    } catch {
      // Ignore malformed endpoints rather than failing every request.
    }
  }
  overrideUpstreams = parsed.length > 0 ? parsed : null;
  return overrideUpstreams ?? undefined;
}

/**
 * Failover order for the primary endpoint. By default the first choice changes
 * on a time slot (consistent across instances); with
 * HAGEZI_ROTATION_MODE=request it round-robins per request to spread load. A
 * valid HAGEZI_UPSTREAM_ENDPOINTS override replaces the rotated built-in list.
 */
export function getHageziUpstreams(): readonly NormalizedDoHUpstream[] {
  const override = getOverrideUpstreams();
  if (override) return override;
  const { seconds, perRequest } = getRotationConfig();
  const count = ROTATED_HAGEZI_UPSTREAMS.length;
  const slot = perRequest
    ? state.rotationCounter++ % count
    : Math.floor(Date.now() / (seconds * 1_000)) % count;
  return ROTATED_HAGEZI_UPSTREAMS[slot];
}

function getProviderUpstream(providerId: string): NormalizedDoHUpstream | undefined {
  return NORMALIZED_PROVIDER_UPSTREAMS.get(providerId);
}

function baseHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Cache-Control",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store, max-age=0",
  });
}

function textResponse(message: string, status: number): NextResponse {
  const headers = baseHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new NextResponse(message, { status, headers });
}

function emptyResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: baseHeaders() });
}

function busyResponse(): NextResponse {
  const response = textResponse("DNS proxy busy", 503);
  response.headers.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
  return response;
}

function tryAcquireInFlight(ip: string | undefined): boolean {
  if (state.inFlight >= MAX_IN_FLIGHT_REQUESTS) return false;
  if (ip !== undefined) {
    const current = state.inFlightByIp.get(ip) ?? 0;
    if (current >= MAX_IN_FLIGHT_PER_IP) return false;
    state.inFlightByIp.set(ip, current + 1);
  }
  state.inFlight += 1;
  return true;
}

function releaseInFlight(ip: string | undefined): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (ip === undefined) return;
  const current = state.inFlightByIp.get(ip) ?? 0;
  if (current <= 1) state.inFlightByIp.delete(ip);
  else state.inFlightByIp.set(ip, current - 1);
}

function getEarlyMethodResponse(request: NextRequest): NextResponse | null {
  // RFC 9110: a 204 response must not include Content-Length.
  if (request.method === "OPTIONS" || request.method === "HEAD") return emptyResponse();

  if (request.method !== "GET" && request.method !== "POST") {
    const result = textResponse("Method Not Allowed", 405);
    result.headers.set("Allow", "GET, POST, HEAD, OPTIONS");
    return result;
  }

  return null;
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

function decodeBase64Url(value: string): ValidatedQuery | null {
  if (!value || value.length > MAX_ENCODED_QUERY_LENGTH + 2 || !BASE64URL.test(value)) return null;
  const unpadded = stripPadding(value);
  if (!unpadded || unpadded.length > MAX_ENCODED_QUERY_LENGTH || unpadded.length % 4 === 1) return null;

  const body = Buffer.from(unpadded, "base64url");
  if (body.byteLength > MAX_DNS_MESSAGE_SIZE) return null;

  const parsed = parseQuery(body);
  return parsed === null ? null : { body, parsed };
}

function validateGet(url: URL): { readonly dnsParam: string; readonly query: ValidatedQuery } | NextResponse {
  if (url.search.length > MAX_QUERY_STRING_LENGTH) return textResponse("Query string too long", 414);

  const dnsValues = url.searchParams.getAll("dns");
  if (dnsValues.length !== 1) return textResponse("Invalid DNS message", 400);

  const query = decodeBase64Url(dnsValues[0]);
  if (query === null) return textResponse("Invalid DNS message", 400);

  // Forward the canonical unpadded form to the upstream.
  return { dnsParam: stripPadding(dnsValues[0]), query };
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

  const body = chunks.length === 1 ? chunks[0] : concatChunks(chunks, total);
  const parsed = parseQuery(body);
  if (parsed === null) return textResponse("Invalid DNS message", 400);
  return { body, parsed };
}

async function readResponseBody(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isInteger(size) || size > MAX_DNS_RESPONSE_SIZE) {
      cancelResponseBody(response);
      return null;
    }
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Keep the lock while a best-effort cancel may still be settling (see
  // readPostBody); only a fully settled stream may have its lock released.
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

function cancelResponseBody(response: Response): void {
  if (response.body) void cancelBestEffort(response.body);
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
  // `dnsParam` already passed the base64url check, so it needs no encoding.
  const url = isGet ? `${upstream.endpoint}?dns=${dnsParam}` : upstream.url;

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

/** Max-age (seconds, capped) to relay from an upstream Cache-Control, or 0. */
function relayedMaxAge(cacheControl: string | null): number {
  if (!cacheControl || /(?:^|[\s,])(?:no-store|no-cache)(?:$|[\s,=])/i.test(cacheControl)) return 0;
  const match = /(?:^|[\s,])max-age=(\d{1,9})(?:$|[\s,])/i.exec(cacheControl);
  return match ? Math.min(Number(match[1]), MAX_RELAYED_MAX_AGE_SECONDS) : 0;
}

export async function proxyRequest(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  const earlyResponse = getEarlyMethodResponse(request);
  if (earlyResponse) return earlyResponse;
  const clientIp = getClientIp(request.headers, isProxyTrustEnabled());
  if (!tryAcquireInFlight(clientIp)) return busyResponse();

  try {
    return await proxyRequestInternal(request, options);
  } finally {
    releaseInFlight(clientIp);
  }
}

async function proxyRequestInternal(request: NextRequest, options: DoHOptions): Promise<NextResponse> {
  let query: ValidatedQuery;
  let dnsParam: string | undefined;
  const timeout = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  if (request.method === "GET") {
    const validation = validateGet(new URL(request.url));
    if (validation instanceof NextResponse) return validation;
    dnsParam = validation.dnsParam;
    query = validation.query;
  } else {
    const bodyResult = await readPostBody(request, Math.min(deadline, startedAt + MAX_BODY_READ_MS));
    if (bodyResult instanceof NextResponse) return bodyResult;
    query = bodyResult;
  }

  const failover = options.failover !== false;
  const configured = typeof options.upstreams === "function" ? options.upstreams() : options.upstreams;
  // Provider routes try exactly one upstream, so only that one is normalized.
  let upstreams = (failover ? configured : configured.slice(0, 1)).map(normalizeUpstream);

  // Skip upstreams whose breaker is open, but never fail fast when *all* of
  // them are open: a probe request is what lets a recovered upstream close its
  // breaker sooner, and a dead-looking upstream may still answer.
  const healthy = upstreams.filter((upstream) => !isCircuitBreakerOpen(upstream.endpoint));
  const probeAll = healthy.length === 0;
  if (!probeAll) upstreams = healthy;

  // Last definite upstream rejection (non-200 status) seen across attempts. A
  // later timeout or invalid body does not erase it; it is relayed only if no
  // upstream ends up answering.
  let lastRejectedStatus: number | undefined;

  for (let index = 0; index < upstreams.length; index += 1) {
    const upstream = upstreams[index];
    // An earlier attempt may have taken a while, and another request may have
    // claimed this upstream's half-open probe in the meantime.
    if (!probeAll && isCircuitBreakerOpen(upstream.endpoint)) continue;
    // Share what is left of the budget across the attempts still to come, so
    // time saved by fast failures flows to later upstreams (the last one gets
    // everything that remains).
    const remaining = deadline - Date.now();
    const share = failover
      ? Math.max(MIN_FAILOVER_SLICE_MS, Math.floor(remaining / (upstreams.length - index)))
      : remaining;
    const attemptTimeout = Math.min(remaining, share);
    if (attemptTimeout < MIN_ATTEMPT_TIMEOUT_MS) break;

    claimProbe(upstream.endpoint);
    try {
      const upstreamFetch = await fetchUpstream(
        request,
        dnsParam,
        upstream,
        request.method === "POST" ? query.body : undefined,
        attemptTimeout,
      );
      const result = upstreamFetch.response;

      try {
        // Only retryable availability problems (timeouts, network errors and
        // retryable upstream statuses) count toward the breaker. Client-influenced
        // outcomes (upstream 4xx, oversized or otherwise rejected responses) must
        // not let one caller take an upstream offline for everybody. Retryable
        // statuses are not retained for relay: if every upstream fails that way
        // the client gets a generic 502.
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

        // readResponseBody cancels the stream itself on its early-exit paths.
        const responseBody = await readResponseBody(result);
        if (responseBody === null || !isValidDnsResponse(responseBody, query.parsed)) continue;

        recordSuccess(upstream.endpoint);

        const headers = baseHeaders();
        headers.set("Content-Type", DNS_MESSAGE);
        headers.set("Content-Length", String(responseBody.byteLength));
        if (request.method === "GET") {
          const maxAge = relayedMaxAge(result.headers.get("cache-control"));
          if (maxAge > 0) headers.set("Cache-Control", `private, max-age=${maxAge}`);
        }
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
    failover: true,
  });
}
