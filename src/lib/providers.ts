export interface DoHProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
}

/** Fixed server-owned upstreams. No arbitrary/custom forwarding is supported. */
export const DOH_PROVIDERS: readonly DoHProvider[] = [
  {
    id: "google",
    name: "Google",
    description: "Google Public DNS",
    endpoint: "https://dns.google/dns-query",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare 1.1.1.1 Public DNS",
    endpoint: "https://cloudflare-dns.com/dns-query",
  },
  {
    id: "adguard",
    name: "AdGuard",
    description: "AdGuard Public DNS",
    endpoint: "https://dns.adguard-dns.com/dns-query",
  },
  {
    id: "dnssb",
    name: "DNS.SB",
    description: "DNS.SB Public DNS",
    endpoint: "https://dns.sb/dns-query",
  },
] as const;

const PROVIDER_MAP = new Map(DOH_PROVIDERS.map((provider) => [provider.id, provider]));

export function getProvider(id: string): DoHProvider | undefined {
  return PROVIDER_MAP.get(id);
}
