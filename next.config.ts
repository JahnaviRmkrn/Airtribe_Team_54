import type { NextConfig } from "next";
import { baseSecurityHeaders, contentSecurityPolicy, NEXT_PAGE_SOURCE, STATIC_PAGE_SOURCES } from "./lib/security-headers";

const csp = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  dev: process.env.NODE_ENV !== "production",
};

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Guest meetup room: /m/<token> serves the static page in public/room/,
  // which reads the token from the URL and talks to /api/rooms/:token/*.
  // /organizer maps to the Organizer app's index.html: Next only serves it at
  // /organizer/index.html, while the app and the /login?next= redirect both use
  // /organizer/ (which 308s to /organizer and 404s without this entry).
  async rewrites() {
    return [
      { source: "/m/:token", destination: "/room/index.html" },
      { source: "/organizer", destination: "/organizer/index.html" },
    ];
  },
  // The organizer and room apps are unversioned static files. With the default
  // 4h max-age, a deploy could pair new app.js with a stale styles.css (seen on
  // the dashboard guide card). no-cache keeps them cached but revalidated by ETag.
  async headers() {
    return [
      { source: "/:path*", headers: baseSecurityHeaders },
      { source: NEXT_PAGE_SOURCE, headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy("next", csp) }] },
      ...STATIC_PAGE_SOURCES.map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy("static", csp) },
        ],
      })),
    ];
  },
};

export default nextConfig;
