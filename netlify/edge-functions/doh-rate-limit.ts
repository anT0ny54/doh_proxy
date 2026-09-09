/**
 * Netlify edge middleware for the public DoH endpoint.
 *
 * The rateLimit rule is enforced by Netlify before the request reaches the
 * Next.js route. context.next() then continues the normal request chain.
 */
export default async (_request: Request, context: { next: () => Promise<Response> }) => {
  return context.next();
};

export const config = {
  path: "/api/doh/dns-query",
  rateLimit: {
    windowLimit: 100,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
  
