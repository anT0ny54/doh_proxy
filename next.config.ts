import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

// Vercel and Netlify both perform their own build-output tracing and do not
// expect `output: "standalone"` — setting it unconditionally breaks their
// managed build step (missing `.next/next-server.js.nft.json`). The
// Dockerfile, however, copies `.next/standalone` for self-hosting and needs
// it. Both platforms set their own build-time environment variable, so use
// that to scope standalone output to self-hosted (e.g. Docker) builds only.
const isManagedPlatformBuild = Boolean(process.env.VERCEL) || Boolean(process.env.NETLIFY);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  output: isManagedPlatformBuild ? undefined : "standalone",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
