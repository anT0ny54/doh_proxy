import type { NextConfig } from "next";
import packageJson from "./package.json";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

// The homepage needs scripts/styles, so its document CSP is applied to "/" only.
// DoH API responses (application/dns-message) are never rendered as documents,
// so they get the global security headers above but no CSP.
const documentCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

// Vercel and Netlify both perform their own build-output tracing and do not
// expect `output: "standalone"` — setting it unconditionally breaks their
// managed build step (missing `.next/next-server.js.nft.json`). The
// Dockerfile, however, copies `.next/standalone` for self-hosting and needs
// it. Both platforms set their own build-time environment variable, so use
// that to scope standalone output to self-hosted (e.g. Docker) builds only.
const platform = process.env.VERCEL ? "vercel" : process.env.NETLIFY ? "netlify" : "self-hosted";
const isManagedPlatformBuild = platform !== "self-hosted";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: isManagedPlatformBuild ? undefined : "standalone",
  // Inlined into server code: the platform selects the unforgeable client-IP
  // header by default (see src/lib/config.ts); only the version string of
  // package.json is inlined (upstream User-Agent), not the whole file.
  env: { DOH_BUILD_PLATFORM: platform, DOH_PROXY_VERSION: packageJson.version },
  experimental: {
    // src/proxy.ts makes Next.js buffer every request body before the route
    // runs (default cap: 10 MB), i.e. before the in-flight ceiling and the
    // route's own 4 KiB streaming cap apply. The cap is one byte over
    // MAX_DNS_MESSAGE_SIZE (src/lib/dns.ts): server/socket-ip-preload.cjs
    // splits the chunk crossing it, so an oversized body reaches the route as
    // 4097 bytes and is still answered 413. Checked by scripts/test-config.mjs.
    proxyClientMaxBodySize: 4_097,
  },
  // The app never uses next/image. Disabling the optimizer removes the
  // image-optimization endpoint (and its sharp attack surface) entirely.
  images: { unoptimized: true },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: "/", headers: [{ key: "Content-Security-Policy", value: documentCsp }] },
    ];
  },
};

export default nextConfig;
