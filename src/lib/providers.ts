export interface DoHProvider {
  id: string;
  name: string;
  description: string;
  /**
   * Supported upstream endpoints.
   *
   * "default" is used by the JSON diagnostic endpoint:
   *   /api/doh/<provider>
   *
   * "dns-query" is the RFC 8484 wire-format endpoint:
   *   /api/doh/<provider>/dns-query
   */
  paths: Record<string, string>;
  supportsJson: boolean;
}

export const DOH_PROVIDERS: DoHProvider[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare Public DNS (1.1.1.1)",
    supportsJson: true,
    paths: {
      // Cloudflare supports Google's DNS JSON schema on /dns-query.
      default: "https://cloudflare-dns.com/dns-query",
      "dns-query": "https://cloudflare-dns.com/dns-query",
    },
  },
  {
    id: "google",
    name: "Google",
    description: "Google Public DNS (8.8.8.8)",
    supportsJson: true,
    paths: {
      // Google JSON API is /resolve; RFC 8484 is /dns-query.
      default: "https://dns.google/resolve",
      resolve: "https://dns.google/resolve",
      "dns-query": "https://dns.google/dns-query",
    },
  },
  {
    id: "adguard",
    name: "AdGuard",
    description: "AdGuard Public DNS",
    supportsJson: true,
    paths: {
      // AdGuard provides a Google-compatible JSON API at /resolve.
      default: "https://dns.adguard-dns.com/resolve",
      resolve: "https://dns.adguard-dns.com/resolve",
      "dns-query": "https://dns.adguard-dns.com/dns-query",
    },
  },
  {
    id: "dnssb",
    name: "DNS.SB",
    description: "DNS.SB",
    supportsJson: false,
    paths: {
      default: "https://dns.sb/dns-query",
      "dns-query": "https://dns.sb/dns-query",
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
  return provider.paths[segment || "default"];
}
