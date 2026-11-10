/**
 * Basemap: the EDDB layout traced from the R. Aehnelt chart (see ber-layout.ts),
 * plus a 1 km reference grid. No tiles, no network. Not for navigation.
 */
import type { LonLat } from "../model/view";

export { AREAS, LABELS, RUNWAYS, RUNWAY_SCREEN_ANGLE, TAXIWAYS, TAXIWAY_WIDTH_M, ARP, CHART_BOUNDS, type Area } from "./ber-layout";
export const BASEMAP_CREDIT = "LAYOUT AFTER R. AEHNELT / WIKIMEDIA COMMONS (CC)";

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
