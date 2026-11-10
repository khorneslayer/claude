/**
 * Print the picture at a moment in a scenario, as text.
 *
 *   pnpm frame                                  # key frame of the default scenario
 *   pnpm frame --at 14:39:30 --prov CAND-B
 *   pnpm frame --scenario path.yaml --seed 7 --manual
 *   pnpm frame --scenario mrb                   # KMRB low-cost key frame
 */
import { clockToMillis, project } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { parseArgs } from "node:util";
import { formatFrame } from "./format";
import { DEFAULT_SCENARIO, resolveScenario } from "./paths";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: DEFAULT_SCENARIO },
    at: { type: "string" },
    prov: { type: "string" },
    seed: { type: "string" },
    manual: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const def = loadScenarioFile(resolveScenario(values.scenario!));
const compiled = compileScenario(def, {
  ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
  manualOperator: values.manual!,
});
const t = values.at ? clockToMillis(def.date, values.at) : (compiled.meta.keyFrame ?? compiled.meta.end);
const snapshot = project(compiled.events, t);

if (values.json) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  const latestOpen = [...snapshot.contradictions].reverse().find((c) => c.status === "unresolved");
  const prov = values.prov ?? (latestOpen ? `${latestOpen.entityId}:CAND-A` : undefined);
  console.log(formatFrame(snapshot, { title: compiled.meta.title, ...(prov ? { provenanceFor: prov } : {}) }));
}
