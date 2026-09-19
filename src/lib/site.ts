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
  const netlifyUrl = process.env.URL;
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;

  return (
    (configured && toOrigin(configured)) ||
    (netlifyUrl && toOrigin(netlifyUrl)) ||
    (vercelUrl && toOrigin(vercelUrl)) ||
    "http://localhost:3000"
  );
}

export const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export const COPYRIGHT_YEAR = 2026;
