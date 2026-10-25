import type { NextConfig } from "next";
import { APP_CSP, NEXT_CSP } from "./lib/csp";

const nextConfig: NextConfig = {
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
      ...["/organizer", "/organizer/:path*", "/room/:path*", "/m/:token"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      })),
      // Browsers (and the desktop shell) remember to use HTTPS only, so a
      // hostile network can't serve the app over plain http. Ignored on http.
      { source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: "max-age=15552000" }] },
      // Strict CSP for the static apps (built from user data), Next's for the rest.
      // The two sources never overlap, so each path gets exactly one policy.
      ...["/organizer", "/organizer/:path*", "/room/:path*", "/m/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: APP_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      })),
      {
        source: "/((?!organizer(?:/|$)|room/|m/).*)",
        headers: [
          { key: "Content-Security-Policy", value: NEXT_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
