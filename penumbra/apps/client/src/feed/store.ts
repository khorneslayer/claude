import { Projector, type LogEvent, type Millis, type ObservationEvent, type PictureSnapshot } from "@penumbra/core";
import type { ClockState, ControlMsg, ScenarioMeta } from "@penumbra/sim/browser";

export type FeedStatus = "connecting" | "live" | "offline" | "disconnected";

export interface FeedSource {
  readonly kind: "live" | "offline";
  control(cmd: ControlMsg["command"], speed?: number): void;
  close(): void;
}

/**
 * Client-side copy of the log plus its own Projector. Evaluating locally means
 * confidence decays and envelopes grow continuously on screen, not in 4 Hz
 * steps, and the scrubber (M4) needs no round trip.
 */
export class FeedStore {
  status: FeedStatus = "connecting";
  meta: ScenarioMeta | undefined;
  clock: ClockState | undefined;
  private clockAt = 0;
  private events: LogEvent[] = [];
  private readonly obs = new Map<string, ObservationEvent>();
  private projector = new Projector();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  source: FeedSource | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  setStatus(status: FeedStatus) {
    this.status = status;
    this.emit();
  }

  onHello(meta: ScenarioMeta, clock: ClockState) {
    this.meta = meta;
    this.onClock(clock);
  }

  onClock(clock: ClockState) {
    this.clock = clock;
    this.clockAt = performance.now();
    this.emit();
  }

  onEvents(events: readonly LogEvent[], reset = false) {
    if (reset) {
      this.events = [];
      this.obs.clear();
      this.projector = new Projector();
    }
    for (const e of events) {
      this.events.push(e);
      if (e.kind === "observation") this.obs.set(e.obsId, e);
      this.projector.apply(e);
    }
    this.emit();
  }

  lookupObs = (obsId: string) => this.obs.get(obsId);

  get log(): readonly LogEvent[] {
    return this.events;
  }

  /** Best estimate of the live head right now, extrapolated from the last clock message. */
  headNow(nowPerf = performance.now()): Millis | undefined {
    const c = this.clock;
    if (!c || !this.meta) return undefined;
    const t = c.playing ? c.head + (nowPerf - this.clockAt) * c.speed : c.head;
    return Math.max(this.projector.appliedT, Math.min(this.meta.end, t));
  }

  /** The live picture at `t` (never before the last applied event). */
  evaluate(t: Millis): PictureSnapshot {
    return this.projector.evaluate(Math.max(t, this.projector.appliedT));
  }

  control(cmd: ControlMsg["command"], speed?: number) {
    this.source?.control(cmd, speed);
  }
}
