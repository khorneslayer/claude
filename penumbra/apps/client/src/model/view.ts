/**
 * Snapshot -> render model. Pure: no deck.gl, no DOM, so it is unit-tested.
 *
 * Visual grammar (from the brief and slide 7):
 *   confidence      continuous: ring edge sharpness + fill saturation + symbol opacity
 *   corroboration   ring density: one ring per independent source (max 4)
 *   ghost           dashed plausible envelope + faint hard-reach ring, dashed symbol frame
 *   contradiction   competing hypotheses drawn at their own positions, linked, neither averaged away
 *   coverage        hatched "cannot see here", distinct from empty covered ground (see coverage.ts)
 *   deception       flag marker at the burst centroid, reports linked to it
 */
import {
  bearingDeg,
  circlePolygon,
  destination,
  distanceM,
  formatElapsed,
  type EntityView,
  type HypothesisView,
  type LatLon,
  type ObservationEvent,
  type PictureSnapshot,
} from "@penumbra/core";
import { C, type RGB } from "../theme";

export type LonLat = [number, number];
export type Category = "corroborated" | "contradicted" | "single" | "degraded" | "ghost" | "cooperative" | "flagged";

export interface Glyph {
  id: string;
  entityId: string;
  kind: "track" | "candidate" | "ghost";
  category: Category;
  position: LonLat;
  color: RGB;
  confidence: number;
  rings: number;
  sidc: string;
  label: string[];
  /** Line 2 of the label carries the warning colour for contradicted / flagged / degraded items. */
  accent: RGB;
}

export interface Envelope {
  id: string;
  path: LonLat[];
  kind: "plausible" | "reach";
}

export interface Link {
  id: string;
  path: LonLat[];
  color: RGB;
}

export interface Wedge {
  id: string;
  polygon: LonLat[];
  color: RGB;
}

export interface FlagMarker {
  id: string;
  position: LonLat;
  label: string[];
  spokes: Link[];
  reports: LonLat[];
}

export interface RenderModel {
  glyphs: Glyph[];
  envelopes: Envelope[];
  links: Link[];
  wedges: Wedge[];
  flags: FlagMarker[];
}

export type ObsLookup = (obsId: string) => ObservationEvent | undefined;

const ll = (p: LatLon): LonLat => [p.lon, p.lat];
const ring = (center: LatLon, r: number, n = 72): LonLat[] => {
  const pts = circlePolygon(center, r, n).map(ll);
  return [...pts, pts[0]!];
};
const f2 = (x: number) => x.toFixed(2);
export const age = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);

/** 2525C letter SIDCs (milsymbol). Status A ("anticipated") gives the dashed frame used for ghosts. */
export function sidcFor(e: EntityView, ghost: boolean): string {
  const status = ghost ? "A" : "P";
  if (e.entityClass.startsWith("AIRCRAFT")) return `SNA${status}CF---------`;
  return `SUA${status}MFQ--------`;
}

/**
 * An unresolved contradiction turns a track orange. A deferred one does not:
 * the operator has seen it and parked it, so the track keeps its corroboration
 * colour and carries the contradiction id as a tag instead (slide 7: TRK-1147
 * is cyan while CTR-003 is deferred).
 */
export function categorise(e: EntityView, snap?: PictureSnapshot): Category {
  if (e.state === "ghost") return "ghost";
  if (e.flags.includes("DECEPTION_FLAG")) return "flagged";
  const contested = snap
    ? snap.contradictions.some((c) => c.entityId === e.id && c.status === "unresolved")
    : e.flags.includes("CONTRADICTED");
  if (contested) return "contradicted";
  if (e.entityClass.startsWith("AIRCRAFT")) return "cooperative";
  if (e.flags.includes("DEGRADED_SOURCE")) return "degraded";
  if (e.sourceCount >= 2 && e.confidence.value >= 0.6) return "corroborated";
  return "single";
}

const COLORS: Record<Category, RGB> = {
  corroborated: C.cyan,
  contradicted: C.orange,
  single: C.dim,
  degraded: C.amber,
  ghost: C.grey,
  cooperative: C.neutral,
  flagged: C.orange,
};

/** A contact whose own position is this uncertain may have hypotheses that disagree about where it is. */
const UNCERTAIN_POSITION_M = 150;

/**
 * Hypotheses of an entity's open contradiction, drawn separately at their own
 * positions. Only when the contact's position is itself uncertain (known from
 * sparse reports): for a well-tracked contact the contradiction is about an
 * attribute (altitude, intent) and the hypotheses share the track.
 */
function splitCandidates(e: EntityView, snap: PictureSnapshot): HypothesisView[] | undefined {
  if (!e.position || e.position.sigmaM < UNCERTAIN_POSITION_M) return undefined;
  const open = snap.contradictions.filter((c) => c.entityId === e.id && (c.status === "unresolved" || c.status === "deferred"));
  for (const c of open) {
    const hyps = e.hypotheses.filter((h) => h.dimension === c.dimension && h.status !== "rejected" && h.position && h.label);
    if (hyps.length < 2) continue;
    let spread = 0;
    for (const a of hyps) for (const b of hyps) spread = Math.max(spread, distanceM(a.position!, b.position!));
    if (spread > 150) return hyps;
  }
  return undefined;
}

/** "RF BEARING", "2 CIV CALLS", "EO + RF" ... from who asserted a hypothesis. */
function supportSummary(h: HypothesisView, lookup: ObsLookup): string {
  const bearing = h.confidence.contributions.some((c) => h.assertedBy.some((a) => a.originId === c.originId) && lookup(c.obsId)?.bearing);
  const counts = new Map<string, number>();
  for (const a of h.assertedBy) counts.set(a.sourceType, (counts.get(a.sourceType) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => {
    if (t === "RF" && bearing && n === 1) return "RF BEARING";
    const name = t === "CIV_CALL" ? "CIV CALL" : t === "SOCIAL" ? "SOCIAL" : t;
    return n === 1 ? `1 ${name}` : `${n} ${name}S`;
  });
  return parts.join(" + ");
}

export function buildRenderModel(snap: PictureSnapshot, lookup: ObsLookup): RenderModel {
  const glyphs: Glyph[] = [];
  const envelopes: Envelope[] = [];
  const links: Link[] = [];
  const wedges: Wedge[] = [];

  for (const e of snap.entities) {
    if (!e.position) continue;
    const category = categorise(e, snap);
    const parked = snap.contradictions.filter((c) => c.entityId === e.id && c.status === "deferred").map((c) => c.id);
    const conf = e.confidence.value;
    const candidates = splitCandidates(e, snap);

    if (candidates) {
      candidates.forEach((h) => {
        glyphs.push({
          id: `${e.id}:${h.label}`,
          entityId: e.id,
          kind: "candidate",
          category: "contradicted",
          position: ll(h.position!),
          color: C.orange,
          confidence: h.confidence.value,
          rings: Math.max(1, Math.min(4, h.assertedBy.length)),
          sidc: sidcFor(e, false),
          label: [`${h.label} · ${h.value.toUpperCase().replaceAll("-", " ")}`, `CONF ${f2(h.confidence.value)} · ${supportSummary(h, lookup)}`],
          accent: C.orange,
        });
        // Bearing-only support is a wedge, not a point.
        for (const c of h.confidence.contributions) {
          const o = lookup(c.obsId);
          if (!o?.bearing || o.claims[h.dimension] !== h.value) continue;
          const reach = distanceM(o.bearing.origin, h.position!) * 1.15;
          const spread = Math.max(1.5, o.bearing.sigmaDeg * 2);
          const pts: LonLat[] = [ll(o.bearing.origin)];
          for (let k = 0; k <= 12; k++) pts.push(ll(destination(o.bearing.origin, o.bearing.bearingDeg - spread + (2 * spread * k) / 12, reach)));
          pts.push(ll(o.bearing.origin));
          wedges.push({ id: `${e.id}:${h.label}:${o.obsId}`, polygon: pts, color: C.orange });
        }
      });
      for (let i = 1; i < candidates.length; i++) {
        links.push({ id: `${e.id}:link:${i}`, path: [ll(candidates[0]!.position!), ll(candidates[i]!.position!)], color: C.orange });
      }
      continue;
    }

    const ghost = e.state === "ghost";
    const metrics = ghost
      ? `LAST CONF ${age(e.fixAgeS ?? 0)} · ENVELOPE ${km(e.envelopeRadiusM ?? 0)}`
      : `CONF ${f2(conf)} · ${e.sourceCount} SRC · ${age(e.fixAgeS ?? 0)}${e.flags.includes("DEGRADED_SOURCE") ? " · DEGRADED" : ""}`;
    glyphs.push({
      id: e.id,
      entityId: e.id,
      kind: ghost ? "ghost" : "track",
      category,
      position: ll(e.position),
      color: COLORS[category],
      // A ghost shows the confidence it had at its last fix, faded by the renderer.
      confidence: ghost ? (e.confidenceAtLastFix ?? conf) : conf,
      rings: ghost ? 1 : Math.max(1, Math.min(4, e.sourceCount)),
      sidc: sidcFor(e, ghost),
      label: [ghost ? `${e.id} · GHOST` : parked.length ? `${e.id} · ${parked.join(" ")} DEFERRED` : e.id, metrics],
      accent: category === "corroborated" ? C.cyan : category === "single" ? C.dim : COLORS[category],
    });

    if (ghost && e.envelopeRadiusM) {
      envelopes.push({ id: `${e.id}:plausible`, path: ring(e.position, e.envelopeRadiusM), kind: "plausible" });
      if (e.maxReachM && e.maxReachM > e.envelopeRadiusM * 1.05) {
        envelopes.push({ id: `${e.id}:reach`, path: ring(e.position, e.maxReachM, 120), kind: "reach" });
      }
    }
  }

  const flags: FlagMarker[] = snap.flags.map((f) => {
    const reports = f.obsIds.map(lookup).flatMap((o) => (o?.position ? [ll(o.position)] : []));
    const center: LonLat = f.centroid ? ll(f.centroid) : reports[0] ?? [0, 0];
    return {
      id: f.id,
      position: center,
      label: ["DECEPTION FLAG", `${f.reason.replaceAll("_", " ")} · ${f.count} REPORTS`],
      reports,
      spokes: reports.map((r, i) => ({ id: `${f.id}:${i}`, path: [center, r], color: C.orange })),
    };
  });

  return { glyphs, envelopes, links, wedges, flags };
}

/** 8-point compass sector of `p` as seen from `center`. */
export function sectorName(center: LatLon, p: LatLon): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(bearingDeg(center, p) / 45) % 8]!;
}

export { formatElapsed };
