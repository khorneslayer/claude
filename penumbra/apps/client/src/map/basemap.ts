/**
 * Synthetic EDDB basemap: drawn from a handful of hand-placed shapes, no tiles,
 * no network. Not for navigation; layout is approximate and invented.
 */
import { destination, offsetM, type LatLon } from "@penumbra/core";
import type { LonLat } from "../model/view";

const ll = (p: LatLon): LonLat => [p.lon, p.lat];

const runway = (end25: LatLon, lengthM: number) => [ll(end25), ll(destination(end25, 250, lengthM))];

export const RUNWAYS = [
  { id: "07L/25R", label: "EDDB 07L / 25R", path: runway({ lat: 52.383, lon: 13.542 }, 3600) },
  { id: "07R/25L", label: "07R / 25L", path: runway({ lat: 52.3665, lon: 13.564 }, 4000) },
];

const box = (c: LatLon, wM: number, hM: number): LonLat[] => {
  const pts = [offsetM(c, -wM / 2, hM / 2), offsetM(c, wM / 2, hM / 2), offsetM(c, wM / 2, -hM / 2), offsetM(c, -wM / 2, -hM / 2)].map(ll);
  return [...pts, pts[0]!];
};

export const AREAS = [
  { id: "terminal", label: "T1", polygon: box({ lat: 52.3655, lon: 13.5175 }, 900, 380), kind: "building" as const },
  { id: "apron", label: "", polygon: box({ lat: 52.3668, lon: 13.5245 }, 1700, 700), kind: "apron" as const },
  { id: "fanzone", label: "FAN ZONE · PUBLIC EVENT", polygon: box({ lat: 52.3495, lon: 13.4935 }, 1300, 800), kind: "event" as const },
];

export const BOUNDARY: LonLat[] = [
  [13.468, 52.392],
  [13.585, 52.392],
  [13.592, 52.358],
  [13.545, 52.347],
  [13.48, 52.35],
  [13.462, 52.37],
  [13.468, 52.392],
];

/** 1 km reference grid across the bounds. */
export function grid(bounds: { west: number; south: number; east: number; north: number }): LonLat[][] {
  const lines: LonLat[][] = [];
  const midLat = (bounds.north + bounds.south) / 2;
  const dLat = 1 / 111.32;
  const dLon = 1 / (111.32 * Math.cos((midLat * Math.PI) / 180));
  for (let lat = Math.ceil(bounds.south / dLat) * dLat; lat < bounds.north; lat += dLat) lines.push([[bounds.west, lat], [bounds.east, lat]]);
  for (let lon = Math.ceil(bounds.west / dLon) * dLon; lon < bounds.east; lon += dLon) lines.push([[lon, bounds.south], [lon, bounds.north]]);
  return lines;
}
