/**
 * Runtime configuration, parsed ONCE when the module loads. Every setting is
 * read the same way (no per-request `process.env` lookups); restart the
 * process to apply a change.
 */

/** Request header through which `src/proxy.ts` hands the client key to the route. */
export const CLIENT_KEY_HEADER = "x-doh-client-key";
/**
 * Header written by `server/socket-ip-preload.cjs` with the TCP peer address.
 * Keep in sync with that file (checked by scripts/test-config.mjs).
 */
export const SOCKET_IP_HEADER = "x-doh-socket-ip";
/** globalThis flag set by the preload; the socket header is ignored without it. */
export const SOCKET_IP_PRELOAD_FLAG = "__dohSocketIpPreload";

const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
const DEFAULT_HAGEZI_ROTATION_SECONDS = 1_800;
const MIN_HAGEZI_ROTATION_SECONDS = 60;
const MAX_HAGEZI_ROTATION_SECONDS = 86_400;
const MAX_TRUSTED_PROXY_HOPS = 16;

/**
 * Default TRUSTED_PROXIES: forwarding headers are honored only when the TCP
 * peer is a loopback or private (RFC 1918 / RFC 4193) address, i.e. a reverse
 * proxy on the same host or network. A client connecting directly from the
 * internet can no longer mint identities with a forged X-Forwarded-For.
 */
const DEFAULT_TRUSTED_PROXIES: readonly string[] = Object.freeze(["loopback", "private"]);

export type Platform = "vercel" | "netlify" | "self-hosted";
export type RotationMode = "client" | "request" | "time";

/**
 * Header that the platform edge itself sets from the TCP peer (and overwrites
 * on every request), so a client cannot forge it. Self-hosted deployments use
 * the right-most X-Forwarded-For entry, which the nearest reverse proxy adds.
 */
const PLATFORM_CLIENT_IP_HEADERS: Readonly<Record<Platform, readonly string[]>> = {
  vercel: ["x-real-ip", "x-forwarded-for"],
  netlify: ["x-nf-client-connection-ip"],
  "self-hosted": ["x-forwarded-for"],
};

export interface ClientIpConfig {
  readonly trustProxyHeaders: boolean;
  readonly clientIpHeaders: readonly string[];
  readonly trustedProxyHops: number;
  /**
   * TCP peers whose forwarding headers are honored (only checked when the
   * socket-IP preload is loaded). Entries: IPs, CIDRs, `loopback`, `private`,
   * `linklocal`, `*` (any peer) or `none`.
   */
  readonly trustedProxies: readonly string[];
}

export interface ProxyConfig extends ClientIpConfig {
  readonly platform: Platform;
  readonly rateLimitPerMinute: number;
  readonly hageziRotationSeconds: number;
  readonly hageziRotationMode: RotationMode;
  readonly hageziUpstreamEndpoints: readonly string[];
}

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/** Unset/empty or "1"/"true"/"yes"/"on" enable trust; anything else disables it. */
export function parseTrust(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "" || TRUTHY_VALUES.has(normalized);
}

function parsePositiveInteger(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function parseRotationSeconds(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_HAGEZI_ROTATION_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HAGEZI_ROTATION_SECONDS;
  return Math.min(Math.max(parsed, MIN_HAGEZI_ROTATION_SECONDS), MAX_HAGEZI_ROTATION_SECONDS);
}

/** `time` and `request` select those modes; anything else is the `client` default. */
function parseRotationMode(value: string | undefined): RotationMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "time" || normalized === "request" ? normalized : "client";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Valid http(s) entries of HAGEZI_UPSTREAM_ENDPOINTS; malformed ones are dropped. */
function parseUpstreamEndpoints(value: string | undefined): string[] {
  return parseList(value).filter((endpoint) => {
    try {
      const { protocol } = new URL(endpoint);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  });
}

/** TRUSTED_PROXIES entries, lower-cased; unset or empty selects the default. */
function parseTrustedProxies(value: string | undefined): readonly string[] {
  const entries = parseList(value).map((entry) => entry.toLowerCase());
  return entries.length > 0 ? Object.freeze(entries) : DEFAULT_TRUSTED_PROXIES;
}

function detectPlatform(env: NodeJS.ProcessEnv, buildPlatform?: string): Platform {
  // Next.js replaces direct `process.env.DOH_BUILD_PLATFORM` references at
  // build time; it cannot replace access through the `env` parameter above.
  // The fallback is supplied only when using the process environment itself.
  const platform = buildPlatform ?? env.DOH_BUILD_PLATFORM;
  return platform === "vercel" || platform === "netlify" ? platform : "self-hosted";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  // Keep explicit env objects isolated, but preserve Next.js's build-time
  // substitution for the normal loadConfig() call that initializes CONFIG.
  const buildPlatform = env === process.env ? process.env.DOH_BUILD_PLATFORM : undefined;
  const platform = detectPlatform(env, buildPlatform);
  const headers = parseList(env.CLIENT_IP_HEADERS).map((name) => name.toLowerCase());
  return Object.freeze({
    platform,
    trustProxyHeaders: parseTrust(env.TRUST_PROXY_HEADERS),
    clientIpHeaders: Object.freeze(headers.length > 0 ? headers : [...PLATFORM_CLIENT_IP_HEADERS[platform]]),
    trustedProxyHops: parsePositiveInteger(env.TRUSTED_PROXY_HOPS, 1, MAX_TRUSTED_PROXY_HOPS),
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES),
    rateLimitPerMinute: parsePositiveInteger(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE),
    hageziRotationSeconds: parseRotationSeconds(env.HAGEZI_ROTATION_SECONDS),
    hageziRotationMode: parseRotationMode(env.HAGEZI_ROTATION_MODE),
    hageziUpstreamEndpoints: Object.freeze(parseUpstreamEndpoints(env.HAGEZI_UPSTREAM_ENDPOINTS)),
  });
}

export const CONFIG: ProxyConfig = loadConfig();
