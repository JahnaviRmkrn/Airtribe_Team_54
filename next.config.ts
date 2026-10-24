import type { NextConfig } from "next";

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
    return ["/organizer", "/organizer/:path*", "/room/:path*", "/m/:token"].map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: "no-cache" }],
    }));
  },
};

export default nextConfig;
