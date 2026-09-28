function toOrigin(value: string): string | undefined {
  try {
    const candidate = value.trim();
    if (!candidate) return undefined;
    const url = new URL(candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : `https://${candidate}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  // Deploy previews and branch deploys get their own origin; URL is always the
  // production one.
  const netlifyUrl =
    process.env.CONTEXT && process.env.CONTEXT !== "production" && process.env.DEPLOY_PRIME_URL
      ? process.env.DEPLOY_PRIME_URL
      : process.env.URL;
  // On preview deploys VERCEL_PROJECT_PRODUCTION_URL still points at the
  // production origin, so prefer the per-deploy VERCEL_URL there; production
  // builds prefer the stable production origin.
  const vercelUrl =
    process.env.VERCEL_ENV === "preview"
      ? process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL
      : process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;

  return (
    (configured && toOrigin(configured)) ||
    (netlifyUrl && toOrigin(netlifyUrl)) ||
    (vercelUrl && toOrigin(vercelUrl)) ||
    "http://localhost:3000"
  );
}

export const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export const COPYRIGHT_YEAR = 2026;
