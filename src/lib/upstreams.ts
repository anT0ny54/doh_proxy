export interface DoHUpstream {
  readonly endpoint: string;
  readonly hostname: string;
  readonly location: string;
  readonly description: string;
}

/** Server-owned HaGeZi upstreams. No arbitrary/custom forwarding is supported. */
export const HAGEZI_UPSTREAMS: readonly DoHUpstream[] = [
  {
    endpoint: "https://root.hagezi.org/dns-query",
    hostname: "root.hagezi.org",
    location: "Falkenstein, Germany",
    description: "Balanced protection with Multi Pro + Threat Intelligence Feed.",
  },
  {
    endpoint: "https://wurzn.hagezi.org/dns-query",
    hostname: "wurzn.hagezi.org",
    location: "Nuremberg, Germany",
    description: "Balanced protection with Multi Pro + Threat Intelligence Feed.",
  },
  {
    endpoint: "https://juuri.hagezi.org/dns-query",
    hostname: "juuri.hagezi.org",
    location: "Helsinki, Finland",
    description: "Balanced protection with Multi Pro + Threat Intelligence Feed.",
  },
] as const;
