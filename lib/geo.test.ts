import { describe, expect, it } from 'vitest';
import { AREAS, areaCoords, centroid, haversineKm, nearestArea, roundTo, travel } from './geo';

describe('areaCoords', () => {
  it('finds known areas loosely', () => {
    expect(areaCoords('Indiranagar')).toEqual(AREAS.indiranagar);
    expect(areaCoords('  hsr   layout ')).toEqual(AREAS['hsr layout']);
    expect(areaCoords('near Koramangala 5th block')).toEqual(AREAS.koramangala);
  });
  it('returns null for unknown or empty', () => {
    expect(areaCoords('Atlantis')).toBeNull();
    expect(areaCoords('')).toBeNull();
    expect(areaCoords(null)).toBeNull();
  });
});

describe('distances', () => {
  it('haversine is about right across town', () => {
    const km = haversineKm(AREAS.whitefield, AREAS.jayanagar);
    expect(km).toBeGreaterThan(17);
    expect(km).toBeLessThan(20);
    expect(haversineKm(AREAS.domlur, AREAS.domlur)).toBe(0);
  });

  it('centroid of Whitefield + Jayanagar lands mid-city', () => {
    const mid = centroid([AREAS.whitefield, AREAS.jayanagar])!;
    const { area } = nearestArea(mid);
    expect(['Domlur', 'Koramangala', 'Indiranagar', 'Bellandur']).toContain(area);
    // Both trips about equal from the middle.
    const t = travel(mid, [AREAS.whitefield, AREAS.jayanagar]);
    expect(t.max_km - t.avg_km).toBeLessThan(0.5);
  });

  it('centroid of nothing is null', () => {
    expect(centroid([])).toBeNull();
  });

  it('travel reports the longest and average trip', () => {
    const t = travel(AREAS.koramangala, [AREAS.koramangala, AREAS.whitefield]);
    expect(t.max_km).toBeGreaterThan(13);
    expect(t.avg_km).toBeCloseTo(t.max_km / 2, 0);
  });
});

describe('nearestArea / roundTo', () => {
  it('labels HSR with the right capitals', () => {
    expect(nearestArea({ lat: 12.912, lng: 77.648 }).area).toBe('HSR Layout');
  });
  it('rounds coordinates', () => {
    expect(roundTo({ lat: 12.97841, lng: 77.64089 }, 2)).toEqual({ lat: 12.98, lng: 77.64 });
  });
});
