import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Guest meetup room: /m/<token> serves the static page in public/room/,
  // which reads the token from the URL and talks to /api/rooms/:token/*.
  async rewrites() {
    return [{ source: "/m/:token", destination: "/room/index.html" }];
  },
};

export default nextConfig;
