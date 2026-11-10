import { fileURLToPath } from "node:url";

export const DEFAULT_SCENARIO = fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url));

/** Short names for the bundled scenarios, so `--scenario mrb` works as well as a path. */
const SHORT: Record<string, string> = {
  ber: DEFAULT_SCENARIO,
  mrb: fileURLToPath(new URL("../../../scenarios/mrb-lowcost-approach.yaml", import.meta.url)),
};

export function resolveScenario(arg: string): string {
  return SHORT[arg] ?? arg;
}

/** Default directory for session logs (git-ignored). */
export const SESSIONS_DIR = fileURLToPath(new URL("../../../sessions", import.meta.url));
