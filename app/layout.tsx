import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import { ProductAnalytics } from "./components/analytics";

// muop type pairing: DM Sans for UI/body, Newsreader (optical sizes) for display.
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  axes: ["opsz"],
});

const TITLE = "muop — Make time for your people";
const SHARE_DESCRIPTION =
  "Make time for the people who matter. Save your people, remember to check in, and turn “we should catch up” into a plan.";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "muop helps you nurture friendships, family, professional relationships, and community, one thoughtful check-in and meaningful meetup at a time.",
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: SHARE_DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: SHARE_DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Font variables sit on <html> so the :root tokens in globals.css can reference them.
    <html lang="en" className={`${dmSans.variable} ${newsreader.variable}`}>
      <body>
        {children}
        <ProductAnalytics />
      </body>
    </html>
  );
}
