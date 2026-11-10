import {
  bearingDeg,
  circlePolygon,
  clockToMillis,
  createRng,
  destination,
  distanceM,
  offsetM,
  sectorPolygon,
  type DraftEvent,
  type Extraction,
  type LatLon,
  type LogEvent,
  type Millis,
  type ObservationEvent,
  type Polygon,
  type PositionEstimate,
  type ProjectionConfig,
  type Rng,
  type SourceType,
} from "@penumbra/core";
import type { FootprintDef, ScenarioDef, ShapeDef, SourceDef, WaypointDef } from "./scenario";

export interface ScenarioMeta {
  id: string;
  title: string;
  date: string;
  seed: number;
  area: { center: LatLon; label?: string };
  logStart: Millis;
  playFrom: Millis;
  keyFrame?: Millis;
  end: Millis;
}

export interface CompiledScenario {
  meta: ScenarioMeta;
  /** The complete, ordered event stream with sequence numbers. */
  events: LogEvent[];
}

export interface CompileOptions {
  /** Override the scenario's seed. */
  seed?: number;
  /** Drop scripted operator actions so a live operator makes the calls. */
  manualOperator?: boolean;
}

const DEFAULT_CHAIN: Record<SourceType, string[]> = {
  RF: ["INGEST", "CORRELATE", "FUSION OUT"],
  ADSB: ["INGEST", "CORRELATE", "FUSION OUT"],
  EO: ["INGEST", "CORRELATE", "FUSION OUT"],
  RADAR: ["INGEST", "CORRELATE", "FUSION OUT"],
  CIV_CALL: ["INGEST", "NL PARSE", "CORRELATE", "FUSION OUT"],
  SOCIAL: ["SCRAPE", "NL PARSE", "CORRELATE", "FUSION OUT"],
};
const DEFAULT_EXTRACTION: Record<SourceType, Extraction> = {
  RF: "sensor",
  ADSB: "sensor",
  EO: "sensor",
  RADAR: "sensor",
  CIV_CALL: "human",
  SOCIAL: "ai",
};

/** Ordering of simultaneous events: config, sources, status, observations, verdicts, operators. */
const PRIORITY: Record<DraftEvent["kind"], number> = {
  config: 0,
  source_registered: 1,
  source_status: 2,
  observation: 3,
  verification: 4,
  operator_action: 5,
};

interface Draft {
  event: DraftEvent;
  beat: number;
  sub: number;
  /** Report id for verify beats to reference. */
  ref?: string;
}

const r7 = (x: number) => Math.round(x * 1e7) / 1e7;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const tuple = (t: [number, number]): LatLon => ({ lat: t[0], lon: t[1] });

/**
 * Expand a scenario into its full event stream. Pure and deterministic: the
 * same definition and seed always produce byte-identical output.
 */
export function compileScenario(def: ScenarioDef, opts: CompileOptions = {}): CompiledScenario {
  const seed = opts.seed ?? def.seed;
  const rng = createRng(seed);
  const at = (clock: string) => clockToMillis(def.date, clock);
  const logStart = at(def.window.logStart);
  const sources = new Map(def.sources.map((s) => [s.id, s]));
  const drafts: Draft[] = [];

  const config: ProjectionConfig = {
    activeWeightEpsilon: def.config?.activeWeightEpsilon ?? 0.05,
    visibleConfidenceFloor: def.config?.visibleConfidenceFloor ?? 0.02,
    contradictionIdStart: def.config?.contradictionIdStart ?? 1,
    defaultClass: def.config?.defaultClass ?? Object.keys(def.classes)[0]!,
    classes: def.classes,
    deception: {
      lowReliabilityBelow: 0.5,
      minReports: 6,
      burstSpanS: 60,
      radiusM: 3000,
      retainS: 600,
      ...def.config?.deception,
    },
  };
  drafts.push({ event: { kind: "config", t: logStart, config }, beat: -2, sub: 0 });

  def.sources.forEach((s, i) => {
    const ev: DraftEvent = {
      kind: "source_registered",
      t: logStart,
      sourceId: s.id,
      sourceType: s.type,
      label: s.label ?? s.id,
      prior: { alpha: s.reliability.alpha, beta: s.reliability.beta },
      halfLifeS: s.halfLifeS,
      status: s.status ?? "up",
    };
    if (s.position) ev.position = tuple(s.position);
    if (s.footprint) ev.footprint = buildFootprint(s.footprint, s);
    if (s.coverageLayers) ev.coverageLayers = s.coverageLayers;
    drafts.push({ event: ev, beat: -1, sub: i });
  });

  const tracks = new Map(Object.entries(def.tracks ?? {}).map(([name, wps]) => [name, wps.map((w) => ({ ...w, t: at(w.at) }))]));
  const sampleTrack = (name: string, t: Millis) => sampleWaypoints(tracks.get(name)!, t);

  const observation = (
    beatRng: Rng,
    o: {
      source: string;
      origin?: string;
      entity: string;
      class?: string;
      sigmaM: number;
      quality: number;
      claims?: Record<string, string>;
      chain?: string[];
      extraction?: Extraction;
      bearingOnly?: { sigmaDeg: number };
      text?: string;
    },
    t: Millis,
    truth: { lat: number; lon: number; altM?: number },
    quality: number,
  ): Omit<ObservationEvent, "seq" | "obsId"> => {
    const src = sources.get(o.source)!;
    const ev: Omit<ObservationEvent, "seq" | "obsId"> = {
      kind: "observation",
      t,
      sourceId: o.source,
      originId: o.origin ?? o.source,
      entityId: o.entity,
      correlation: "scripted",
      quality: r3(Math.min(1, Math.max(0, quality))),
      claims: { ...(o.claims ?? {}) },
      extraction: o.extraction ?? DEFAULT_EXTRACTION[src.type],
      chain: o.chain ?? DEFAULT_CHAIN[src.type],
    };
    if (o.class) ev.entityClass = o.class;
    if (o.text !== undefined) ev.text = o.text;

    let pos: PositionEstimate;
    if (o.bearingOnly && src.position) {
      const origin = tuple(src.position);
      const trueBearing = bearingDeg(origin, truth);
      const measured = (trueBearing + beatRng.normal() * o.bearingOnly.sigmaDeg + 360) % 360;
      const range = distanceM(origin, truth);
      const p = destination(origin, measured, range);
      ev.bearing = { origin, bearingDeg: r3(measured), sigmaDeg: o.bearingOnly.sigmaDeg };
      pos = { lat: r7(p.lat), lon: r7(p.lon), sigmaM: r1(o.sigmaM) };
    } else {
      const p = offsetM(truth, beatRng.normal() * o.sigmaM, beatRng.normal() * o.sigmaM);
      pos = { lat: r7(p.lat), lon: r7(p.lon), sigmaM: r1(o.sigmaM) };
    }
    if (truth.altM !== undefined) pos.altM = Math.round(truth.altM);
    ev.position = pos;
    return ev;
  };

  def.beats.forEach((beat, b) => {
    const t0 = at(beat.at);
    const beatRng = rng.fork(`beat:${b}`);
    if ("report" in beat) {
      const r = beat.report;
      const truth = r.track ? sampleTrack(r.track, t0) : { ...tuple(r.position!), ...(r.altM !== undefined ? { altM: r.altM } : {}) };
      const d: Draft = { event: observation(beatRng, r, t0, truth, r.quality) as DraftEvent, beat: b, sub: 0 };
      if (r.id) d.ref = r.id;
      drafts.push(d);
    } else if ("periodic" in beat) {
      const p = beat.periodic;
      const until = at(p.until);
      const jitter = (p.jitterS ?? 0) * 1000;
      for (let k = 0; ; k++) {
        const nominal = t0 + k * p.everyS * 1000;
        if (nominal > until) break;
        const t = Math.round(Math.min(until, Math.max(t0, nominal + (jitter ? beatRng.range(-jitter, jitter) : 0))));
        const q = p.quality + (p.qualityJitter ? beatRng.range(-p.qualityJitter, p.qualityJitter) : 0);
        drafts.push({ event: observation(beatRng, p, t, sampleTrack(p.track, t), q) as DraftEvent, beat: b, sub: k });
      }
    } else if ("burst" in beat) {
      const u = beat.burst;
      const center = tuple(u.position);
      const texts = Array.isArray(u.text) ? u.text : u.text !== undefined ? [u.text] : [];
      // Arrival offsets: sorted uniform draws inside the span, so the burst is tight but not regular.
      const offsets = Array.from({ length: u.count }, () => beatRng.range(0, u.spanS * 1000)).sort((a, b) => a - b);
      offsets.forEach((off, k) => {
        const truth = offsetM(center, beatRng.normal() * u.scatterM, beatRng.normal() * u.scatterM);
        const ev = observation(
          beatRng,
          {
            source: u.source,
            origin: `${u.originPrefix}-${String(k + 1).padStart(2, "0")}`,
            entity: u.entity,
            ...(u.class ? { class: u.class } : {}),
            sigmaM: u.sigmaM,
            quality: u.quality,
            ...(u.claims ? { claims: u.claims } : {}),
            ...(u.chain ? { chain: u.chain } : {}),
            ...(u.extraction ? { extraction: u.extraction } : {}),
            ...(texts.length ? { text: texts[k % texts.length]! } : {}),
          },
          Math.round(t0 + off),
          truth,
          u.quality,
        );
        const d: Draft = { event: ev as DraftEvent, beat: b, sub: k };
        if (u.id) d.ref = `${u.id}.${k + 1}`;
        drafts.push(d);
      });
    } else if ("status" in beat) {
      const s = beat.status;
      const ev: DraftEvent = { kind: "source_status", t: t0, sourceId: s.source, status: s.status };
      if (s.note) ev.note = s.note;
      drafts.push({ event: ev, beat: b, sub: 0 });
    } else if ("verify" in beat) {
      const v = beat.verify;
      // obsId is filled in once ids are assigned.
      drafts.push({ event: { kind: "verification", t: t0, obsId: `@ref:${v.ref}`, outcome: v.outcome, by: v.by }, beat: b, sub: 0 });
    } else if ("operator" in beat) {
      if (opts.manualOperator) return;
      const o = beat.operator;
      const ev: DraftEvent = { kind: "operator_action", t: t0, operatorId: o.operator, action: o.action, entityId: o.entity, dimension: o.dimension };
      if (o.value !== undefined) ev.value = o.value;
      drafts.push({ event: ev, beat: b, sub: 0 });
    }
  });

  drafts.sort((a, b) => a.event.t - b.event.t || PRIORITY[a.event.kind] - PRIORITY[b.event.kind] || a.beat - b.beat || a.sub - b.sub);

  // Assign sequence numbers and observation ids in final order.
  const refToObs = new Map<string, { obsId: string; t: Millis }>();
  let obsCounter = 0;
  const events: LogEvent[] = drafts.map((d, i) => {
    const seq = i + 1;
    if (d.event.kind === "observation") {
      const obsId = `OBS-${String(++obsCounter).padStart(6, "0")}`;
      if (d.ref) refToObs.set(d.ref, { obsId, t: d.event.t });
      return { ...d.event, obsId, seq } as LogEvent;
    }
    return { ...d.event, seq } as LogEvent;
  });
  for (const e of events) {
    if (e.kind === "verification" && e.obsId.startsWith("@ref:")) {
      const ref = e.obsId.slice(5);
      const target = refToObs.get(ref);
      if (!target) throw new Error(`verify: no report with id "${ref}"`);
      if (target.t > e.t) throw new Error(`verify: "${ref}" is verified before it was reported`);
      (e as { obsId: string }).obsId = target.obsId;
    }
  }

  const meta: ScenarioMeta = {
    id: def.id,
    title: def.title,
    date: def.date,
    seed,
    area: { center: tuple(def.area.center), ...(def.area.label ? { label: def.area.label } : {}) },
    logStart,
    playFrom: at(def.window.playFrom),
    end: at(def.window.end),
  };
  if (def.window.keyFrame) meta.keyFrame = at(def.window.keyFrame);
  return { meta, events };
}

function sampleWaypoints(wps: (WaypointDef & { t: Millis })[], t: Millis): { lat: number; lon: number; altM?: number } {
  const first = wps[0]!;
  const last = wps[wps.length - 1]!;
  const pick = (w: WaypointDef) => ({ lat: w.lat, lon: w.lon, ...(w.altM !== undefined ? { altM: w.altM } : {}) });
  if (t <= first.t) return pick(first);
  if (t >= last.t) return pick(last);
  for (let i = 1; i < wps.length; i++) {
    const b = wps[i]!;
    if (t <= b.t) {
      const a = wps[i - 1]!;
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      const out: { lat: number; lon: number; altM?: number } = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      if (a.altM !== undefined && b.altM !== undefined) out.altM = a.altM + (b.altM - a.altM) * f;
      return out;
    }
  }
  return pick(last);
}

function shapeRing(s: ShapeDef, src: SourceDef): LatLon[] {
  const round = (ring: LatLon[]) => ring.map((p) => ({ lat: r7(p.lat), lon: r7(p.lon) }));
  if ("polygon" in s) return round(s.polygon.map(tuple));
  const body = "circle" in s ? s.circle : s.sector;
  const center = tuple(body.center ?? src.position!);
  if ("circle" in s) return round(circlePolygon(center, s.circle.radiusM));
  return round(sectorPolygon(center, s.sector.radiusM, s.sector.fromDeg, s.sector.toDeg));
}

function buildFootprint(f: FootprintDef, src: SourceDef): Polygon {
  const poly: Polygon = { outer: shapeRing(f, src) };
  if (f.holes?.length) poly.holes = f.holes.map((h) => shapeRing(h, src));
  return poly;
}
