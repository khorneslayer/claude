import {
  formatClock,
  formatElapsed,
  roundPreservingSum,
  type ContradictionView,
  type EntityView,
  type PictureSnapshot,
} from "@penumbra/core";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const f2 = (x: number) => x.toFixed(2);
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);

/** Plain-text rendering of a snapshot, for review before the map client exists. */
export function formatFrame(s: PictureSnapshot, opts: { title?: string; provenanceFor?: string } = {}): string {
  const out: string[] = [];
  const health = s.feedHealth
    .map((h) => `${h.sourceType} ${h.status === "ok" ? "OK" : `${h.up}/${h.total} ${h.status.toUpperCase()}`}`)
    .join("  |  ");
  out.push(`PENUMBRA  ${opts.title ?? ""}  ${formatClock(s.t)}  (log seq ${s.logSeq})`);
  out.push(`FEEDS     ${health}`);
  out.push("");

  out.push("CONTRADICTION REGISTER");
  if (s.contradictions.length === 0) out.push("  (none)");
  for (const c of [...s.contradictions].reverse()) out.push(...formatContradiction(c, s.t));
  out.push("");

  out.push("SOURCE RELIABILITY");
  for (const src of s.sources) {
    const bar = "#".repeat(Math.round(src.reliability * 20));
    const verdicts = src.confirmed || src.falsified ? `  (+${src.confirmed}/-${src.falsified})` : "";
    out.push(`  ${pad(src.label, 16)} ${f2(src.reliability)} ${pad(bar, 20)} ${src.status === "up" ? "" : src.status.toUpperCase()}${verdicts}`);
  }
  out.push("");

  out.push("PICTURE");
  for (const e of s.entities) out.push(...formatEntity(e, s.t));
  out.push("");

  if (s.flags.length) {
    out.push("FLAGS");
    for (const f of s.flags) out.push(`  DECEPTION FLAG  ${f.reason.replaceAll("_", " ")} · ${f.count} REPORTS in ${f.spanS.toFixed(0)}s · ${f.entityIds.join(", ")}`);
    out.push("");
  }

  out.push("COVERAGE (uas layer)");
  out.push(`  seeing: ${s.coverage.active.filter((c) => c.layers.includes("uas")).map((c) => c.sourceId + (c.status === "degraded" ? " (degraded)" : "")).join(", ") || "-"}`);
  out.push(`  lost:   ${s.coverage.lost.filter((c) => c.layers.includes("uas")).map((c) => c.sourceId).join(", ") || "-"}`);

  const focus = opts.provenanceFor;
  if (focus) {
    out.push("");
    out.push(...formatProvenance(s, focus));
  }
  return out.join("\n");
}

function formatContradiction(c: ContradictionView, now: number): string[] {
  const status =
    c.status === "deferred"
      ? `DEFERRED ${formatElapsed((now - c.statusSinceT) / 1000)} by ${c.actedBy}`
      : c.status === "resolved"
        ? `RESOLVED → ${c.resolvedValue} by ${c.actedBy}`
        : c.status.toUpperCase();
  const hyps = c.hypotheses
    .map((h) => {
      const who = Object.entries(h.assertedBySourceType)
        .map(([t, n]) => `${t}×${n}`)
        .join(" ");
      return `${h.label ?? h.value} ${h.value} ${f2(h.confidence)} [${who}]${h.live ? "" : " (stale)"}`;
    })
    .join("  vs  ");
  return [`  ${c.id} · ${status}  ${c.entityId} ${c.dimension}`, `      ${hyps}`];
}

function formatEntity(e: EntityView, now: number): string[] {
  const lines: string[] = [];
  const age = e.fixAgeS !== undefined ? (e.fixAgeS < 90 ? `${Math.round(e.fixAgeS)}s` : `${Math.round(e.fixAgeS / 60)}m`) : "-";
  const where = e.position ? `${e.position.lat.toFixed(4)},${e.position.lon.toFixed(4)} ±${km(e.position.sigmaM)}` : "no fix";
  const head =
    e.state === "ghost"
      ? `GHOST  last conf ${age} · envelope ${km(e.envelopeRadiusM ?? 0)} (reach ${km(e.maxReachM ?? 0)}) · conf now ${f2(e.confidence.value)} (at last fix ${f2(e.confidenceAtLastFix ?? 0)})`
      : `CONF ${f2(e.confidence.value)} · ${e.sourceCount} SRC · ${age}`;
  lines.push(`  ${pad(e.id, 9)} ${pad(e.entityClass, 15)} ${head}`);
  lines.push(`  ${pad("", 9)} ${where}${e.flags.length ? "  [" + e.flags.join(", ") + "]" : ""}`);
  for (const h of e.hypotheses.filter((h) => h.label)) {
    const who = h.assertedBy.map((a) => a.sourceType).join("+");
    lines.push(`  ${pad("", 9)} ${h.label} · ${h.value.toUpperCase()} CONF ${f2(h.confidence.value)} · asserted by ${who}`);
  }
  void now;
  return lines;
}

function formatProvenance(s: PictureSnapshot, target: string): string[] {
  // Accept an entity id, "ENTITY:CAND-x", or a bare CAND-x (first open contradiction that has it).
  const [entityPart, labelPart] = target.includes(":") ? target.split(":") : target.startsWith("CAND-") ? [undefined, target] : [target, undefined];
  const open = s.contradictions.filter((c) => c.status === "unresolved" || c.status === "deferred").map((c) => c.entityId);
  const ordered = [...s.entities].sort((a, b) => open.lastIndexOf(b.id) - open.lastIndexOf(a.id));
  for (const e of ordered) {
    if (entityPart && e.id !== entityPart) continue;
    const h = labelPart ? e.hypotheses.find((x) => x.label === labelPart) : undefined;
    if (labelPart && !h) continue;
    const breakdown = h ? h.confidence : e.confidence;
    const { parts, total } = roundPreservingSum(breakdown.contributions.map((c) => c.contribution));
    const lines = [`PROVENANCE · ${h?.label ?? e.id}${h ? ` (${e.id} ${h.dimension}=${h.value})` : ""}`, `  ${total.toFixed(2)}   computed, not stored`];
    breakdown.contributions.forEach((c, i) => {
      lines.push(
        `  ${pad(c.originId, 13)} ${pad(c.sourceType, 8)} ${formatClock(c.t)}  +${parts[i]!.toFixed(2)}   r ${f2(c.reliability)} × q ${f2(c.quality)} × decay ${f2(c.decay)} = w ${f2(c.weight)}  ${c.extraction}${c.verified ? " VERIFIED" : ""}`,
      );
      if (c.text) lines.push(`  ${pad("", 13)} "${c.text}"`);
    });
    const chain = breakdown.contributions[0]?.chain;
    if (chain) lines.push(`  CHAIN  ${[...chain, "PENUMBRA"].join(" → ")}`);
    return lines;
  }
  return [`PROVENANCE · ${target}: not on the picture`];
}
