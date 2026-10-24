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
};

export default nextConfig;
