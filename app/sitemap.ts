import type { MetadataRoute } from "next";

// Public, indexable pages only; the app itself (/organizer, /room, /m) sits behind login or private links.
const SITE = "https://muop.win";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/traction`, changeFrequency: "daily", priority: 0.5 },
    { url: `${SITE}/privacy.html`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
