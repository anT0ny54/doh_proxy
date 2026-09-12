export type DoHProviderId = "cloudflare" | "google" | "adguard" | "dnssb";

export interface DoHProvider {
  id: DoHProviderId;
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
    description: "Cloudflare Public DNS (JSON and RFC 8484)",
    paths: {
      default: "https://cloudflare-dns.com/dns-query",
      resolve: "https://cloudflare-dns.com/dns-query",
      "dns-query": "https://cloudflare-dns.com/dns-query",
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Google Public DNS (JSON /resolve and RFC 8484)",
    paths: {
      default: "https://dns.google/resolve",
      resolve: "https://dns.google/resolve",
      "dns-query": "https://dns.google/dns-query",
    },
  },
  {
    id: "adguard",
    name: "AdGuard",
    description: "AdGuard DNS (JSON /resolve and RFC 8484)",
    paths: {
      default: "https://dns.adguard-dns.com/resolve",
      resolve: "https://dns.adguard-dns.com/resolve",
      "dns-query": "https://dns.adguard-dns.com/dns-query",
    },
  },
  {
    id: "dnssb",
    name: "DNS.SB",
    description: "DNS.SB RFC 8484 DoH; JSON is provided by this proxy adapter",
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
  if (segment === "resolve") return provider.paths.resolve;
  if (segment === "dns-query") return provider.paths["dns-query"];
  return undefined;
}
