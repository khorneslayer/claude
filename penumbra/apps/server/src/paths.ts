import { fileURLToPath } from "node:url";

export const DEFAULT_SCENARIO = fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url));

/** Default directory for session logs (git-ignored). */
export const SESSIONS_DIR = fileURLToPath(new URL("../../../sessions", import.meta.url));
