/**
 * Aggregate legibility-probe answers from session logs into the evidence table:
 * accuracy and median answer time, per view and per question, across participants.
 *
 *   pnpm probe:report                     # every session in ./sessions
 *   pnpm probe:report -- a.jsonl b.jsonl  # specific files (e.g. downloaded offline sessions)
 *
 * Answers carry the scenario they were given on (BER, KMRB, ...); answers from
 * before that field existed count as BER, the only scenario at the time.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProbeAnswerEvent {
  session?: string;
  kind: string;
  data?: { participant?: string; scenario?: string; view?: string; question?: string; correct?: boolean; latencyMs?: number; trial?: string };
}

interface Cell {
  n: number;
  correct: number;
  ms: number[];
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface ProbeReport {
  participants: number;
  answers: number;
  byView: Record<string, { n: number; accuracy: number; medianMs: number }>;
  byQuestion: Record<string, Record<string, { n: number; accuracy: number; medianMs: number }>>;
  /** Scenario id -> view -> result. */
  byScenario: Record<string, Record<string, { n: number; accuracy: number; medianMs: number }>>;
}

export const LEGACY_SCENARIO = "ber-south-uas-surge";

export function probeReport(events: ProbeAnswerEvent[]): ProbeReport {
  // Last answer per participant and trial wins (a participant who reloads and retries counts once).
  const latest = new Map<string, ProbeAnswerEvent>();
  for (const e of events) {
    if (e.kind !== "probe_answer" || !e.data?.view || !e.data.question) continue;
    latest.set(`${e.data.participant ?? e.session}\u0000${e.data.scenario ?? LEGACY_SCENARIO}\u0000${e.data.trial ?? `${e.data.view}-${e.data.question}`}`, e);
  }
  const answers = [...latest.values()];
  const cell = (): Cell => ({ n: 0, correct: 0, ms: [] });
  const views = new Map<string, Cell>();
  const questions = new Map<string, Map<string, Cell>>();
  const scenarios = new Map<string, Map<string, Cell>>();
  for (const a of answers) {
    const { view, question, correct, latencyMs } = a.data!;
    const sc = a.data!.scenario ?? LEGACY_SCENARIO;
    if (!scenarios.has(sc)) scenarios.set(sc, new Map());
    const sv = scenarios.get(sc)!;
    if (!sv.has(view!)) sv.set(view!, cell());
    const scell = sv.get(view!)!;
    scell.n++;
    if (correct) scell.correct++;
    if (typeof latencyMs === "number") scell.ms.push(latencyMs);
    for (const c of [views.get(view!) ?? (views.set(view!, cell()), views.get(view!)!)]) {
      c.n++;
      if (correct) c.correct++;
      if (typeof latencyMs === "number") c.ms.push(latencyMs);
    }
    if (!questions.has(question!)) questions.set(question!, new Map());
    const q = questions.get(question!)!;
    if (!q.has(view!)) q.set(view!, cell());
    const c = q.get(view!)!;
    c.n++;
    if (correct) c.correct++;
    if (typeof latencyMs === "number") c.ms.push(latencyMs);
  }
  const fmt = (c: Cell) => ({ n: c.n, accuracy: c.n ? c.correct / c.n : 0, medianMs: Math.round(median(c.ms)) });
  return {
    participants: new Set(answers.map((a) => a.data!.participant ?? a.session)).size,
    answers: answers.length,
    byView: Object.fromEntries([...views].map(([v, c]) => [v, fmt(c)])),
    byQuestion: Object.fromEntries([...questions].map(([q, m]) => [q, Object.fromEntries([...m].map(([v, c]) => [v, fmt(c)]))])),
    byScenario: Object.fromEntries([...scenarios].map(([sc, m]) => [sc, Object.fromEntries([...m].map(([v, c]) => [v, fmt(c)]))])),
  };
}

export function formatReport(r: ProbeReport): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const views = ["penumbra", "legacy"].filter((v) => r.byView[v]);
  const lines = [
    `Legibility probe · ${r.participants} participant(s) · ${r.answers} answers`,
    "",
    "| View | Answers | Correct | Median time |",
    "|---|---|---|---|",
    ...views.map((v) => `| ${v.toUpperCase()} | ${r.byView[v]!.n} | ${pct(r.byView[v]!.accuracy)} | ${s(r.byView[v]!.medianMs)} |`),
    "",
    "| Question | " + views.map((v) => `${v.toUpperCase()} correct · time`).join(" | ") + " |",
    "|---|" + views.map(() => "---|").join(""),
    ...Object.entries(r.byQuestion).map(([q, m]) => `| ${q.replaceAll("_", " ")} | ` + views.map((v) => (m[v] ? `${pct(m[v]!.accuracy)} · ${s(m[v]!.medianMs)}` : "–")).join(" | ") + " |"),
  ];
  // With more than one scenario (BER full network vs KMRB low-cost kit), compare them side by side.
  const scs = Object.keys(r.byScenario).sort();
  if (scs.length > 1) {
    lines.push(
      "",
      "| Scenario | " + views.map((v) => `${v.toUpperCase()} correct · time`).join(" | ") + " |",
      "|---|" + views.map(() => "---|").join(""),
      ...scs.map((sc) => `| ${sc} | ` + views.map((v) => (r.byScenario[sc]![v] ? `${pct(r.byScenario[sc]![v]!.accuracy)} · ${s(r.byScenario[sc]![v]!.medianMs)}` : "–")).join(" | ") + " |"),
    );
  }
  return lines.join("\n");
}

async function main() {
  const { SESSIONS_DIR } = await import("./paths");
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const files = args.length ? args : (await readdir(SESSIONS_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).map((f) => join(SESSIONS_DIR, f));
  const events: ProbeAnswerEvent[] = [];
  for (const f of files) {
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ProbeAnswerEvent);
      } catch {
        /* skip a malformed line */
      }
    }
  }
  const report = probeReport(events);
  if (report.answers === 0) {
    console.log(`No probe answers found in ${files.length} file(s). Run the probe at /?probe first.`);
    return;
  }
  console.log(formatReport(report));
}

if (process.argv[1] && /probe-report\.(ts|js)$/.test(process.argv[1])) void main();
