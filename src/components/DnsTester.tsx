"use client";

import { useState } from "react";
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
const JSON_PROVIDERS = DOH_PROVIDERS.filter((provider) => provider.paths.resolve);

export default function DnsTester() {
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const [type, setType] = useState<(typeof RECORD_TYPES)[number]>("A");
  const [providerId, setProviderId] = useState(JSON_PROVIDERS[0]?.id ?? "cloudflare");
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

    setLoading(true);
    setResult(null);
    setError(null);

    const params = new URLSearchParams({ name: trimmedDomain, type });
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`/api/doh/${encodeURIComponent(providerId)}?${params.toString()}`, {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
        cache: "no-store",
      });

      const message = await res.text();
      if (!res.ok) {
        throw new Error(message || `Error: ${res.status} ${res.statusText}`);
      }

      try {
        setResult(JSON.parse(message) as DnsResponse);
      } catch {
        throw new Error("The upstream returned an invalid JSON response.");
      }
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
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 md:p-8">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-semibold text-zinc-900">DNS Tester</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Compare DNS JSON responses from the supported public resolvers, including DNS.SB.
        </p>
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
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-2.5 shadow-sm outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-300"
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
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-2.5 shadow-sm outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-300"
            >
              {RECORD_TYPES.map((recordType) => (
                <option key={recordType} value={recordType}>{recordType}</option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-zinc-700">Upstream Provider</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {JSON_PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                type="button"
                aria-pressed={providerId === provider.id}
                onClick={() => setProviderId(provider.id)}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  providerId === provider.id
                    ? "border-zinc-700 bg-zinc-900 text-white shadow-sm"
                    : "border-zinc-300 bg-white text-zinc-600 shadow-sm hover:bg-zinc-50 hover:text-zinc-900"
                }`}
              >
                {provider.name}
              </button>
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={loading}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 py-3 font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
              <span>Resolving...</span>
            </>
          ) : (
            <span>Resolve DNS</span>
          )}
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="mb-1 font-medium">Resolution Failed</p>
          <p className="opacity-90">{error}</p>
        </div>
      )}

      {result && (
        <div className="mt-8 space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-medium text-zinc-700">Response</h3>
            <span className={`rounded-full border px-3 py-1 text-xs font-mono ${
              result.Status === 0
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}>
              Status: {result.Status}
            </span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#111111] p-4 shadow-inner">
            <pre className="text-[13px] leading-relaxed text-zinc-300">{JSON.stringify(result, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
