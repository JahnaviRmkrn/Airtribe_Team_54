// "Meet in the middle": where everyone is coming from -> a fair meeting point.
// Pure helpers (no I/O) so they can be unit-tested and used by the shortlist.

export type LatLng = { lat: number; lng: number };

// Approximate centres of Bengaluru neighbourhoods. Used to place the sample
// venues (by their area) and guests who type an area instead of sharing a
// location. Good enough to compare travel distances; not for navigation.
export const AREAS: Record<string, LatLng> = {
  'indiranagar': { lat: 12.9784, lng: 77.6408 },
  'koramangala': { lat: 12.9352, lng: 77.6245 },
  'hsr layout': { lat: 12.9116, lng: 77.6474 },
  'whitefield': { lat: 12.9698, lng: 77.75 },
  'brookefield': { lat: 12.9655, lng: 77.7183 },
  'electronic city': { lat: 12.8452, lng: 77.6602 },
  'jayanagar': { lat: 12.9308, lng: 77.5838 },
  'jp nagar': { lat: 12.9063, lng: 77.5857 },
  'mg road': { lat: 12.9756, lng: 77.6066 },
  'marathahalli': { lat: 12.9569, lng: 77.7011 },
  'bellandur': { lat: 12.9304, lng: 77.6784 },
  'btm layout': { lat: 12.9166, lng: 77.6101 },
  'domlur': { lat: 12.961, lng: 77.6387 },
  'ulsoor': { lat: 12.9817, lng: 77.6286 },
  'hebbal': { lat: 13.0358, lng: 77.597 },
  'malleshwaram': { lat: 13.0035, lng: 77.5647 },
  'rajajinagar': { lat: 12.991, lng: 77.552 },
  'banashankari': { lat: 12.9255, lng: 77.5468 },
  'yelahanka': { lat: 13.1007, lng: 77.5963 },
  'hoodi': { lat: 12.992, lng: 77.715 },
  'kr puram': { lat: 13.0076, lng: 77.695 },
  'sarjapur road': { lat: 12.901, lng: 77.686 },
  'bannerghatta road': { lat: 12.889, lng: 77.597 },
  'basavanagudi': { lat: 12.9416, lng: 77.5755 },
  'frazer town': { lat: 12.9986, lng: 77.6158 },
};

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function areaCoords(area?: string | null): LatLng | null {
  if (!area) return null;
  const k = key(area);
  if (AREAS[k]) return AREAS[k];
  // "Indiranagar 2nd stage", "near HSR Layout" -> the known area it mentions.
  const hit = Object.keys(AREAS).find((a) => k.includes(a));
  return hit ? AREAS[hit] : null;
}

export const isLatLng = (p: unknown): p is LatLng =>
  !!p && typeof (p as LatLng).lat === 'number' && typeof (p as LatLng).lng === 'number' &&
  Math.abs((p as LatLng).lat) <= 90 && Math.abs((p as LatLng).lng) <= 180;

const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Centre of the points on the sphere (fine at city scale, safe at any scale).
export function centroid(points: LatLng[]): LatLng | null {
  if (!points.length) return null;
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    x += Math.cos(rad(p.lat)) * Math.cos(rad(p.lng));
    y += Math.cos(rad(p.lat)) * Math.sin(rad(p.lng));
    z += Math.sin(rad(p.lat));
  }
  const n = points.length;
  x /= n; y /= n; z /= n;
  return { lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lng: (Math.atan2(y, x) * 180) / Math.PI };
}

export function nearestArea(p: LatLng): { area: string; km: number } {
  let best = { area: '', km: Infinity };
  for (const [area, c] of Object.entries(AREAS)) {
    const km = haversineKm(p, c);
    if (km < best.km) best = { area, km };
  }
  return { area: best.area.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/\b(Hsr|Btm|Jp|Mg|Kr)\b/g, (s) => s.toUpperCase()), km: best.km };
}

// Travel from every person to a spot: the longest trip is what makes a place fair or not.
export function travel(spot: LatLng, people: LatLng[]): { max_km: number; avg_km: number } {
  const d = people.map((p) => haversineKm(p, spot));
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { max_km: r1(Math.max(...d)), avg_km: r1(d.reduce((s, x) => s + x, 0) / d.length) };
}

// Round for display/storage: 3 decimals ~ 110 m (stored), 2 decimals ~ 1.1 km (shown to others).
export const roundTo = (p: LatLng, decimals: number): LatLng => {
  const f = 10 ** decimals;
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f };
};
