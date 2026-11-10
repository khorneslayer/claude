import { circlePolygon, EventLog, type DraftEvent, type LogEvent, type ObservationEvent, type ProjectionConfig } from "../src";

export const T0 = Date.UTC(2026, 8, 12, 14, 0, 0);
export const s = (sec: number) => T0 + sec * 1000;
export const CENTER = { lat: 52.36, lon: 13.5 };

export const testConfig: ProjectionConfig = {
  activeWeightEpsilon: 0.05,
  visibleConfidenceFloor: 0.02,
  contradictionIdStart: 1,
  defaultClass: "UAS",
  classes: {
    UAS: { cruiseSpeedMps: 15, maxSpeedMps: 23, headingPersistenceS: 5, enduranceS: 1800, ghostAfterS: 30, retainGhostS: 3600 },
  },
  deception: { lowReliabilityBelow: 0.5, minReports: 6, burstSpanS: 60, radiusM: 3000, retainS: 600, collapseFlaggedOrigins: true },
  operator: { resolutionIsEvidence: true, reliability: { alpha: 8, beta: 2 }, halfLifeS: 1800 },
};

/** Small fluent builder for hand-written logs. */
export class LogBuilder {
  readonly log = new EventLog();
  private obs = 0;

  constructor(config: ProjectionConfig = testConfig) {
    this.add({ kind: "config", t: T0, config });
  }

  add(e: DraftEvent): LogEvent {
    return this.log.append(e);
  }

  source(sourceId: string, opts: { type?: "RF" | "EO" | "CIV_CALL" | "SOCIAL"; alpha?: number; beta?: number; halfLifeS?: number; radiusM?: number } = {}) {
    this.add({
      kind: "source_registered",
      t: T0,
      sourceId,
      sourceType: opts.type ?? "RF",
      label: sourceId,
      prior: { alpha: opts.alpha ?? 9, beta: opts.beta ?? 1 },
      halfLifeS: opts.halfLifeS ?? 300,
      status: "up",
      ...(opts.radiusM ? { footprint: { outer: circlePolygon(CENTER, opts.radiusM) }, coverageLayers: ["uas"] } : {}),
    });
    return this;
  }

  report(
    t: number,
    sourceId: string,
    entityId: string,
    opts: { origin?: string; quality?: number; claims?: Record<string, string>; position?: { lat: number; lon: number } | null } = {},
  ): ObservationEvent {
    const pos = opts.position === null ? undefined : (opts.position ?? CENTER);
    return this.add({
      kind: "observation",
      t,
      obsId: `O${++this.obs}`,
      sourceId,
      originId: opts.origin ?? sourceId,
      entityId,
      correlation: "scripted",
      quality: opts.quality ?? 0.6,
      claims: opts.claims ?? {},
      extraction: "sensor",
      chain: ["INGEST"],
      ...(pos ? { position: { ...pos, sigmaM: 50 } } : {}),
    }) as ObservationEvent;
  }

  get events() {
    return this.log.all();
  }
}
