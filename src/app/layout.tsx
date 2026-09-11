import type { Metadata, Viewport } from "next";
import "./globals.css";

const SITE_URL = "https://freedns-six.vercel.app";
const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "FreeDNS — Fast DNS-over-HTTPS",
  description:
    "A lightweight public DNS-over-HTTPS resolver using HaGeZi upstreams with automatic rotation and failover.",
  keywords: ["FreeDNS", "DNS over HTTPS", "DoH", "HaGeZi", "public DNS"],
  authors: [{ name: "FreeDNS", url: REPOSITORY_URL }],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "FreeDNS — Fast DNS-over-HTTPS",
    description: "A lightweight public DoH resolver with automatic rotation and failover.",
    type: "website",
    url: SITE_URL,
  },
};

export const viewport: Viewport = {
  themeColor: "#f4f4f5",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
