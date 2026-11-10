/**
 * Marks on the replay timeline: the moments an operator would want to jump
 * back to. Derived from the log and the live picture; pure.
 */
import type { LogEvent, Millis, PictureSnapshot } from "@penumbra/core";

export interface TimelineMark {
  t: Millis;
  kind: "contradiction" | "decision" | "sensor" | "verdict" | "flag";
  label: string;
}

export function timelineMarks(log: readonly LogEvent[], live: PictureSnapshot | undefined): TimelineMark[] {
  const marks: TimelineMark[] = [];
  const obsSource = new Map<string, string>();
  for (const e of log) {
    if (e.kind === "observation") obsSource.set(e.obsId, e.sourceId);
    else if (e.kind === "source_status") marks.push({ t: e.t, kind: "sensor", label: `${e.sourceId} ${e.status.toUpperCase()}${e.note ? ` · ${e.note}` : ""}` });
    else if (e.kind === "verification") marks.push({ t: e.t, kind: "verdict", label: `${e.by} ${e.outcome} a ${obsSource.get(e.obsId) ?? "report"} report` });
  }
  if (live) {
    for (const a of live.operatorActions) {
      marks.push({ t: a.t, kind: "decision", label: `${a.operatorId} ${a.action === "resolve" ? `resolved ${a.contradictionId ?? ""} as ${a.value?.replaceAll("-", " ")}` : `deferred ${a.contradictionId ?? ""}`}`.replace(/\s+/g, " ") });
    }
    for (const c of live.contradictions) marks.push({ t: c.openedT, kind: "contradiction", label: `${c.id} opened · ${c.entityId} ${c.dimension.replaceAll("_", " ")}` });
    for (const f of live.flags) marks.push({ t: f.lastT, kind: "flag", label: `Deception flag · ${f.count} reports in ${f.spanS.toFixed(0)} s` });
  }
  return marks.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
}
