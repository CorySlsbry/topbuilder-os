import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font — no runtime Google request,
// works offline in the field like everything else.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

/**
 * Every page renders per-request. This is NOT a performance preference — it is
 * what makes the nonce CSP work at all.
 *
 * Next can only stamp a per-request nonce onto a page it renders per request.
 * A statically prerendered page has its HTML generated at BUILD time, so its
 * script tags carry no nonce — and because our CSP uses 'strict-dynamic',
 * browsers IGNORE 'self' and run only nonce-matched scripts. The result was a
 * production app where every page returned 200, looked completely correct, and
 * was dead HTML: React never hydrated, no button worked, no form submitted.
 * A status-code check cannot see that; only asking the DOM whether React
 * attached can. (Found live 2026-07-26.)
 *
 * Static rendering was never right here anyway: every page is behind auth and
 * shows one tenant's data.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Top Builder OS",
  description:
    "The operating and financial system of record for trades shops.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Top Builder",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#5450d4",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
