import type { EntityClassParams, Extraction, ProjectionConfig, SourceStatus, SourceType } from "@penumbra/core";

/**
 * Designer-facing scenario format. Authored in YAML; see
 * scenarios/ber-south-uas-surge.yaml for a worked example.
 *
 * Conventions: times are "HH:MM:SS" (UTC) on `date`; positions are [lat, lon].
 */
export type LatLonTuple = [number, number];

export interface ScenarioDef {
  id: string;
  title: string;
  date: string;
  seed: number;
  window: {
    /** First event in the log. History before playFrom is "the system was already running". */
    logStart: string;
    /** Where live playback starts. */
    playFrom: string;
    /** The frame the demo is built around (optional). */
    keyFrame?: string;
    end: string;
  };
  area: { center: LatLonTuple; label?: string };
  config?: Partial<Omit<ProjectionConfig, "classes">>;
  classes: Record<string, EntityClassParams>;
  sources: SourceDef[];
  tracks?: Record<string, WaypointDef[]>;
  beats: BeatDef[];
}

export interface SourceDef {
  id: string;
  type: SourceType;
  label?: string;
  reliability: { alpha: number; beta: number };
  halfLifeS: number;
  position?: LatLonTuple;
  status?: SourceStatus;
  coverageLayers?: string[];
  footprint?: FootprintDef;
}

export interface CircleDef {
  center?: LatLonTuple;
  radiusM: number;
}
export interface SectorDef extends CircleDef {
  fromDeg: number;
  toDeg: number;
}
export type ShapeDef = { circle: CircleDef } | { sector: SectorDef } | { polygon: LatLonTuple[] };
export type FootprintDef = ShapeDef & { holes?: ShapeDef[] };

export interface WaypointDef {
  at: string;
  lat: number;
  lon: number;
  altM?: number;
}

interface ObservationCommon {
  source: string;
  /** Independence unit. Defaults to the source id. */
  origin?: string;
  entity: string;
  class?: string;
  sigmaM: number;
  quality: number;
  claims?: Record<string, string>;
  chain?: string[];
  extraction?: Extraction;
  /** Record the fix as a bearing from the source's position with this 1-sigma error. */
  bearingOnly?: { sigmaDeg: number };
}

export interface ReportDef extends ObservationCommon {
  /** Lets `verify` beats refer to this report. */
  id?: string;
  /** Sample position from this track... */
  track?: string;
  /** ...or give it directly. */
  position?: LatLonTuple;
  altM?: number;
  text?: string;
}

export interface PeriodicDef extends ObservationCommon {
  track: string;
  until: string;
  everyS: number;
  jitterS?: number;
  qualityJitter?: number;
}

export interface BurstDef {
  id?: string;
  source: string;
  entity: string;
  class?: string;
  count: number;
  /** All reports arrive within this many seconds of the beat time. */
  spanS: number;
  position: LatLonTuple;
  scatterM: number;
  sigmaM: number;
  quality: number;
  claims?: Record<string, string>;
  originPrefix: string;
  chain?: string[];
  extraction?: Extraction;
  text?: string | string[];
}

export interface StatusDef {
  source: string;
  status: SourceStatus;
  note?: string;
}

export interface VerifyDef {
  ref: string;
  outcome: "confirmed" | "falsified";
  by: string;
}

export interface OperatorDef {
  operator: string;
  action: "resolve" | "defer";
  entity: string;
  dimension: string;
  value?: string;
}

export type BeatDef = { at: string; note?: string } & (
  | { report: ReportDef }
  | { periodic: PeriodicDef }
  | { burst: BurstDef }
  | { status: StatusDef }
  | { verify: VerifyDef }
  | { operator: OperatorDef }
);

export const BEAT_KINDS = ["report", "periodic", "burst", "status", "verify", "operator"] as const;
export type BeatKind = (typeof BEAT_KINDS)[number];

// ---------------------------------------------------------------------------
// Validation: structural checks with messages a designer can act on.
// ---------------------------------------------------------------------------

const SOURCE_TYPES: SourceType[] = ["RF", "ADSB", "EO", "RADAR", "CIV_CALL", "SOCIAL"];
const STATUSES: SourceStatus[] = ["up", "degraded", "down"];
const CLOCK = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/;

export class ScenarioError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Scenario is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ScenarioError";
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isLatLon = (v: unknown): v is LatLonTuple =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180;

/** Validate a parsed YAML/JSON value and return it typed. Throws ScenarioError listing every problem. */
export function validateScenario(raw: unknown): ScenarioDef {
  const p: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) p.push(msg);
    return cond;
  };
  if (!isObj(raw)) throw new ScenarioError(["scenario must be a mapping"]);

  need(isStr(raw.id), "id: required string");
  need(isStr(raw.title), "title: required string");
  need(typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date), 'date: required, "YYYY-MM-DD"');
  need(Number.isInteger(raw.seed), "seed: required integer");

  const w = raw.window;
  if (need(isObj(w), "window: required mapping")) {
    const win = w as Obj;
    for (const k of ["logStart", "playFrom", "end"]) need(typeof win[k] === "string" && CLOCK.test(win[k] as string), `window.${k}: required "HH:MM:SS"`);
    if (win.keyFrame !== undefined) need(typeof win.keyFrame === "string" && CLOCK.test(win.keyFrame), 'window.keyFrame: "HH:MM:SS"');
  }
  need(isObj(raw.area) && isLatLon((raw.area as Obj).center), "area.center: required [lat, lon]");

  const classes = raw.classes;
  if (need(isObj(classes) && Object.keys(classes).length > 0, "classes: at least one entity class")) {
    for (const [name, c] of Object.entries(classes as Obj)) {
      for (const k of ["cruiseSpeedMps", "maxSpeedMps", "headingPersistenceS", "enduranceS", "ghostAfterS", "retainGhostS"]) {
        need(isObj(c) && isNum(c[k]) && (c[k] as number) >= 0, `classes.${name}.${k}: required non-negative number`);
      }
    }
  }
  const classNames = new Set(isObj(classes) ? Object.keys(classes) : []);

  const sourceIds = new Set<string>();
  if (need(Array.isArray(raw.sources) && raw.sources.length > 0, "sources: at least one source")) {
    (raw.sources as unknown[]).forEach((s, i) => {
      const at = `sources[${i}]`;
      if (!need(isObj(s), `${at}: must be a mapping`)) return;
      const src = s as Obj;
      if (need(isStr(src.id), `${at}.id: required`)) {
        need(!sourceIds.has(src.id as string), `${at}.id: duplicate "${src.id as string}"`);
        sourceIds.add(src.id as string);
      }
      need(SOURCE_TYPES.includes(src.type as SourceType), `${at}.type: one of ${SOURCE_TYPES.join(", ")}`);
      need(
        isObj(src.reliability) && isNum(src.reliability.alpha) && isNum(src.reliability.beta) && src.reliability.alpha > 0 && src.reliability.beta > 0,
        `${at}.reliability: { alpha > 0, beta > 0 }`,
      );
      need(isNum(src.halfLifeS) && src.halfLifeS > 0, `${at}.halfLifeS: positive number`);
      if (src.position !== undefined) need(isLatLon(src.position), `${at}.position: [lat, lon]`);
      if (src.status !== undefined) need(STATUSES.includes(src.status as SourceStatus), `${at}.status: up | degraded | down`);
      if (src.footprint !== undefined) {
        checkShape(src.footprint, `${at}.footprint`, src.position !== undefined, p);
        const holes = isObj(src.footprint) ? src.footprint.holes : undefined;
        if (holes !== undefined) {
          if (need(Array.isArray(holes), `${at}.footprint.holes: list`)) (holes as unknown[]).forEach((h, k) => checkShape(h, `${at}.footprint.holes[${k}]`, src.position !== undefined, p));
        }
      }
    });
  }

  const trackNames = new Set<string>();
  if (raw.tracks !== undefined && need(isObj(raw.tracks), "tracks: mapping of name -> waypoints")) {
    for (const [name, wps] of Object.entries(raw.tracks as Obj)) {
      trackNames.add(name);
      if (!need(Array.isArray(wps) && wps.length > 0, `tracks.${name}: at least one waypoint`)) continue;
      (wps as unknown[]).forEach((wp, k) => {
        need(isObj(wp) && typeof wp.at === "string" && CLOCK.test(wp.at) && isNum(wp.lat) && isNum(wp.lon), `tracks.${name}[${k}]: { at: "HH:MM:SS", lat, lon }`);
      });
    }
  }

  const reportIds = new Set<string>();
  if (need(Array.isArray(raw.beats), "beats: list")) {
    (raw.beats as unknown[]).forEach((b, i) => {
      const at = `beats[${i}]`;
      if (!need(isObj(b), `${at}: must be a mapping`)) return;
      const beat = b as Obj;
      need(typeof beat.at === "string" && CLOCK.test(beat.at), `${at}.at: required "HH:MM:SS"`);
      const kinds = BEAT_KINDS.filter((k) => k in beat);
      if (!need(kinds.length === 1, `${at}: exactly one of ${BEAT_KINDS.join(", ")} (found ${kinds.length})`)) return;
      const kind = kinds[0]!;
      const body = beat[kind];
      if (!need(isObj(body), `${at}.${kind}: must be a mapping`)) return;
      const d = body as Obj;
      const where = `${at}.${kind}`;
      const checkSource = () => need(sourceIds.has(d.source as string), `${where}.source: unknown source "${String(d.source)}"`);
      const checkObs = () => {
        checkSource();
        need(isStr(d.entity), `${where}.entity: required`);
        need(isNum(d.sigmaM) && d.sigmaM >= 0, `${where}.sigmaM: non-negative number`);
        need(isNum(d.quality) && d.quality >= 0 && d.quality <= 1, `${where}.quality: number in [0, 1]`);
        if (d.class !== undefined) need(classNames.has(d.class as string), `${where}.class: unknown class "${String(d.class)}"`);
        if (d.claims !== undefined) need(isObj(d.claims) && Object.values(d.claims).every(isStr), `${where}.claims: mapping of dimension -> value`);
        if (d.bearingOnly !== undefined) {
          need(isObj(d.bearingOnly) && isNum(d.bearingOnly.sigmaDeg), `${where}.bearingOnly: { sigmaDeg }`);
          const src = (raw.sources as Obj[]).find((s) => s.id === d.source);
          need(src?.position !== undefined, `${where}.bearingOnly: source "${String(d.source)}" needs a position`);
        }
      };
      switch (kind) {
        case "report":
          checkObs();
          need((d.track !== undefined) !== (d.position !== undefined), `${where}: exactly one of track, position`);
          if (d.track !== undefined) need(trackNames.has(d.track as string), `${where}.track: unknown track "${String(d.track)}"`);
          if (d.position !== undefined) need(isLatLon(d.position), `${where}.position: [lat, lon]`);
          if (d.id !== undefined) {
            need(isStr(d.id) && !reportIds.has(d.id), `${where}.id: must be a unique string`);
            reportIds.add(d.id as string);
          }
          break;
        case "periodic":
          checkObs();
          need(trackNames.has(d.track as string), `${where}.track: unknown track "${String(d.track)}"`);
          need(typeof d.until === "string" && CLOCK.test(d.until), `${where}.until: "HH:MM:SS"`);
          need(isNum(d.everyS) && d.everyS > 0, `${where}.everyS: positive number`);
          break;
        case "burst":
          checkSource();
          need(isStr(d.entity), `${where}.entity: required`);
          need(Number.isInteger(d.count) && (d.count as number) > 0, `${where}.count: positive integer`);
          need(isNum(d.spanS) && d.spanS >= 0, `${where}.spanS: non-negative number`);
          need(isLatLon(d.position), `${where}.position: [lat, lon]`);
          need(isNum(d.scatterM) && isNum(d.sigmaM), `${where}: scatterM and sigmaM required`);
          need(isNum(d.quality) && d.quality >= 0 && d.quality <= 1, `${where}.quality: number in [0, 1]`);
          need(isStr(d.originPrefix), `${where}.originPrefix: required`);
          if (d.id !== undefined && isStr(d.id) && Number.isInteger(d.count)) for (let k = 1; k <= (d.count as number); k++) reportIds.add(`${d.id}.${k}`);
          break;
        case "status":
          checkSource();
          need(STATUSES.includes(d.status as SourceStatus), `${where}.status: up | degraded | down`);
          break;
        case "verify":
          need(isStr(d.ref), `${where}.ref: required`);
          need(d.outcome === "confirmed" || d.outcome === "falsified", `${where}.outcome: confirmed | falsified`);
          need(isStr(d.by), `${where}.by: required`);
          break;
        case "operator":
          need(isStr(d.operator), `${where}.operator: required`);
          need(d.action === "resolve" || d.action === "defer", `${where}.action: resolve | defer`);
          need(isStr(d.entity) && isStr(d.dimension), `${where}: entity and dimension required`);
          if (d.action === "resolve") need(isStr(d.value), `${where}.value: required for resolve`);
          break;
      }
    });
    // verify refs are checked after all ids are known (a verify may only follow its report in time; checked at compile)
    (raw.beats as Obj[]).forEach((b, i) => {
      if (isObj(b) && isObj(b.verify) && isStr(b.verify.ref)) need(reportIds.has(b.verify.ref), `beats[${i}].verify.ref: no report with id "${b.verify.ref}"`);
    });
  }

  if (p.length > 0) throw new ScenarioError(p);
  return raw as unknown as ScenarioDef;
}

function checkShape(s: unknown, at: string, hasSourcePosition: boolean, p: string[]) {
  if (!isObj(s)) {
    p.push(`${at}: must be a mapping`);
    return;
  }
  const kinds = ["circle", "sector", "polygon"].filter((k) => k in s);
  if (kinds.length !== 1) {
    p.push(`${at}: exactly one of circle, sector, polygon`);
    return;
  }
  const k = kinds[0]!;
  const body = s[k];
  if (k === "polygon") {
    if (!Array.isArray(body) || body.length < 3 || !body.every(isLatLon)) p.push(`${at}.polygon: at least 3 [lat, lon] points`);
    return;
  }
  if (!isObj(body) || !isNum(body.radiusM) || body.radiusM <= 0) p.push(`${at}.${k}.radiusM: positive number`);
  if (isObj(body) && body.center === undefined && !hasSourcePosition) p.push(`${at}.${k}.center: required when the source has no position`);
  if (isObj(body) && body.center !== undefined && !isLatLon(body.center)) p.push(`${at}.${k}.center: [lat, lon]`);
  if (k === "sector" && (!isObj(body) || !isNum(body.fromDeg) || !isNum(body.toDeg))) p.push(`${at}.sector: fromDeg and toDeg required`);
}
