import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateScenario, type ScenarioDef } from "./scenario";

/** Parse and validate a scenario from YAML (or JSON, which is valid YAML). */
export function parseScenario(text: string): ScenarioDef {
  return validateScenario(parse(text));
}

export function loadScenarioFile(path: string): ScenarioDef {
  return parseScenario(readFileSync(path, "utf8"));
}
