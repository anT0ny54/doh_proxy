import type { NextConfig } from "next";

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
const isManagedPlatformBuild = Boolean(process.env.VERCEL) || Boolean(process.env.NETLIFY);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  output: isManagedPlatformBuild ? undefined : "standalone",
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: "/", headers: [{ key: "Content-Security-Policy", value: documentCsp }] },
    ];
  },
};

export default nextConfig;
