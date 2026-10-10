import { isIP } from "node:net";

const MAX_HEADER_ENTRY_LENGTH = 128;

/**
 * Process environment variable that opts in to trusting forwarding headers.
 * Set it to a truthy value ("1", "true", "yes", "on") ONLY when a reverse
 * proxy in front of this app overwrites/sanitizes X-Real-IP and
 * X-Forwarded-For on every request.
 */
export const TRUST_PROXY_HEADERS_ENV = "TRUST_PROXY_HEADERS";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/** Expands an IPv6 literal into eight 16-bit groups, or null if malformed. */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * Turns a forwarded-address header value into a rate-limit key, or undefined
 * when it is not a valid IP. Ports, brackets and zone IDs are stripped,
 * IPv4-mapped IPv6 addresses collapse to IPv4, and IPv6 addresses are keyed by
 * their /64 so a single subscriber cannot rotate through addresses to dodge a
 * per-client limit.
 */
export function normalizeIp(raw: string): string | undefined {
  let value = raw.trim().slice(0, MAX_HEADER_ENTRY_LENGTH);
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return undefined;
    value = value.slice(1, close);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);

  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;

  const groups = expandIpv6(value);
  if (groups === null) return undefined;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * Whether X-Real-IP / X-Forwarded-For may be used for client identity.
 *
 * These headers are only trustworthy when a sanitizing reverse proxy in front
 * of this app overwrites them on every request. A directly connected client
 * can otherwise forge arbitrary values and rotate them to evade the per-IP
 * request limiter and the per-IP in-flight limit. Trust is therefore opt-in
 * via TRUST_PROXY_HEADERS and must stay unset when the app is exposed
 * directly. Evaluated per call (no module-level cache) so tests and runtime
 * configuration changes are honored.
 */
export function isProxyTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY_VALUES.has((env[TRUST_PROXY_HEADERS_ENV] ?? "").trim().toLowerCase());
}

/**
 * Best-effort client identity from headers added by a trusted reverse proxy.
 * Returns undefined when no usable address is present OR when forwarding
 * headers are not trusted (see {@link isProxyTrustEnabled}): a spoofed value
 * must never be allowed to mint a rate-limit identity.
 */
export function getClientIp(headers: Headers, trusted: boolean = isProxyTrustEnabled()): string | undefined {
  if (!trusted) return undefined;

  // X-Real-IP carries a single address, so there is no client-controlled list.
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const normalized = normalizeIp(realIp);
    if (normalized !== undefined) return normalized;
  }

  // Each proxy appends to X-Forwarded-For, so the LAST entry is the one added
  // by the sanitizing proxy in front of this app; earlier entries are spoofable.
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",");
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].trim()) return normalizeIp(entries[i]);
    }
  }

  return undefined;
}
