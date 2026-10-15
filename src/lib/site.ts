function toOrigin(value: string): string | undefined {
  try {
    const candidate = value.trim();
    if (!candidate) return undefined;
    // Any explicit scheme is parsed as written (the check below rejects non-http
    // ones, and the match is case-insensitive); a bare host gets https://.
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
    const url = new URL(hasScheme ? candidate : `https://${candidate}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function getSiteUrl(): string {
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

/** Public origin, resolved once per module instance (layout and page share it). */
export const SITE_URL: string = getSiteUrl();

export const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export const COPYRIGHT_YEAR = 2026;
