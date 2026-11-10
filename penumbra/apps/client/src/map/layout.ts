/**
 * Airport layout contract shared by every basemap (BER, KMRB, ...): geometry
 * traced in chart pixels and georeferenced to lat/lon, drawn by
 * buildStaticLayers. Not for navigation.
 */
import { offsetM, type LatLon } from "@penumbra/core";

export type Px = [number, number];
export type LonLat = [number, number];

export interface Runway {
  id: string;
  label: string;
  widthM: number;
  path: LonLat[];
  ends: { designator: string; heading: string; position: LonLat; outward: LonLat }[];
}

export interface Taxiway {
  id: string;
  path: LonLat[];
}

export interface Area {
  id: string;
  polygon: LonLat[];
  kind: "apron" | "building" | "terminal" | "outline";
}

export interface MapLabel {
  text: string;
  position: LonLat;
  kind: "major" | "minor" | "taxiway" | "runway";
  angle?: number;
}

export interface AirportLayout {
  icao: string;
  ARP: LatLon;
  RUNWAYS: Runway[];
  TAXIWAYS: Taxiway[];
  TAXIWAY_WIDTH_M: number;
  AREAS: Area[];
  LABELS: MapLabel[];
  RUNWAY_SCREEN_ANGLE: number;
  CHART_BOUNDS: { sw: LonLat; ne: LonLat };
  /** Initial view: km to show west / south / east / north of the scenario centre. */
  FIT_KM: { west: number; south: number; east: number; north: number };
  /** Credit line for the chart the layout was traced from. */
  credit: string;
}

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Chart georeference: a similarity transform fixed by one anchor (the ARP at a
 * chart pixel), a scale and the true bearing of the chart's +x axis.
 */
export function georef(arp: LatLon, arpPx: Px, metresPerPx: number, rightBearing: number) {
  const upBearing = rightBearing - 90;
  const pxToLatLon = ([x, y]: Px): LatLon => {
    const u = (x - arpPx[0]) * metresPerPx;
    const v = (arpPx[1] - y) * metresPerPx;
    const east = u * Math.sin(rad(rightBearing)) + v * Math.sin(rad(upBearing));
    const north = u * Math.cos(rad(rightBearing)) + v * Math.cos(rad(upBearing));
    return offsetM(arp, east, north);
  };
  const ll = (p: Px): LonLat => {
    const g = pxToLatLon(p);
    return [g.lon, g.lat];
  };
  return {
    pxToLatLon,
    ll,
    path: (pts: Px[]) => pts.map(ll),
    ring: (pts: Px[]) => {
      const r = pts.map(ll);
      return [...r, r[0]!];
    },
    /** Screen angle (deg, counter-clockwise from east) of the chart's +x axis on a north-up map. */
    screenAngle: 90 - rightBearing,
  };
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Px[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
