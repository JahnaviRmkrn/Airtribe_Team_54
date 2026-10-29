import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/auth/", "/m/", "/room/", "/organizer/"] },
    sitemap: "https://muop.win/sitemap.xml",
  };
}
