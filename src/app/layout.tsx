import type { Metadata, Viewport } from "next";
import "./globals.css";

const REPOSITORY_URL = "https://github.com/anT0ny54/doh_proxy";

export const metadata: Metadata = {
  metadataBase: new URL("https://github.com/anT0ny54/doh_proxy"),
  title: "Secure DoH Proxy | Fast, Privacy-First DNS",
  description:
    "A high-performance DNS-over-HTTPS proxy with multiple public upstream providers and a browser-based DNS tester.",
  keywords: ["DoH", "DNS over HTTPS", "DNS proxy", "Cloudflare", "Google DNS", "AdGuard DNS"],
  authors: [{ name: "DoH Proxy", url: REPOSITORY_URL }],
  openGraph: {
    title: "Secure DoH Proxy",
    description: "Fast, privacy-first DNS-over-HTTPS proxy.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#f4f4f5",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
