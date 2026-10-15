/** Fields shared by every compiled-in, server-owned DoH upstream. */
export interface FixedUpstream {
  readonly endpoint: string;
  readonly description: string;
}

export interface DoHUpstream extends FixedUpstream {
  /** Derived from `endpoint`, so the two can never drift apart. */
  readonly hostname: string;
  readonly location: string;
}

const BALANCED = "Balanced protection with Multi Pro + Threat Intelligence Feed.";

/** Server-owned HaGeZi upstreams. No arbitrary/custom forwarding is supported. */
export const HAGEZI_UPSTREAMS: readonly DoHUpstream[] = [
  { endpoint: "https://root.hagezi.org/dns-query", location: "Falkenstein, Germany", description: BALANCED },
  { endpoint: "https://wurzn.hagezi.org/dns-query", location: "Nuremberg, Germany", description: BALANCED },
  { endpoint: "https://juuri.hagezi.org/dns-query", location: "Helsinki, Finland", description: BALANCED },
].map((upstream) => Object.freeze({ ...upstream, hostname: new URL(upstream.endpoint).hostname }));
