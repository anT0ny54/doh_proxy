import DnsTester from "@/components/DnsTester";
import CopyButton from "@/components/CopyButton";

const PUBLIC_DOH_ENDPOINT = "https://freedns-six.vercel.app/api/doh/dns-query";
const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export default function Home() {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="mx-auto max-w-3xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">FreeDNS</p>
          <h1 className="text-4xl font-extrabold tracking-tight text-zinc-900 sm:text-5xl">
            Fast DNS-over-HTTPS
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg">
            A lightweight public DoH resolver using HaGeZi upstreams with automatic rotation,
            sequential failover, strict request validation, and layered abuse protection.
          </p>
        </header>

        <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="endpoint-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 id="endpoint-title" className="text-sm font-semibold text-zinc-900">Public DoH endpoint</h2>
              <code className="mt-2 block break-all rounded-xl bg-zinc-100 px-3 py-3 text-sm text-zinc-700 select-all">
                {PUBLIC_DOH_ENDPOINT}
              </code>
            </div>
            <CopyButton value={PUBLIC_DOH_ENDPOINT} />
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            RFC 8484 GET and POST are supported. The endpoint returns wire-format DNS responses and does not intentionally cache DNS answers.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="tester-title">
          <DnsTester />
        </section>

        <section className="mt-10 grid gap-4 sm:grid-cols-3" aria-label="Service features">
          <FeatureCard title="HaGeZi upstreams" description="Three trusted upstream endpoints with deterministic 30-minute primary rotation." />
          <FeatureCard title="Fast failover" description="Only one upstream is tried at a time, with a shared three-second request budget." />
          <FeatureCard title="Abuse protection" description="Strict DNS validation, per-instance limits, CORS controls, and platform WAF support." />
        </section>

        <section className="mt-10 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="usage-title">
          <h2 id="usage-title" className="text-lg font-semibold text-zinc-900">How to use it</h2>
          <div className="mt-4 grid gap-4 text-sm text-zinc-600 sm:grid-cols-3">
            <Step number="1" text="Set your device or browser DNS-over-HTTPS URL to the public endpoint above." />
            <Step number="2" text="For RFC 8484 clients, use GET with dns= or POST with application/dns-message." />
            <Step number="3" text="For public deployment, add a Vercel Firewall rate-limit rule for /api/doh/dns-query." />
          </div>
        </section>

        <footer className="mt-12 pb-4 text-center text-sm text-zinc-400">
          <p>
            © {new Date().getFullYear()} {" "}
            <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-zinc-300 underline-offset-4 hover:text-zinc-700">
              FreeDNS / DoH Proxy
            </a>
            {" "}· Open source under AGPL-3.0
          </p>
        </footer>
      </div>
    </main>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h3 className="font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{description}</p>
    </article>
  );
}

function Step({ number, text }: { number: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span>
      <p className="leading-6">{text}</p>
    </div>
  );
}
