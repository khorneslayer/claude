import { fileURLToPath } from "node:url";

export const DEFAULT_SCENARIO = fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url));
