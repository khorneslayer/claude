/**
 * Snapshot -> side panels (slide 7): contradiction register, source
 * reliability, provenance, and what the operator can do. Pure; unit-tested.
 */
import {
  formatClock,
  formatElapsed,
  isActionable,
  roundPreservingSum,
  type ConfidenceBreakdown,
  type Contribution,
  type ContradictionView,
  type EntityView,
  type HypothesisStatus,
  type ObservationEvent,
  type PictureSnapshot,
  type SourceType,
  type VerificationEvent,
} from "@penumbra/core";

export interface Lookups {
  obs: (obsId: string) => ObservationEvent | undefined;
  verdict: (obsId: string) => VerificationEvent | undefined;
}

/** What the provenance panel is showing: an entity, or one of its CAND hypotheses. */
export interface Selection {
  entityId: string;
  label?: string;
}

// ---------------------------------------------------------------- selection

/** Slide 7 opens on the newest open contradiction's leading candidate. */
export function defaultSelection(snap: PictureSnapshot): Selection | undefined {
  const open = [...snap.contradictions].reverse().find((c) => c.status === "unresolved" && c.hypotheses.some((h) => h.label));
  if (open) {
    const lead = open.hypotheses.find((h) => h.label === "CAND-A") ?? open.hypotheses.find((h) => h.label);
    return { entityId: open.entityId, ...(lead?.label ? { label: lead.label } : {}) };
  }
  const first = snap.entities.find((e) => !e.entityClass.startsWith("AIRCRAFT"));
  return first ? { entityId: first.id } : undefined;
}

/** Keep a selection valid as the picture changes: drop a hypothesis that is gone or rejected, drop an entity that left. */
export function reconcileSelection(sel: Selection | undefined, snap: PictureSnapshot): Selection | undefined {
  if (!sel) return undefined;
  const e = snap.entities.find((x) => x.id === sel.entityId);
  if (!e) return undefined;
  if (sel.label && !e.hypotheses.some((h) => h.label === sel.label && h.status !== "rejected")) return { entityId: e.id };
  return sel;
}

// ---------------------------------------------------------------- register

export interface RegisterCard {
  id: string;
  entityId: string;
  dimension: string;
  statusText: string;
  tone: "alert" | "parked" | "done";
  summary: string;
  hypotheses: { label?: string; value: string; confidence: number; status: HypothesisStatus }[];
  /** Selecting the card selects this candidate. */
  select: Selection;
}

const pretty = (v: string) => v.replace(/-(\d)/g, " $1").replaceAll("-", " ");
const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => NUMBER_WORDS[n] ?? String(n);

function who(types: Partial<Record<SourceType | "UNKNOWN", number>>, bearing: boolean): { text: string; plural: boolean } {
  const parts: string[] = [];
  let total = 0;
  for (const [t, n] of Object.entries(types) as [SourceType | "UNKNOWN", number][]) {
    total += n;
    const noun =
      t === "CIV_CALL" ? ["civilian call", "civilian calls"] : t === "SOCIAL" ? ["social post", "social posts"] : t === "OPERATOR" ? ["the operator", "operators"] : t === "RF" && bearing ? ["RF bearing", "RF bearings"] : [t, `${t} sensors`];
    parts.push(n === 1 ? (t === "OPERATOR" ? noun[0]! : t === "CIV_CALL" || t === "SOCIAL" ? `one ${noun[0]}` : noun[0]!) : `${count(n)} ${noun[1]}`);
  }
  return { text: parts.join(" and "), plural: total > 1 };
}

function assertedByBearing(e: EntityView | undefined, value: string, dim: string, look: Lookups): boolean {
  const h = e?.hypotheses.find((x) => x.dimension === dim && x.value === value);
  if (!h) return false;
  return h.confidence.contributions.some((c) => look.obs(c.obsId)?.bearing && look.obs(c.obsId)?.claims[dim] === value);
}

export function summarise(c: ContradictionView, snap: PictureSnapshot, look: Lookups): string {
  const e = snap.entities.find((x) => x.id === c.entityId);
  const n = c.hypotheses.length;
  const title =
    c.dimension === "altitude_band"
      ? `Altitude conflict, ${c.entityId}.`
      : c.dimension === "intent"
        ? `${count(n).charAt(0).toUpperCase() + count(n).slice(1)} hypotheses for one contact.`
        : `${n} hypotheses on ${pretty(c.dimension)}, ${c.entityId}.`;
  const claims = c.hypotheses
    .map((h, i) => {
      const w = who(h.assertedBySourceType, assertedByBearing(e, h.value, c.dimension, look));
      const text = i === 0 ? w.text.charAt(0).toUpperCase() + w.text.slice(1) : w.text;
      return `${text} ${w.plural ? "say" : "says"} ${pretty(h.value)}`;
    })
    .join("; ");
  const tail =
    c.status === "deferred"
      ? ` Deferred by ${c.actedBy}.`
      : c.status === "resolved"
        ? ` Resolved as ${pretty(c.resolvedValue ?? "")} by ${c.actedBy}.`
        : c.reopened
          ? " New evidence after the resolution: decide again."
          : c.status === "lapsed"
            ? " Support for all but one reading has decayed."
            : "";
  return `${title} ${claims}.${tail}`;
}

export function registerCards(snap: PictureSnapshot, look: Lookups): RegisterCard[] {
  return [...snap.contradictions].reverse().map((c) => {
    const since = formatElapsed((snap.t - c.statusSinceT) / 1000);
    const statusText =
      c.status === "deferred"
        ? `DEFERRED ${since}`
        : c.status === "resolved"
          ? `RESOLVED · ${pretty(c.resolvedValue ?? "").toUpperCase()}`
          : c.reopened
            ? `REOPENED ${since}`
            : c.status === "lapsed"
              ? "LAPSED"
              : "UNRESOLVED";
    const lead = c.hypotheses.find((h) => h.label === "CAND-A");
    return {
      id: c.id,
      entityId: c.entityId,
      dimension: c.dimension,
      statusText,
      tone: c.status === "unresolved" ? "alert" : c.status === "deferred" ? "parked" : "done",
      summary: summarise(c, snap, look),
      hypotheses: c.hypotheses.map((h) => ({ ...(h.label ? { label: h.label } : {}), value: h.value, confidence: h.confidence, status: h.status })),
      select: { entityId: c.entityId, ...(lead?.label ? { label: lead.label } : {}) },
    };
  });
}

// ---------------------------------------------------------------- sources

export interface SourceRow {
  id: string;
  label: string;
  reliability: number;
  tone: "high" | "mid" | "low";
  note: string;
}

export function sourceRows(snap: PictureSnapshot): SourceRow[] {
  return snap.sources.map((s) => ({
    id: s.id,
    label: s.label,
    reliability: s.reliability,
    tone: s.reliability >= 0.75 ? "high" : s.reliability >= 0.4 ? "mid" : "low",
    note: [s.status !== "up" ? s.status.toUpperCase() : "", s.confirmed || s.falsified ? `+${s.confirmed} −${s.falsified}` : "", s.type === "OPERATOR" ? "DECISIONS" : ""]
      .filter(Boolean)
      .join(" · "),
  }));
}

// ---------------------------------------------------------------- provenance

export interface ProvenanceRow {
  key: string;
  heading: string;
  tone: SourceType | "UNKNOWN";
  description: string;
  contribution: number;
  factors: string;
  quote?: string;
}

export interface OperatorAction {
  contradictionId?: string;
  entityId: string;
  dimension?: string;
  resolveValue?: string;
  canResolve: boolean;
  canDefer: boolean;
  /** Why the buttons are disabled, if they are. */
  hint?: string;
}

export interface ProvenanceView {
  title: string;
  subtitle: string;
  value: number;
  status?: HypothesisStatus;
  rows: ProvenanceRow[];
  chain: string[];
  action: OperatorAction;
}

function describe(c: Contribution, look: Lookups): string {
  if (c.members) return `One vote for ${c.members.length} coordinated accounts (deception flag).`;
  if (c.sourceType === "OPERATOR") return "Operator decision.";
  if (c.verified) {
    const v = look.verdict(c.obsId);
    return `Verified${v ? ` by ${v.by}` : ""}.`;
  }
  const o = look.obs(c.obsId);
  if (o?.bearing) return "Bearing only.";
  if (c.extraction === "ai") return `${c.reliability < 0.4 ? "Low reliability, " : ""}AI-extracted.`;
  if (c.sourceType === "CIV_CALL") return "Unverified voice report.";
  if (c.sourceType === "ADSB") return "Cooperative transponder report.";
  return o?.position ? `${c.sourceType} fix ±${Math.round(o.position.sigmaM)}m.` : `${c.sourceType} report.`;
}

function rowsFor(b: ConfidenceBreakdown, look: Lookups): ProvenanceRow[] {
  const { parts } = roundPreservingSum(b.contributions.map((c) => c.contribution));
  return b.contributions.map((c, i) => {
    const row: ProvenanceRow = {
      key: `${c.originId}:${c.obsId}`,
      heading: `${c.originId} · ${formatClock(c.t)}`,
      tone: c.sourceType,
      description: describe(c, look),
      contribution: parts[i]!,
      factors: `r ${c.reliability.toFixed(2)} × q ${c.quality.toFixed(2)} × decay ${c.decay.toFixed(2)}`,
    };
    if (c.text) row.quote = c.text;
    return row;
  });
}

/**
 * The processing chains behind a breakdown merged into one ordered path ending
 * at PENUMBRA. Steps that never occur in the same chain are alternatives and
 * are shown together: INGEST / SCRAPE → NL PARSE → CORRELATE → ...
 */
export function chainOf(b: ConfidenceBreakdown): string[] {
  const chains = [...new Map(b.contributions.map((c) => [c.chain.join(">"), c.chain])).values()];
  const out: string[] = [];
  for (const chain of chains) {
    chain.forEach((step, i) => {
      if (out.includes(step)) return;
      const later = chain.slice(i + 1).find((x) => out.includes(x));
      if (later === undefined) out.push(step);
      else out.splice(out.indexOf(later), 0, step);
    });
  }
  const together = (a: string, z: string) => chains.some((c) => c.includes(a) && c.includes(z));
  const merged: string[] = [];
  for (const step of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && !prev.split(" / ").some((p) => together(p, step))) merged[merged.length - 1] = `${prev} / ${step}`;
    else merged.push(step);
  }
  return [...merged, "PENUMBRA"];
}

export function provenance(sel: Selection, snap: PictureSnapshot, look: Lookups): ProvenanceView | undefined {
  const e = snap.entities.find((x) => x.id === sel.entityId);
  if (!e) return undefined;
  const h = sel.label ? e.hypotheses.find((x) => x.label === sel.label) : undefined;
  const breakdown = h ? h.confidence : e.confidence;

  const action: OperatorAction = { entityId: e.id, canResolve: false, canDefer: false };
  const open = snap.contradictions.filter((c) => c.entityId === e.id && isActionable(c));
  const c = h ? open.find((x) => x.dimension === h.dimension) : open[0];
  if (c) {
    action.contradictionId = c.id;
    action.dimension = c.dimension;
    action.canDefer = c.status === "unresolved";
    if (h && h.status !== "rejected") {
      action.canResolve = true;
      action.resolveValue = h.value;
    } else {
      action.hint = `Select a candidate of ${c.id} to resolve it.`;
    }
    if (!action.canDefer && c.status === "deferred") action.hint = action.hint ?? `${c.id} is deferred; resolve it when ready.`;
  } else {
    action.hint = "No open contradiction on this contact.";
  }

  const view: ProvenanceView = {
    title: h?.label ?? e.id,
    subtitle: h ? `${e.id} · ${pretty(h.dimension)} = ${pretty(h.value)}` : `${e.entityClass.replaceAll("_", " ")} · ${e.state.toUpperCase()} · ${e.sourceCount} SRC`,
    value: Math.round(breakdown.value * 100) / 100,
    rows: rowsFor(breakdown, look),
    chain: chainOf(breakdown),
    action,
  };
  if (h) view.status = h.status;
  return view;
}
