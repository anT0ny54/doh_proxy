import CopyButton from "@/components/CopyButton";

const SITE_URL = "https://freedns-six.vercel.app";
const PUBLIC_DOH_ENDPOINT = `${SITE_URL}/api/doh/dns-query`;
const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

const PROVIDER_ENDPOINTS = [
  ["Google", `${SITE_URL}/api/doh/google/dns-query`, "Google Public DNS"],
  ["Cloudflare", `${SITE_URL}/api/doh/cloudflare/dns-query`, "Cloudflare Public DNS"],
  ["AdGuard", `${SITE_URL}/api/doh/adguard/dns-query`, "AdGuard Public DNS"],
  ["DNS.SB", `${SITE_URL}/api/doh/dnssb/dns-query`, "DNS.SB Public DNS"],
] as const;

export default function Home() {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="mx-auto max-w-3xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">FreeDNS</p>
          <h1 className="text-4xl font-extrabold tracking-tight text-zinc-900 sm:text-5xl">Fast DNS-over-HTTPS</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg">
            A lightweight public DoH proxy using HaGeZi&apos;s balanced-protection DNS servers, with deterministic rotation, sequential failover, strict RFC 8484 validation, and no intentional DNS-response caching.
          </p>
        </header>

        <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="endpoint-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 id="endpoint-title" className="text-sm font-semibold text-zinc-900">Recommended FreeDNS endpoint</h2>
              <code className="mt-2 block break-all rounded-xl bg-zinc-100 px-3 py-3 text-sm text-zinc-700 select-all">{PUBLIC_DOH_ENDPOINT}</code>
            </div>
            <CopyButton value={PUBLIC_DOH_ENDPOINT} />
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            RFC 8484 GET (<code>?dns=</code>) and POST (<code>application/dns-message</code>) are supported. The selected HaGeZi upstream is hidden from clients.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="providers-title">
          <div className="mb-4">
            <h2 id="providers-title" className="text-xl font-semibold text-zinc-900">Built-in DNS endpoints</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">Fixed upstreams for direct provider testing through the same proxy. No custom upstream URL is accepted.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {PROVIDER_ENDPOINTS.map(([name, endpoint, description]) => (
              <article key={endpoint} className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-zinc-900">{name}</h3>
                    <p className="mt-1 text-sm text-zinc-500">{description}</p>
                  </div>
                  <CopyButton value={endpoint} />
                </div>
                <code className="mt-4 block break-all rounded-xl bg-zinc-100 px-3 py-3 text-xs text-zinc-700">{endpoint}</code>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10" aria-labelledby="protection-title">
          <div className="mb-4">
            <h2 id="protection-title" className="text-xl font-semibold text-zinc-900">HaGeZi protection &amp; routing</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">The primary endpoint uses three EU HaGeZi resolvers. The proxy rotates the primary server and falls back sequentially without exposing the upstream URL.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FeatureCard title="Falkenstein, Germany" description="root.hagezi.org · balanced protection with Multi Pro + Threat Intelligence Feed." />
            <FeatureCard title="Nuremberg, Germany" description="wurzn.hagezi.org · balanced protection with Multi Pro + Threat Intelligence Feed." />
            <FeatureCard title="Helsinki, Finland" description="juuri.hagezi.org · balanced protection with Multi Pro + Threat Intelligence Feed." />
          </div>
        </section>

        <section className="mt-6 grid gap-4 sm:grid-cols-2" aria-label="Service features">
          <FeatureCard title="Fast failover" description="Only one upstream is active at a time, then the proxy advances to the next server inside a bounded request budget." />
          <FeatureCard title="No custom proxying" description="Only fixed provider destinations are compiled into the service, reducing SSRF and arbitrary-forwarding risk." />
        </section>

        <section className="mt-10 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="usage-title">
          <h2 id="usage-title" className="text-lg font-semibold text-zinc-900">How to use it</h2>
          <div className="mt-4 grid gap-4 text-sm text-zinc-600 sm:grid-cols-3">
            <Step number="1" text="Set your device, browser, router, or DNS client to the recommended FreeDNS DoH URL." />
            <Step number="2" text="Use standard RFC 8484 GET with dns= or POST with application/dns-message." />
            <Step number="3" text="For public deployments, add a platform-level firewall/rate-limit rule for the DoH paths." />
          </div>
        </section>

        <footer className="mt-12 pb-4 text-center text-sm text-zinc-400">
          <p>© {new Date().getFullYear()} <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-zinc-300 underline-offset-4 hover:text-zinc-700">FreeDNS / DoH Proxy</a> · Open source under AGPL-3.0</p>
        </footer>
      </div>
    </main>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"><h3 className="font-semibold text-zinc-900">{title}</h3><p className="mt-2 text-sm leading-6 text-zinc-600">{description}</p></article>;
}

function Step({ number, text }: { number: string; text: string }) {
  return <div className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span><p className="leading-6">{text}</p></div>;
}
