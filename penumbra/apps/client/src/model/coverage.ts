/**
 * Coverage raster: "nothing there" vs "we cannot see there" vs "we used to see there".
 * Pure; the canvas painting lives in map/coverageImage.ts.
 */
import { pointInPolygon, type Coverage, type LatLon } from "@penumbra/core";

export const COVERED = 0;
export const BLIND = 1; // never covered by any non-cooperative sensor
export const LOST = 2; // covered by a sensor that is now down
export const DEGRADED = 3; // covered, but only by degraded sensors

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface CoverageMask {
  bounds: Bounds;
  cols: number;
  rows: number;
  /** Row-major from the north-west corner. */
  cells: Uint8Array;
  /** Centroid of LOST cells, for the label. */
  lostCentroid?: LatLon;
  lostSources: string[];
}

export function boundsAround(center: LatLon, halfKm: number): Bounds {
  const dLat = halfKm / 111.32;
  const dLon = halfKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return { west: center.lon - dLon, east: center.lon + dLon, south: center.lat - dLat, north: center.lat + dLat };
}

export function computeCoverageMask(coverage: Coverage, bounds: Bounds, cols = 200, rows = 200, layer = "uas"): CoverageMask {
  const active = coverage.active.filter((f) => f.layers.includes(layer));
  const lost = coverage.lost.filter((f) => f.layers.includes(layer));
  const cells = new Uint8Array(cols * rows);
  let lostLat = 0;
  let lostLon = 0;
  let lostN = 0;
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south);
    for (let c = 0; c < cols; c++) {
      const lon = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west);
      const p = { lat, lon };
      let v = BLIND;
      let anyUp = false;
      let anyDegraded = false;
      for (const f of active) {
        if (pointInPolygon(p, f.footprint)) {
          if (f.status === "up") {
            anyUp = true;
            break;
          }
          anyDegraded = true;
        }
      }
      if (anyUp) v = COVERED;
      else if (anyDegraded) v = DEGRADED;
      else if (lost.some((f) => pointInPolygon(p, f.footprint))) {
        v = LOST;
        lostLat += lat;
        lostLon += lon;
        lostN++;
      }
      cells[r * cols + c] = v;
    }
  }
  const mask: CoverageMask = { bounds, cols, rows, cells, lostSources: lost.map((f) => f.sourceId) };
  if (lostN > 0) mask.lostCentroid = { lat: lostLat / lostN, lon: lostLon / lostN };
  return mask;
}

/** Stable key: the mask only changes when footprints or statuses change. */
export function coverageKey(coverage: Coverage): string {
  return [...coverage.active.map((f) => `${f.sourceId}:${f.status}`), ...coverage.lost.map((f) => `${f.sourceId}:down`)].sort().join("|");
}
