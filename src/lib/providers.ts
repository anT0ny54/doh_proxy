export interface DoHProvider {
  id: string;
  name: string;
  description: string;
  /**
   * Upstream endpoints exposed under /api/doh/<id>/<segment>.
   *
   * - The 'default' key serves /api/doh/<id> (no segment). The web tester
   *   issues JSON queries against it, so it must point at a JSON-capable
   *   endpoint.
   * - Other keys (e.g. 'resolve', 'dns-query') expose format-specific
   *   upstreams, e.g. /api/doh/google/dns-query.
   *
   */
  paths: Record<string, string>;
}

export const DOH_PROVIDERS: DoHProvider[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Cloudflare Public DNS (1.1.1.1)',
    // Cloudflare serves both JSON and RFC 8484 wire format at /dns-query.
    paths: {
      default: 'https://cloudflare-dns.com/dns-query',
      'dns-query': 'https://cloudflare-dns.com/dns-query',
    },
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Google Public DNS (8.8.8.8)',
    // Google splits the formats: /resolve is JSON, /dns-query is wire format.
    paths: {
      default: 'https://dns.google/resolve',
      resolve: 'https://dns.google/resolve',
      'dns-query': 'https://dns.google/dns-query',
    },
  },
  {
    id: 'adguard',
    name: 'AdGuard',
    description: 'AdGuard Home DNS (94.140.14.14)',
    paths: {
      default: 'https://dns.adguard-dns.com/resolve',
      resolve: 'https://dns.adguard-dns.com/resolve',
      'dns-query': 'https://dns.adguard-dns.com/dns-query',
    },
  },
  {
    id: 'dnssb',
    name: 'DNS.SB',
    description: 'DNS.SB (45.11.45.11)',
    paths: {
      default: 'https://dns.sb/dns-query',
      'dns-query': 'https://dns.sb/dns-query',
    },
  },

];

export function getProvider(id: string): DoHProvider | undefined {
  return DOH_PROVIDERS.find((p) => p.id === id);
}

/**
 * Resolve the upstream URL for a built-in provider given the optional
 * path segment from /api/doh/<id>/<segment>.
 *
 * Returns undefined when the segment is not a known endpoint for this
 * provider, which keeps the proxy from forwarding arbitrary paths.
 */
export function resolveProviderEndpoint(
  provider: DoHProvider,
  segment?: string
): string | undefined {
  return provider.paths[segment || 'default'];
}
