/**
 * Basemaps: airport layouts traced from published charts (see ber-layout.ts,
 * mrb-layout.ts), plus a 1 km reference grid. No tiles, no network. Not for
 * navigation. The layout follows the scenario the feed announces.
 */
import type { LonLat } from "../model/view";
import { BER_LAYOUT } from "./ber-layout";
import type { AirportLayout } from "./layout";
import { MRB_LAYOUT } from "./mrb-layout";

export type { AirportLayout, Area } from "./layout";

/** Basemap per scenario id. */
const LAYOUTS: Record<string, AirportLayout> = {
  "ber-south-uas-surge": BER_LAYOUT,
  "mrb-lowcost-approach": MRB_LAYOUT,
};

/** The layout for a scenario; BER for unknown ids, so an unlisted scenario still gets a map. */
export function layoutFor(scenarioId: string | undefined): AirportLayout {
  return (scenarioId && LAYOUTS[scenarioId]) || BER_LAYOUT;
}

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
