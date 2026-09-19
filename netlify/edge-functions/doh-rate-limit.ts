/**
 * Netlify edge middleware for the public DoH endpoint.
 *
 * The rateLimit rule is enforced by Netlify before the request reaches the
 * Next.js route. context.next() then continues the normal request chain.
 *
 * Non-Netlify deployments (Vercel, self-hosted Docker) have no application
 * level limiter by design: use the platform WAF or a reverse proxy so the limit
 * is shared across instances and cannot be bypassed with spoofed headers.
 */
export default async (_request: Request, context: { next: () => Promise<Response> }) => {
  return context.next();
};

export const config = {
  path: "/api/doh/*",
  rateLimit: {
    action: "rate_limit",
    windowLimit: 100,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
