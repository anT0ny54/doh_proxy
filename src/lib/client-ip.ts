import { isIP } from "node:net";
import { CONFIG, SOCKET_IP_HEADER, SOCKET_IP_PRELOAD_FLAG, type ClientIpConfig } from "@/lib/config";

const MAX_HEADER_ENTRY_LENGTH = 128;

/** Expands an IPv6 literal that `isIP()` has already validated into eight groups. */
function expandIpv6(ip: string): number[] {
  let text = ip;
  if (text.includes(".")) {
    // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) -> two hex groups.
    const lastColon = text.lastIndexOf(":");
    const [a, b, c, d] = text.slice(lastColon + 1).split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const compressed = text.includes("::");
  const [headText, tailText = ""] = text.split("::");
  const head = headText ? headText.split(":") : [];
  const tail = compressed && tailText ? tailText.split(":") : [];
  const zeros = compressed ? 8 - head.length - tail.length : 0;
  return [...head, ...Array<string>(zeros).fill("0"), ...tail].map((group) => Number.parseInt(group, 16));
}

/**
 * Turns an address header value into a rate-limit key, or undefined when it is
 * not a valid IP. Ports, brackets and zone IDs are stripped, IPv4-mapped IPv6
 * addresses collapse to IPv4, and IPv6 addresses are keyed by their /64 so a
 * single subscriber cannot rotate through addresses to dodge the limit.
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
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * The X-Forwarded-For entry added by the outermost of `hops` trusted proxies:
 * each proxy appends the peer it saw, so the address `hops` positions from the
 * right is the first one a client could not have written itself.
 */
function pickForwarded(value: string, hops: number): string | undefined {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries[entries.length - hops];
}

/**
 * TCP peer address recorded by `server/socket-ip-preload.cjs`. The preload
 * overwrites the header on every request, so it cannot be forged; without the
 * preload (e.g. on Vercel/Netlify) the header is ignored entirely.
 */
function socketIp(headers: Headers): string | undefined {
  if ((globalThis as Record<string, unknown>)[SOCKET_IP_PRELOAD_FLAG] !== true) return undefined;
  const value = headers.get(SOCKET_IP_HEADER);
  return value ? normalizeIp(value) : undefined;
}

/**
 * Client identity used for rate limiting and the per-client in-flight cap.
 *
 * - TRUST_PROXY_HEADERS enabled (default): the configured forwarding headers
 *   (CLIENT_IP_HEADERS, platform default otherwise) are tried in order; for
 *   X-Forwarded-For the entry TRUSTED_PROXY_HOPS from the right is used. If
 *   none yields an address, the socket address is used.
 * - TRUST_PROXY_HEADERS disabled: forwarding headers are ignored and only the
 *   socket address is used.
 *
 * Returns undefined only when no address is available at all.
 */
export function getClientIp(headers: Headers, config: ClientIpConfig = CONFIG): string | undefined {
  if (config.trustProxyHeaders) {
    for (const name of config.clientIpHeaders) {
      const value = headers.get(name);
      if (!value) continue;
      const candidate = name === "x-forwarded-for" ? pickForwarded(value, config.trustedProxyHops) : value;
      const normalized = candidate === undefined ? undefined : normalizeIp(candidate);
      if (normalized !== undefined) return normalized;
    }
  }
  return socketIp(headers);
}
