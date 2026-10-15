import { BlockList, isIP } from "node:net";
import { CONFIG, SOCKET_IP_HEADER, SOCKET_IP_PRELOAD_FLAG, type ClientIpConfig } from "@/lib/config";

const MAX_HEADER_ENTRY_LENGTH = 128;

/** A validated address: IPv4-mapped IPv6 is already collapsed to IPv4. */
interface CanonicalIp {
  readonly address: string;
  readonly family: 4 | 6;
  /** Eight 16-bit groups, IPv6 only. */
  readonly groups?: readonly number[];
}

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
 * Parses an address header value or socket address. Ports, brackets and zone
 * IDs are stripped and IPv4-mapped IPv6 addresses collapse to IPv4. Returns
 * undefined when the value is not a valid IP.
 */
function canonicalIp(raw: string): CanonicalIp | undefined {
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
  if (family === 4) return { address: value, family: 4 };
  if (family !== 6) return undefined;

  const groups = expandIpv6(value);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { address: `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`, family: 4 };
  }
  return { address: value, family: 6, groups };
}

/** Rate-limit key for a canonical address: IPv4 as is, IPv6 by its /64. */
function keyOf(ip: CanonicalIp): string {
  if (ip.family === 4 || !ip.groups) return ip.address;
  return `${ip.groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * Turns an address header value into a rate-limit key, or undefined when it is
 * not a valid IP. Ports, brackets and zone IDs are stripped, IPv4-mapped IPv6
 * addresses collapse to IPv4, and IPv6 addresses are keyed by their /64 so a
 * single subscriber cannot rotate through addresses to dodge the limit.
 */
export function normalizeIp(raw: string): string | undefined {
  const ip = canonicalIp(raw);
  return ip === undefined ? undefined : keyOf(ip);
}

type Subnet = readonly [address: string, prefix: number, family: "ipv4" | "ipv6"];

const NAMED_RANGES: Readonly<Record<string, readonly Subnet[]>> = {
  loopback: [
    ["127.0.0.0", 8, "ipv4"],
    ["::1", 128, "ipv6"],
  ],
  private: [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["fc00::", 7, "ipv6"],
  ],
  linklocal: [
    ["169.254.0.0", 16, "ipv4"],
    ["fe80::", 10, "ipv6"],
  ],
};

/** Compiled TRUSTED_PROXIES: `true` = any peer, otherwise a BlockList. */
type TrustedProxyMatcher = true | BlockList;

/** Compiles TRUSTED_PROXIES entries; invalid entries are ignored. */
function compileTrustedProxies(entries: readonly string[]): TrustedProxyMatcher {
  const list = new BlockList();
  for (const entry of entries) {
    if (entry === "*") return true;
    if (entry === "none") continue;
    const named = NAMED_RANGES[entry];
    if (named) {
      for (const [address, prefix, family] of named) list.addSubnet(address, prefix, family);
      continue;
    }
    const slash = entry.lastIndexOf("/");
    const ip = canonicalIp(slash === -1 ? entry : entry.slice(0, slash));
    if (!ip) continue;
    const max = ip.family === 4 ? 32 : 128;
    const prefix = slash === -1 ? max : Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) continue;
    list.addSubnet(ip.address, prefix, ip.family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

// Matchers are compiled once per configuration object (CONFIG in production).
const matchers = new WeakMap<ClientIpConfig, TrustedProxyMatcher>();

function isTrustedProxy(peer: CanonicalIp, config: ClientIpConfig): boolean {
  let matcher = matchers.get(config);
  if (matcher === undefined) {
    matcher = compileTrustedProxies(config.trustedProxies);
    matchers.set(config, matcher);
  }
  return matcher === true || matcher.check(peer.address, peer.family === 4 ? "ipv4" : "ipv6");
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
function socketPeer(headers: Headers): CanonicalIp | undefined {
  if ((globalThis as Record<string, unknown>)[SOCKET_IP_PRELOAD_FLAG] !== true) return undefined;
  const value = headers.get(SOCKET_IP_HEADER);
  return value ? canonicalIp(value) : undefined;
}

/**
 * Client identity used for rate limiting and the per-client in-flight cap.
 *
 * - TRUST_PROXY_HEADERS enabled (default): the configured forwarding headers
 *   (CLIENT_IP_HEADERS, platform default otherwise) are tried in order; for
 *   X-Forwarded-For the entry TRUSTED_PROXY_HOPS from the right is used. When
 *   the socket address is known (preload loaded), the headers are honored
 *   only if that TCP peer matches TRUSTED_PROXIES; otherwise the peer itself
 *   is the client. If no header yields an address, the socket address is used.
 * - TRUST_PROXY_HEADERS disabled: forwarding headers are ignored and only the
 *   socket address is used.
 *
 * Returns undefined only when no address is available at all.
 */
export function getClientIp(headers: Headers, config: ClientIpConfig = CONFIG): string | undefined {
  const peer = socketPeer(headers);
  if (config.trustProxyHeaders && (peer === undefined || isTrustedProxy(peer, config))) {
    for (const name of config.clientIpHeaders) {
      const value = headers.get(name);
      if (!value) continue;
      const candidate = name === "x-forwarded-for" ? pickForwarded(value, config.trustedProxyHops) : value;
      const normalized = candidate === undefined ? undefined : normalizeIp(candidate);
      if (normalized !== undefined) return normalized;
    }
  }
  return peer === undefined ? undefined : keyOf(peer);
}
