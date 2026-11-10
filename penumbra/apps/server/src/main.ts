/**
 * PENUMBRA Phase 0 feed server.
 *
 *   pnpm dev                                      # default scenario, live at 1x
 *   pnpm feed --speed 4 --manual --port 9000
 */
import { formatClock } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { parseArgs } from "node:util";
import { DEFAULT_SCENARIO } from "./paths";
import { PenumbraServer } from "./server";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: DEFAULT_SCENARIO },
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    speed: { type: "string", default: "1" },
    seed: { type: "string" },
    manual: { type: "boolean", default: false },
    paused: { type: "boolean", default: false },
  },
});

const def = loadScenarioFile(values.scenario!);
const compiled = compileScenario(def, {
  ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
  manualOperator: values.manual!,
});
const server = new PenumbraServer({
  compiled,
  port: Number(values.port),
  host: values.host!,
  speed: Number(values.speed),
  autoplay: !values.paused,
});
const { url } = await server.start();
const m = compiled.meta;
console.log(`PENUMBRA feed · ${m.title} · seed ${m.seed}${values.manual ? " · manual operator" : ""}`);
console.log(`  ${compiled.events.length} events · playback ${formatClock(m.playFrom)} → ${formatClock(m.end)}${m.keyFrame ? ` · key frame ${formatClock(m.keyFrame)}` : ""}`);
console.log(`  websocket  ${url}`);
console.log(`  health     ${url.replace("ws://", "http://").replace("/ws", "/health")}`);
console.log(`  log export ${url.replace("ws://", "http://").replace("/ws", "/log.jsonl")}`);

const shutdown = () => void server.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
