export interface DoHProvider {
  id: "cloudflare" | "google" | "adguard" | "dnssb";
  name: string;
  description: string;
  paths: {
    default: string;
    resolve?: string;
    "dns-query": string;
  };
}

export const DOH_PROVIDERS: readonly DoHProvider[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare Public DNS (1.1.1.1)",
    paths: {
      default: "https://cloudflare-dns.com/dns-query",
      resolve: "https://cloudflare-dns.com/dns-query",
      "dns-query": "https://cloudflare-dns.com/dns-query",
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Google Public DNS (8.8.8.8)",
    paths: {
      default: "https://dns.google/resolve",
      resolve: "https://dns.google/resolve",
      "dns-query": "https://dns.google/dns-query",
    },
  },
  {
    id: "adguard",
    name: "AdGuard",
    description: "AdGuard DNS",
    paths: {
      default: "https://dns.adguard-dns.com/resolve",
      resolve: "https://dns.adguard-dns.com/resolve",
      "dns-query": "https://dns.adguard-dns.com/dns-query",
    },
  },
  {
    id: "dnssb",
    name: "DNS.SB",
    description: "DNS.SB",
    paths: {
      default: "https://doh.dns.sb/dns-query",
      resolve: "https://doh.dns.sb/dns-query",
      "dns-query": "https://doh.dns.sb/dns-query",
    },
  },
];

export function getProvider(id: string): DoHProvider | undefined {
  return DOH_PROVIDERS.find((provider) => provider.id === id);
}

export function resolveProviderEndpoint(
  provider: DoHProvider,
  segment?: string,
): string | undefined {
  if (!segment || segment === "default") return provider.paths.default;

  // Route params are plain strings at runtime. Narrow them before indexing
  // the strongly-typed provider path map. Unknown formats must not silently
  // fall back to another upstream.
  if (segment === "resolve") return provider.paths.resolve;
  if (segment === "dns-query") return provider.paths["dns-query"];

  return undefined;
}
