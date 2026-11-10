import { parse } from "yaml";
import { validateScenario, type ScenarioDef } from "./scenario";

/** Parse and validate a scenario from YAML (or JSON, which is valid YAML). Browser-safe. */
export function parseScenario(text: string): ScenarioDef {
  return validateScenario(parse(text));
}
