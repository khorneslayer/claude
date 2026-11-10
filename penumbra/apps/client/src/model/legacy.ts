/**
 * LEGACY view: the same picture drawn the way fielded COPs draw it. This is a
 * comparison baseline, so it has to be a fair copy, not a strawman:
 *
 *   - one fused track per contact, at its last fused position
 *   - standard APP-6 / 2525 symbols in standard affiliation colours, one size
 *   - classification = the single best-scoring reading; competing readings are
 *     resolved silently (what fusion does), so no contradiction is visible
 *   - no ageing: a coasting track is drawn exactly like a fresh one until the
 *     track-drop timer removes it (dropAfterS, default 300 s)
 *   - no coverage layer, no deception flags, no provenance on the map
 *   - track quality exists, as a 0-15 number in the track details panel, as on
 *     fielded systems (metadata behind a click, not a visual property)
 *
 * Pure; unit-tested.
 */
import type { EntityView, LatLon, PictureSnapshot } from "@penumbra/core";
import type { LonLat } from "./view";

export interface LegacyParams {
  /** Seconds without an update after which a track is dropped. */
  dropAfterS: number;
}

export const LEGACY_DEFAULTS: LegacyParams = { dropAfterS: 300 };

export interface LegacyTrack {
  id: string;
  position: LonLat;
  latLon: LatLon;
  altM?: number;
  sidc: string;
  affiliation: "unknown" | "neutral";
  /** Best single reading per dimension, e.g. { intent: "hobbyist" }. */
  classification: Record<string, string>;
  label: string[];
  /** 0-15, Link 16 style. Shown only in the details panel. */
  trackQuality: number;
  lastUpdateT: number;
  ageS: number;
}

const pretty = (v: string) => v.replace(/-(\d)/g, " $1").replaceAll("-", " ").toUpperCase();

function bestReadings(e: EntityView): Record<string, string> {
  const out: Record<string, string> = {};
  const best = new Map<string, number>();
  for (const h of e.hypotheses) {
    if (h.confidence.value > (best.get(h.dimension) ?? -1)) {
      best.set(h.dimension, h.confidence.value);
      out[h.dimension] = h.value;
    }
  }
  return out;
}

export function buildLegacyModel(snap: PictureSnapshot, params: LegacyParams = LEGACY_DEFAULTS): LegacyTrack[] {
  const tracks: LegacyTrack[] = [];
  for (const e of snap.entities) {
    if (!e.position || e.fixAgeS === undefined || e.fixAgeS > params.dropAfterS) continue;
    const aircraft = e.entityClass.startsWith("AIRCRAFT");
    const classification = bestReadings(e);
    const kind = aircraft ? "CIVIL AIRCRAFT" : "UAS";
    const readings = Object.entries(classification)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dim, v]) => (dim === "altitude_band" ? `ALT ${pretty(v)}` : pretty(v)));
    const t: LegacyTrack = {
      id: e.id,
      position: [e.position.lon, e.position.lat],
      latLon: { lat: e.position.lat, lon: e.position.lon },
      sidc: aircraft ? "SNAPCF---------" : "SUAPMFQ--------",
      affiliation: aircraft ? "neutral" : "unknown",
      classification,
      label: [e.id, [kind, ...readings].join(" · ")],
      trackQuality: Math.max(0, Math.min(15, Math.round(e.confidence.value * 15))),
      lastUpdateT: e.lastFixT ?? e.lastObsT,
      ageS: e.fixAgeS,
    };
    if (e.position.altM !== undefined) t.altM = e.position.altM;
    tracks.push(t);
  }
  return tracks.sort((a, b) => a.id.localeCompare(b.id));
}
