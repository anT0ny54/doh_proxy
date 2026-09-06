import DnsTester from '@/components/DnsTester';
import { DOH_PROVIDERS } from '@/lib/providers';

export default function Home() {
  return (
    <main className="min-h-screen py-16 px-4 sm:px-6 lg:px-8">
      {/* Hero Section */}
      <div className="text-center max-w-3xl mx-auto mb-20 mt-10">
        <h1 className="text-4xl md:text-6xl font-extrabold text-zinc-900 tracking-tight mb-6">
          Secure DoH Proxy
        </h1>
        <p className="text-lg md:text-xl text-zinc-500 mb-8 max-w-2xl mx-auto font-light leading-relaxed">
          A high-performance, multi-upstream DNS over HTTPS proxy running on the edge.
          Protect your privacy and bypass censorship with low-latency edge execution.
        </p>
      </div>

      {/* Tester Section */}
      <div className="mb-24">
        <DnsTester />
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-24">
        <FeatureCard 
          title="Multi-Provider"
          description="Switch between Cloudflare, Google, AdGuard, DNS.SB, and custom endpoints instantly."
        />
        <FeatureCard 
          title="Edge Powered"
          description="Designed for edge/serverless deployment with low request overhead."
        />
        <FeatureCard 
          title="Privacy First"
          description="Stateless request handling with conservative caching and input controls."
        />
      </div>

      {/* Endpoints Section */}
      <div className="max-w-4xl mx-auto">
        <h2 className="text-xl font-semibold text-zinc-900 mb-8 text-center">Available Endpoints</h2>
        <div className="bg-white/60 backdrop-blur-md rounded-2xl shadow-sm border border-zinc-200 overflow-hidden">
          {DOH_PROVIDERS.map((provider) => (
            <div key={provider.id} className="p-5 border-b border-zinc-100 last:border-0 hover:bg-zinc-50/50 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <span className="font-semibold text-zinc-800">{provider.name}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500 font-mono tracking-wide">{provider.id}</span>
                </div>
                <p className="text-sm text-zinc-500">{provider.description}</p>
              </div>
              <div className="flex items-center gap-2 bg-zinc-100/80 rounded-lg p-2.5 font-mono text-sm text-zinc-600 break-all border border-zinc-200/50">
                <span className="select-all">/api/doh/{provider.id}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer className="mt-32 pb-8 text-center text-zinc-400 text-sm">
        <p>
          © {new Date().getFullYear()} <a href="https://github.com/anT0ny54/doh_proxy" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-800 transition-colors underline decoration-zinc-300 underline-offset-4">DoH Proxy</a>. Open Source.
        </p>
      </footer>
    </main>
  );
}

function FeatureCard({ title, description }: { title: string, description: string }) {
  return (
    <div className="bg-white/60 backdrop-blur-sm p-8 rounded-2xl border border-zinc-200/80 hover:border-zinc-300 transition-colors">
      <h3 className="text-lg font-semibold text-zinc-800 mb-3">{title}</h3>
      <p className="text-zinc-500 leading-relaxed text-sm">{description}</p>
    </div>
  );
}
