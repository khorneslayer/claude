/**
 * Legibility probe: can an operator read the picture? Three questions from the
 * brief, asked of a frozen frame in each view, answered by clicking the map.
 * Correct answers are computed from the engine's own picture, never typed in.
 *
 * Fairness: each participant sees PENUMBRA and LEGACY at different moments
 * (no carry-over from one view to the other), and both the moment assignment
 * and the view order are counterbalanced by participant id.
 */
import { destination, distanceM, hashString, isCovered, type LatLon, type PictureSnapshot } from "@penumbra/core";
import { buildLegacyModel } from "../model/legacy";

export type Question = "least_reliable" | "blind" | "stale";
export type ProbeView = "penumbra" | "legacy";

export const QUESTIONS: Record<Question, { prompt: string; answer: "contact" | "location" }> = {
  least_reliable: { prompt: "Which contact is the least reliable?", answer: "contact" },
  blind: { prompt: "Where can we not see drones? Click on the map.", answer: "location" },
  stale: { prompt: "Which track is the most out of date?", answer: "contact" },
};

/** Two moments with the same kind of picture: SW sensor down, swarm posts arriving, CTR-004 open. */
export const MOMENTS = ["14:41:22", "14:40:55"] as const;

export interface Trial {
  id: string;
  index: number;
  view: ProbeView;
  at: string;
  question: Question;
}

export interface ProbeParams {
  /** A contact counts as least reliable if within this much confidence of the minimum. */
  reliabilityTolerance: number;
  /** Clicks further than this from the ARP do not count for "where can we not see". */
  blindRadiusM: number;
  /** A track counts as most out of date if at least this fraction of the oldest age. */
  staleFraction: number;
}

export const PROBE_DEFAULTS: ProbeParams = { reliabilityTolerance: 0.1, blindRadiusM: 4000, staleFraction: 0.5 };

/** Seeded shuffle (deterministic per participant). */
function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function trialsFor(participant: string): Trial[] {
  const h = hashString(participant);
  const penumbraFirst = (h & 1) === 0;
  const penumbraAt = (h & 2) === 0 ? MOMENTS[0] : MOMENTS[1];
  const legacyAt = penumbraAt === MOMENTS[0] ? MOMENTS[1] : MOMENTS[0];
  const block = (view: ProbeView, at: string, salt: number) =>
    shuffle<Question>(["least_reliable", "blind", "stale"], h ^ salt).map((question) => ({ view, at, question }));
  const blocks = penumbraFirst ? [...block("penumbra", penumbraAt, 0x9e37), ...block("legacy", legacyAt, 0x7f4a)] : [...block("legacy", legacyAt, 0x7f4a), ...block("penumbra", penumbraAt, 0x9e37)];
  return blocks.map((t, index) => ({ ...t, index, id: `${t.view}-${t.question}` }));
}

/** Contacts the participant can see in a view: non-cooperative, as that view draws them. */
export function visibleContacts(snap: PictureSnapshot, view: ProbeView): { id: string; confidence: number; ageS: number }[] {
  if (view === "legacy") {
    return buildLegacyModel(snap)
      .filter((t) => t.affiliation === "unknown")
      .map((t) => ({ id: t.id, confidence: snap.entities.find((e) => e.id === t.id)!.confidence.value, ageS: t.ageS }));
  }
  return snap.entities
    .filter((e) => !e.entityClass.startsWith("AIRCRAFT") && e.position)
    .map((e) => ({ id: e.id, confidence: e.state === "ghost" ? Number.NaN : e.confidence.value, ageS: e.fixAgeS ?? 0 }));
}

export interface Expected {
  /** Contact ids that count as correct (contact questions). */
  ids?: string[];
  /** Human-readable statement of the right answer. */
  note: string;
}

export function expected(q: Question, snap: PictureSnapshot, view: ProbeView, arp: LatLon, p: ProbeParams = PROBE_DEFAULTS): Expected {
  const contacts = visibleContacts(snap, view);
  if (q === "least_reliable") {
    // Ghosts are judged on staleness, not reliability.
    const live = contacts.filter((c) => !Number.isNaN(c.confidence));
    const min = Math.min(...live.map((c) => c.confidence));
    const ids = live.filter((c) => c.confidence <= min + p.reliabilityTolerance).map((c) => c.id);
    return { ids, note: `lowest confidence ${min.toFixed(2)}: ${ids.join(" or ")}` };
  }
  if (q === "stale") {
    const max = Math.max(...contacts.map((c) => c.ageS));
    const ids = contacts.filter((c) => c.ageS >= max * p.staleFraction).map((c) => c.id);
    return { ids, note: `oldest update ${Math.round(max)} s: ${ids.join(" or ")}` };
  }
  return { note: `any point within ${p.blindRadiusM / 1000} km of the airport that no drone sensor covers` };
}

export interface Answer {
  contact?: string;
  location?: LatLon;
  skipped?: boolean;
}

export function score(q: Question, answer: Answer, snap: PictureSnapshot, view: ProbeView, arp: LatLon, p: ProbeParams = PROBE_DEFAULTS): boolean {
  if (answer.skipped) return false;
  if (q === "blind") {
    if (!answer.location) return false;
    return distanceM(arp, answer.location) <= p.blindRadiusM && !isCovered(snap.coverage, answer.location, "uas");
  }
  const exp = expected(q, snap, view, arp, p);
  return answer.contact !== undefined && (exp.ids ?? []).includes(answer.contact);
}

/** Per-view summary of a participant's answers. */
export interface ProbeResult {
  trial: Trial;
  correct: boolean;
  latencyMs: number;
  answer: Answer;
  expected: string;
}

export function summarise(results: ProbeResult[]): Record<ProbeView, { n: number; correct: number; medianMs: number }> {
  const out = {} as Record<ProbeView, { n: number; correct: number; medianMs: number }>;
  for (const view of ["penumbra", "legacy"] as ProbeView[]) {
    const rs = results.filter((r) => r.trial.view === view);
    const ms = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const mid = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2]! : (ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2) : 0;
    out[view] = { n: rs.length, correct: rs.filter((r) => r.correct).length, medianMs: Math.round(mid) };
  }
  return out;
}

/** A point within the probe radius that no drone sensor covers, or undefined if the airport is fully covered. */
export function blindPoint(snap: PictureSnapshot, arp: LatLon, p: ProbeParams = PROBE_DEFAULTS): LatLon | undefined {
  for (let r = 1000; r <= p.blindRadiusM - 200; r += 250) {
    for (let b = 0; b < 360; b += 5) {
      const pt = destination(arp, b, r);
      if (!isCovered(snap.coverage, pt, "uas")) return pt;
    }
  }
  return undefined;
}
