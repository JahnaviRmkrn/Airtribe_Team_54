import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ProductAnalytics } from "./components/analytics";

// Keep builds independent of Google Fonts. CSS uses the brand fonts when
// installed locally, with deterministic system sans/serif fallbacks.
const TITLE = "muop — Make time for your people";
const SHARE_DESCRIPTION =
  "Make time for the people who matter. Save your people, remember to check in, and turn “we should catch up” into a plan.";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "muop helps you nurture friendships, family, professional relationships, and community, one thoughtful check-in and meaningful meetup at a time.",
  robots: { index: true, follow: true },
  // Google Search Console ownership (URL-prefix property https://muop.win/).
  verification: { google: "6-5zogWuV1QW57u0Zu1hq-4lpLDs9-Bzaisvm-cRgGY" },
  openGraph: { title: TITLE, description: SHARE_DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: SHARE_DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ProductAnalytics />
      </body>
    </html>
  );
}
