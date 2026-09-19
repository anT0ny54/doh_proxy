/**
 * Netlify edge middleware for the public DoH endpoint.
 *
 * The rateLimit rule is enforced by Netlify before the request reaches the
 * Next.js route. context.next() then continues the normal request chain.
 * 
 * For non-Netlify deployments (Vercel, self-hosted Docker), the Next.js
 * middleware in src/middleware.ts provides equivalent rate limiting.
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
