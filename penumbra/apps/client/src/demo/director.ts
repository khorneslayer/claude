/**
 * Demo director: the scripted walkthrough for unattended demos and the
 * DIANA video. Cues fire as the live head passes them (scenario time), or a
 * number of seconds after the scenario ends (epilogue). Captions are written
 * for an evaluator who has never seen the system.
 */
import type { Selection } from "../model/panels";

export interface Cue {
  /** Scenario time "HH:MM:SS", or seconds after the scenario ended. */
  at: string | { afterEndS: number };
  caption?: string | null;
  select?: Selection;
  view?: "penumbra" | "legacy";
  /** Replay a moment ("HH:MM:SS") or return to live. */
  replay?: string | "live";
  /** Last cue: the demo is over. */
  end?: boolean;
}

export const DEMO_CUES: Cue[] = [
  { at: "14:38:23", caption: "Berlin Brandenburg. A major public event at the ExpoCenter, and drone reports are surging." },
  { at: "14:38:40", select: { entityId: "TRK-1147" }, caption: "TRK-1147 over the event: four independent sensors agree. Confidence 0.93, drawn as four crisp rings." },
  {
    at: "14:39:06",
    select: { entityId: "TRK-1155", label: "CAND-A" },
    caption: "One contact, two readings. An RF bearing says hobbyist; two callers say a coordinated pair. Neither is averaged away.",
  },
  { at: "14:39:40", select: { entityId: "TRK-1152" }, caption: "TRK-1152 was last seen 41 minutes ago. Not a current track: an uncertainty area that keeps growing." },
  { at: "14:40:07", caption: "A sensor fails. Sector south-west goes blind: “nothing there” and “we cannot see there” now look different." },
  { at: "14:41:02", select: { entityId: "TRK-1170" }, caption: "Six accounts post the same swarm claim within 40 seconds. Flagged, and counted as one vote, not six." },
  {
    at: "14:41:12",
    select: { entityId: "TRK-1155", label: "CAND-A" },
    caption: "Every number decomposes: 0.51 = 0.34 from the RF bearing + 0.11 from a caller + 0.06 from a social post.",
  },
  { at: "14:41:24", view: "legacy", caption: "The same data, the way a fielded system draws it." },
  { at: "14:41:31", view: "penumbra", caption: "The same data, with its uncertainty on the picture." },
  { at: "14:41:34", caption: "Police at the car park confirm a single hobbyist drone." },
  { at: "14:41:40", caption: "OP-1 resolves CTR-004 as hobbyist. The decision becomes evidence; the rejected reading drops to zero." },
  { at: { afterEndS: 2 }, replay: "14:36:00", caption: "Replay: exactly what the operator could see at 14:36, before any of this." },
  { at: { afterEndS: 9 }, replay: "live", caption: "PENUMBRA: confidence, age, lineage and contradiction, on the picture." },
  { at: { afterEndS: 15 }, caption: null, end: true },
];

/** Scenario-time cues whose moment lies in (prevT, t]. */
export function cuesBetween(cues: Cue[], prevT: number, t: number, toMillis: (clock: string) => number): Cue[] {
  return cues.filter((c) => typeof c.at === "string" && toMillis(c.at) > prevT && toMillis(c.at) <= t);
}

export function epilogue(cues: Cue[]): (Cue & { at: { afterEndS: number } })[] {
  return cues.filter((c): c is Cue & { at: { afterEndS: number } } => typeof c.at !== "string");
}
