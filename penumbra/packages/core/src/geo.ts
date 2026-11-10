import type { LatLon, Polygon } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north, in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached from `from` after `distM` metres on `bearing` degrees. */
export function destination(from: LatLon, bearing: number, distM: number): LatLon {
  const d = distM / EARTH_RADIUS_M;
  const b = toRad(bearing);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/** Local east/north metre offset applied to a point (fine at city scale). */
export function offsetM(from: LatLon, eastM: number, northM: number): LatLon {
  return {
    lat: from.lat + toDeg(northM / EARTH_RADIUS_M),
    lon: from.lon + toDeg(eastM / (EARTH_RADIUS_M * Math.cos(toRad(from.lat)))),
  };
}

/** Circle approximated as a polygon with `segments` vertices. */
export function circlePolygon(center: LatLon, radiusM: number, segments = 48): LatLon[] {
  const ring: LatLon[] = [];
  for (let i = 0; i < segments; i++) ring.push(destination(center, (360 * i) / segments, radiusM));
  return ring;
}

/** Circular sector (pie slice) from bearing `fromDeg` clockwise to `toDeg`. */
export function sectorPolygon(center: LatLon, radiusM: number, fromDeg: number, toDeg: number, segments = 24): LatLon[] {
  const span = (((toDeg - fromDeg) % 360) + 360) % 360 || 360;
  const ring: LatLon[] = [center];
  for (let i = 0; i <= segments; i++) ring.push(destination(center, fromDeg + (span * i) / segments, radiusM));
  return ring;
}

/** Ray-casting point-in-ring test on lon/lat (adequate at city scale, no antimeridian). */
export function pointInRing(p: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(p: LatLon, poly: Polygon): boolean {
  if (!pointInRing(p, poly.outer)) return false;
  return !(poly.holes ?? []).some((h) => pointInRing(p, h));
}

export function centroid(points: LatLon[]): LatLon | undefined {
  if (points.length === 0) return undefined;
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}
