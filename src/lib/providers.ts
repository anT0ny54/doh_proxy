export interface DoHProvider {
  id: string;
  name: string;
  description: string;
  endpoint: string;
}

/**
 * Fixed, server-owned upstreams. There is deliberately no custom/manual URL
 * input, so the proxy cannot be turned into an arbitrary URL forwarder.
 */
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

export function getProvider(id: string): DoHProvider | undefined {
  return DOH_PROVIDERS.find((provider) => provider.id === id);
}
