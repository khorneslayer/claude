import { readFileSync } from "node:fs";
import { parseScenario } from "./parse";
import type { ScenarioDef } from "./scenario";

export { parseScenario };

export function loadScenarioFile(path: string): ScenarioDef {
  return parseScenario(readFileSync(path, "utf8"));
}
