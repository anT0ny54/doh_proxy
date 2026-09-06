"use client";

import { useState } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { DOH_PROVIDERS } from "@/lib/providers";

interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DnsResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: { name: string; type: number }[];
  Answer?: DnsAnswer[];
  Authority?: DnsAnswer[];
  Additional?: DnsAnswer[];
  Comment?: string;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "PTR", "SOA"] as const;
const DEFAULT_DOMAIN = "google.com";
const REQUEST_TIMEOUT_MS = 5_000;

export default function DnsTester() {
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const [type, setType] = useState<(typeof RECORD_TYPES)[number]>("A");
  const [providerId, setProviderId] = useState(DOH_PROVIDERS[0]?.id ?? "cloudflare");
  const [manualUrl, setManualUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DnsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    const trimmedDomain = domain.trim();
    if (!trimmedDomain) {
      setError("Please enter a domain name.");
      return;
    }

    if (providerId === "manual" && !manualUrl.trim()) {
      setError("Please enter a valid DoH URL.");
      return;
    }

    setLoading(true);
    setResult(null);
    setError(null);

    const params = new URLSearchParams({ name: trimmedDomain, type });
    if (providerId === "manual") params.set("upstream", manualUrl.trim());

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`/api/doh/${encodeURIComponent(providerId)}?${params}`, {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
      });

      if (!res.ok) {
        const message = await res.text().catch(() => "");
        throw new Error(message || `Error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as DnsResponse;
      setResult(data);
    } catch (caught: unknown) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError("The DNS request timed out.");
      } else {
        setError(caught instanceof Error ? caught.message : "Failed to resolve DNS.");
      }
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto rounded-3xl border border-zinc-200/80 bg-white/60 p-6 shadow-sm backdrop-blur-md md:p-10">
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-semibold text-zinc-900">DNS Tester</h2>
        <p className="mt-2 text-sm text-zinc-500">Resolve a record through the selected DoH upstream.</p>
      </div>

      <form onSubmit={handleTest} className="space-y-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="dns-domain" className="text-sm font-medium text-zinc-700">Domain Name</label>
            <input
              id="dns-domain"
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="w-full rounded-xl border border-white/50 bg-white/40 px-4 py-2.5 shadow-sm outline-none backdrop-blur-sm transition-all focus:border-transparent focus:ring-2 focus:ring-zinc-400"
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="dns-type" className="text-sm font-medium text-zinc-700">Record Type</label>
            <select
              id="dns-type"
              value={type}
              onChange={(event) => setType(event.target.value as (typeof RECORD_TYPES)[number])}
              className="w-full rounded-xl border border-white/50 bg-white/40 px-4 py-2.5 shadow-sm outline-none backdrop-blur-sm transition-all focus:border-transparent focus:ring-2 focus:ring-zinc-400"
            >
              {RECORD_TYPES.map((recordType) => <option key={recordType} value={recordType}>{recordType}</option>)}
            </select>
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-zinc-700">Upstream Provider</legend>
          <div className="flex flex-wrap gap-2">
            {DOH_PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                type="button"
                aria-pressed={providerId === provider.id}
                onClick={() => setProviderId(provider.id)}
                className={clsx(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-all backdrop-blur-md",
                  providerId === provider.id
                    ? "border-zinc-700/50 bg-zinc-900/80 text-white shadow-md"
                    : "border-white/50 bg-white/40 text-zinc-600 shadow-sm hover:bg-white/60 hover:text-zinc-900",
                )}
              >
                {provider.name}
              </button>
            ))}
          </div>
        </fieldset>

        {providerId === "manual" && (
          <div className="space-y-2">
            <label htmlFor="manual-doh-url" className="text-sm font-medium text-zinc-700">Custom DoH URL</label>
            <input
              id="manual-doh-url"
              type="url"
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              className="w-full rounded-xl border border-white/50 bg-white/40 px-4 py-2.5 shadow-sm outline-none backdrop-blur-sm transition-all focus:border-transparent focus:ring-2 focus:ring-zinc-400"
              placeholder="https://example.com/dns-query"
              autoComplete="url"
              required
            />
            <p className="text-xs text-zinc-500">The proxy validates the URL before forwarding the request.</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700/50 bg-zinc-900/80 py-3 font-medium text-white shadow-md backdrop-blur-md transition-all hover:bg-zinc-800/90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /><span>Resolving...</span></> : <span>Resolve DNS</span>}
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-8 rounded-xl border border-red-100 bg-red-50/50 p-4 text-sm text-red-600">
          <p className="mb-1 font-medium">Resolution Failed</p>
          <p className="opacity-90">{error}</p>
        </div>
      )}

      {result && (
        <div className="mt-8 space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-medium text-zinc-700">Response</h3>
            <span className={clsx(
              "rounded-full border px-3 py-1 text-xs font-mono",
              result.Status === 0
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700",
            )}>Status: {result.Status}</span>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-[#111111] p-5 shadow-inner">
            <pre className="text-[13px] leading-relaxed text-zinc-300">{JSON.stringify(result, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
