/**
 * Scenarios the client can play offline. The live feed announces its own
 * scenario (meta.id); the basemap and demo script follow that id either way.
 *
 *   ?scenario=ber   Berlin Brandenburg, full sensor network (default)
 *   ?scenario=mrb   KMRB regional airport, low-cost commercial kit
 */
import berText from "../../../scenarios/ber-south-uas-surge.yaml?raw";
import mrbText from "../../../scenarios/mrb-lowcost-approach.yaml?raw";

export const SCENARIOS = {
  ber: { id: "ber-south-uas-surge", text: berText },
  mrb: { id: "mrb-lowcost-approach", text: mrbText },
} as const;

export type ScenarioKey = keyof typeof SCENARIOS;

/** Accepts the short key or the full scenario id; unknown values fall back to BER. */
export function scenarioKey(param: string | null | undefined): ScenarioKey {
  const hit = (Object.keys(SCENARIOS) as ScenarioKey[]).find((k) => k === param || SCENARIOS[k].id === param);
  return hit ?? "ber";
}
