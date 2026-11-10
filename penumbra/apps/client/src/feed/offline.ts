import { clockToMillis, createRng, offsetM, validateOperatorAction, type DraftEvent, type LogEvent, type Millis, type OperatorActionRequest } from "@penumbra/core";
import { compileScenario, parseScenario, type CompiledScenario } from "@penumbra/sim/browser";
import scenarioText from "../../../../scenarios/ber-south-uas-surge.yaml?raw";
import type { FeedSource, FeedStore } from "./store";

const TICK_MS = 100;

/**
 * The same scenario compiled and played in the browser, for demos without a
 * server (screenshots, static hosting). Behaves like the server: the log only
 * grows as the clock passes events.
 */
export function startOffline(
  store: FeedStore,
  opts: { at?: string; speed?: number; paused?: boolean; stress?: number; scripted?: boolean } = {},
): FeedSource {
  // Interactive by default: decisions from playback onwards are the operator's.
  const compiled: CompiledScenario = compileScenario(parseScenario(scenarioText), { manualOperator: !opts.scripted });
  const { meta } = compiled;
  const events = opts.stress ? withStress(compiled, opts.stress) : compiled.events;
  let head = meta.playFrom;
  let next = 0;
  let playing = !opts.paused;
  let speed = opts.speed ?? 1;
  // Like the server: sequence numbers are assigned in publication order, so
  // operator actions can be appended at the head.
  let seq = 0;
  const stamp = (e: DraftEvent): LogEvent => ({ ...e, seq: ++seq }) as LogEvent;

  const publish = (t: Millis, reset = false) => {
    const batch: LogEvent[] = [];
    while (next < events.length && events[next]!.t <= t) {
      const { seq: _s, ...draft } = events[next++]!;
      batch.push(stamp(draft as DraftEvent));
    }
    if (batch.length || reset) store.onEvents(batch, reset);
  };
  const clock = () => store.onClock({ head, playing, speed, ended: head >= meta.end });
  const restart = (to: Millis) => {
    head = to;
    next = 0;
    seq = 0;
    publish(head, true);
  };

  store.onHello(meta, { head, playing, speed, ended: false });
  const startAt = opts.at ? clockToMillis(meta.date, opts.at) : meta.playFrom;
  restart(Math.min(meta.end, Math.max(meta.playFrom, startAt)));
  clock();

  const timer = setInterval(() => {
    if (!playing || head >= meta.end) return;
    head = Math.min(meta.end, head + TICK_MS * speed);
    publish(head);
    if (head >= meta.end) playing = false;
    clock();
  }, TICK_MS);

  const source: FeedSource = {
    kind: "offline",
    control: (cmd, s) => {
      if (cmd === "play") playing = head < meta.end;
      else if (cmd === "pause") playing = false;
      else if (cmd === "speed" && s) speed = s;
      else if (cmd === "restart") restart(meta.playFrom);
      clock();
    },
    act: async (req: OperatorActionRequest) => {
      const problem = validateOperatorAction(store.evaluate(head), req);
      if (problem) return problem;
      const draft: DraftEvent = {
        kind: "operator_action",
        t: head,
        operatorId: req.operatorId,
        action: req.action,
        entityId: req.entityId,
        dimension: req.dimension,
        ...(req.action === "resolve" && req.value !== undefined ? { value: req.value } : {}),
      };
      store.onEvents([stamp(draft)]);
      return undefined;
    },
    close: () => clearInterval(timer),
  };
  store.source = source;
  store.setStatus("offline");
  return source;
}

/**
 * Stress load for the 500-entity performance criterion: N synthetic drones,
 * each seen by three RF sensors every 4 s from 60 s before playback to the end.
 */
function withStress(compiled: CompiledScenario, n: number): LogEvent[] {
  const { meta, events } = compiled;
  const rng = createRng(4242);
  const sensors = ["RF-SENSE-N", "RF-SENSE-C", "RF-SENSE-S"];
  const extra: DraftEvent[] = [];
  for (let i = 0; i < n; i++) {
    const origin = offsetM(meta.area.center, rng.range(-6000, 6000), rng.range(-4500, 4500));
    const heading = rng.range(0, Math.PI * 2);
    const speed = rng.range(3, 14);
    for (let t = meta.playFrom - 60_000; t <= meta.end; t += 4000) {
      const dt = (t - meta.playFrom) / 1000;
      const p = offsetM(origin, Math.cos(heading) * speed * dt, Math.sin(heading) * speed * dt);
      sensors.forEach((sourceId, k) => {
        extra.push({
          kind: "observation",
          t: t + k * 300,
          obsId: `STRESS-${i}-${t}-${k}`,
          sourceId,
          originId: sourceId,
          entityId: `SYN-${String(i).padStart(4, "0")}`,
          correlation: "scripted",
          entityClass: "UAS_SMALL",
          quality: 0.5,
          claims: {},
          extraction: "sensor",
          chain: ["SYNTHETIC STRESS"],
          position: { lat: p.lat, lon: p.lon, sigmaM: 40 },
        });
      });
    }
  }
  const merged = [...events.map((e) => ({ e: e as DraftEvent, k: e.seq })), ...extra.map((e, i) => ({ e, k: 1e9 + i }))];
  merged.sort((a, b) => a.e.t - b.e.t || a.k - b.k);
  return merged.map(({ e }, i) => ({ ...e, seq: i + 1 }) as LogEvent);
}
