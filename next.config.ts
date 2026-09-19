import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

// The interactive homepage needs scripts/styles, while the DoH API can use
// a much stricter policy. Keep the API CSP scoped to /api/doh/* instead of
// applying `default-src 'none'` to the entire application.
const documentCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const apiCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

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
      { source: "/api/doh/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] },
      // Keep the document policy scoped to the web UI. API responses above
      // must not also receive this second CSP header.
      { source: "/", headers: [{ key: "Content-Security-Policy", value: documentCsp }] },
    ];
  },
};

export default nextConfig;
