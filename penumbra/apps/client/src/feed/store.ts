import {
  Projector,
  type LogEvent,
  type Millis,
  type ObservationEvent,
  type OperatorActionRequest,
  type PictureSnapshot,
  type VerificationEvent,
} from "@penumbra/core";
import type { ClockState, ControlMsg, ScenarioMeta } from "@penumbra/sim/browser";

export type FeedStatus = "connecting" | "live" | "offline" | "disconnected";

export interface FeedSource {
  readonly kind: "live" | "offline";
  control(cmd: ControlMsg["command"], speed?: number): void;
  /** Take an operator action. Resolves to an error message, or undefined on success. */
  act(req: OperatorActionRequest): Promise<string | undefined>;
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
  private readonly verdicts = new Map<string, VerificationEvent>();
  private projector = new Projector();
  /** Separate projector for replay: steps forward while the scrubber moves forward, rebuilds when it moves back. */
  private replay: { projector: Projector; next: number } | undefined;
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
      this.verdicts.clear();
      this.projector = new Projector();
      this.replay = undefined;
    }
    for (const e of events) {
      this.events.push(e);
      if (e.kind === "observation") this.obs.set(e.obsId, e);
      else if (e.kind === "verification" && !this.verdicts.has(e.obsId)) this.verdicts.set(e.obsId, e);
      this.projector.apply(e);
    }
    this.emit();
  }

  lookupObs = (obsId: string) => this.obs.get(obsId);
  lookupVerdict = (obsId: string) => this.verdicts.get(obsId);

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

  /**
   * The picture exactly as it stood at a past moment `t`, rebuilt from the log
   * the client holds: events after `t`, including later operator decisions,
   * are not seen. No server round trip.
   */
  snapshotAt(t: Millis): PictureSnapshot {
    let r = this.replay;
    if (!r || r.projector.appliedT > t) r = this.replay = { projector: new Projector(), next: 0 };
    while (r.next < this.events.length && this.events[r.next]!.t <= t) r.projector.apply(this.events[r.next++]!);
    return r.projector.evaluate(t);
  }

  /** First and last moment the log covers. */
  get logRange(): { start: Millis; end: Millis } | undefined {
    if (this.events.length === 0) return undefined;
    return { start: this.events[0]!.t, end: this.events[this.events.length - 1]!.t };
  }

  /** The live picture at `t` (never before the last applied event). */
  evaluate(t: Millis): PictureSnapshot {
    return this.projector.evaluate(Math.max(t, this.projector.appliedT));
  }

  control(cmd: ControlMsg["command"], speed?: number) {
    this.source?.control(cmd, speed);
  }

  act(req: OperatorActionRequest): Promise<string | undefined> {
    return this.source ? this.source.act(req) : Promise.resolve("not connected");
  }
}
