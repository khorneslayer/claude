/**
 * PENUMBRA core data model.
 *
 * The log is the entity model. Everything the operator sees is a pure function
 * of (log, t): see `project()`. Nothing in a snapshot is stored; it is
 * recomputed on read, which is what makes exact reconstruction of any past
 * picture possible.
 */

/** Simulation time: milliseconds since the Unix epoch, UTC. */
export type Millis = number;

/** OPERATOR is virtual: operator resolutions enter the picture as evidence from it. */
export type SourceType = "RF" | "ADSB" | "EO" | "RADAR" | "CIV_CALL" | "SOCIAL" | "REMOTE_ID" | "OPERATOR";
export type SourceStatus = "up" | "degraded" | "down";
/** How the content of an observation was produced. */
export type Extraction = "sensor" | "human" | "ai";

export interface LatLon {
  lat: number;
  lon: number;
}

/** A simple polygon in lat/lon with optional holes (e.g. an RF shadow). */
export interface Polygon {
  outer: LatLon[];
  holes?: LatLon[][];
}

/** A location estimate with a 1-sigma horizontal uncertainty. */
export interface PositionEstimate extends LatLon {
  altM?: number;
  sigmaM: number;
}

/** Raw bearing-only fix, kept for provenance. */
export interface BearingFix {
  origin: LatLon;
  bearingDeg: number;
  sigmaDeg: number;
}

/** Projection tuning. Carried in the log so a replay needs nothing else. */
export interface ProjectionConfig {
  /** Minimum evidential weight for an observation to count as live support. */
  activeWeightEpsilon: number;
  /** Entities below this confidence are hidden unless retained as ghosts. */
  visibleConfidenceFloor: number;
  /** First number used for CTR-nnn labels. */
  contradictionIdStart: number;
  /** Class used when no observation names one. */
  defaultClass: string;
  classes: Record<string, EntityClassParams>;
  deception: DeceptionParams;
  operator: OperatorParams;
}

/** How operator resolutions feed the picture. */
export interface OperatorParams {
  /**
   * When true, resolving a contradiction (a) adds the operator's judgement as
   * evidence for the accepted value, from the virtual OPERATOR source, and
   * (b) re-reads earlier reports asserting a rejected value as support for
   * the accepted one. The rejected hypothesis drops to zero.
   */
  resolutionIsEvidence: boolean;
  reliability: { alpha: number; beta: number };
  halfLifeS: number;
}

export interface EntityClassParams {
  /** Typical speed, drives the plausibility (random-walk) envelope. */
  cruiseSpeedMps: number;
  /** Hard kinematic limit, drives the outer reachability bound. */
  maxSpeedMps: number;
  /** How long the object tends to hold a heading (velocity correlation time). */
  headingPersistenceS: number;
  /** Maximum flight time; caps the reachability bound. */
  enduranceS: number;
  /** Fix age after which the entity is drawn as a ghost. */
  ghostAfterS: number;
  /** How long a ghost stays on the picture after its last fix. */
  retainGhostS: number;
}

export interface DeceptionParams {
  /** Only reports from sources below this reliability are candidates. */
  lowReliabilityBelow: number;
  /** Minimum number of distinct origins in one burst. */
  minReports: number;
  /** All reports of a burst arrive within this span. */
  burstSpanS: number;
  /** All positioned reports of a burst lie within this radius of the centroid. */
  radiusM: number;
  /** A flag stays raised this long after the last report of the burst. */
  retainS: number;
  /** When true, every origin in a flagged burst casts a single, shared vote. */
  collapseFlaggedOrigins: boolean;
}

// ---------------------------------------------------------------------------
// Log events (append-only)
// ---------------------------------------------------------------------------

interface EventBase {
  /** Strictly increasing position in the log. */
  seq: number;
  /** Simulation time at which the event entered the system. */
  t: Millis;
}

export interface ConfigEvent extends EventBase {
  kind: "config";
  config: ProjectionConfig;
}

export interface SourceRegisteredEvent extends EventBase {
  kind: "source_registered";
  sourceId: string;
  sourceType: SourceType;
  label: string;
  /** Beta prior over the source's reliability. */
  prior: { alpha: number; beta: number };
  /** Evidence from this source halves in weight every halfLifeS seconds. */
  halfLifeS: number;
  position?: LatLon;
  /** Where the source can detect anything at all. Absent for non-spatial sources. */
  footprint?: Polygon;
  /** Which coverage layers the footprint counts towards, e.g. "uas", "cooperative". */
  coverageLayers?: string[];
  status: SourceStatus;
}

export interface SourceStatusEvent extends EventBase {
  kind: "source_status";
  sourceId: string;
  status: SourceStatus;
  note?: string;
}

export interface ObservationEvent extends EventBase {
  kind: "observation";
  obsId: string;
  /** Reliability bucket: whose track record weights this report. */
  sourceId: string;
  /** Independence unit: reports sharing an origin never corroborate each other. */
  originId: string;
  /** Contact this observation was correlated to. */
  entityId: string;
  /** Phase 0 correlation is given by the scenario; later this names the correlator. */
  correlation: "scripted";
  entityClass?: string;
  position?: PositionEstimate;
  bearing?: BearingFix;
  /** Producer-side quality in [0, 1] (SNR, geometry, extraction confidence). */
  quality: number;
  /** Discrete assertions, e.g. { intent: "hobbyist" }. Absent dimension = neutral. */
  claims: Record<string, string>;
  extraction: Extraction;
  /** Processing chain the report went through before reaching PENUMBRA. */
  chain: string[];
  text?: string;
}

export interface VerificationEvent extends EventBase {
  kind: "verification";
  obsId: string;
  outcome: "confirmed" | "falsified";
  by: string;
}

export interface OperatorActionEvent extends EventBase {
  kind: "operator_action";
  operatorId: string;
  action: "resolve" | "defer";
  entityId: string;
  dimension: string;
  /** Required for resolve: the hypothesis value the operator accepts. */
  value?: string;
}

export type LogEvent =
  | ConfigEvent
  | SourceRegisteredEvent
  | SourceStatusEvent
  | ObservationEvent
  | VerificationEvent
  | OperatorActionEvent;

export type LogEventKind = LogEvent["kind"];

/** A log event before the log assigns its sequence number. */
export type DraftEvent = {
  [K in LogEventKind]: Omit<Extract<LogEvent, { kind: K }>, "seq">;
}[LogEventKind];

// ---------------------------------------------------------------------------
// Snapshot (computed on read, never stored)
// ---------------------------------------------------------------------------

/** One origin's share of a confidence value. Contributions sum to the value. */
export interface Contribution {
  originId: string;
  sourceId: string;
  sourceType: SourceType | "UNKNOWN";
  /** The strongest observation from this origin, which is the one that counts. */
  obsId: string;
  t: Millis;
  reliability: number;
  quality: number;
  decay: number;
  /** Evidential weight w = reliability x quality x decay. */
  weight: number;
  /** This origin's additive share of the confidence value. */
  contribution: number;
  extraction: Extraction;
  chain: string[];
  verified?: "confirmed";
  text?: string;
  /** Present when several origins were merged into this one vote (a flagged burst): the merged origins. */
  members?: string[];
}

export interface ConfidenceBreakdown {
  value: number;
  /** Sorted by contribution, largest first. Sums to `value`. */
  contributions: Contribution[];
}

export type HypothesisStatus = "open" | "accepted" | "rejected";

export interface HypothesisView {
  dimension: string;
  value: string;
  /** accepted / rejected once an operator resolution is in force. */
  status: HypothesisStatus;
  /** CAND-x label, assigned when the value first takes part in a contradiction. */
  label?: string;
  confidence: ConfidenceBreakdown;
  /** Origins that explicitly assert this value (not merely consistent with it). */
  assertedBy: { originId: string; sourceType: SourceType | "UNKNOWN" }[];
  position?: PositionEstimate;
}

export type EntityFlag = "SINGLE_SOURCE" | "DEGRADED_SOURCE" | "CONTRADICTED" | "DECEPTION_FLAG" | "VERIFIED";

export interface EntityView {
  id: string;
  entityClass: string;
  state: "active" | "ghost";
  confidence: ConfidenceBreakdown;
  /** Confidence as it stood at the moment of the last positional fix. */
  confidenceAtLastFix?: number;
  /** Distinct origins with live support. */
  sourceCount: number;
  lastObsT: Millis;
  lastFixT?: Millis;
  fixAgeS?: number;
  /** Last fix (not extrapolated). */
  position?: PositionEstimate;
  /** Radius where the object plausibly is now (random-walk model). */
  envelopeRadiusM?: number;
  /** Radius it could physically have reached (max speed, capped by endurance). */
  maxReachM?: number;
  hypotheses: HypothesisView[];
  flags: EntityFlag[];
}

export type ContradictionStatus = "unresolved" | "deferred" | "resolved" | "lapsed";

export interface ContradictionView {
  /** CTR-nnn */
  id: string;
  entityId: string;
  dimension: string;
  status: ContradictionStatus;
  openedT: Millis;
  statusSinceT: Millis;
  actedBy?: string;
  resolvedValue?: string;
  /** New evidence for a rejected value arrived after the resolution: a fresh decision is needed. */
  reopened?: boolean;
  /** Every value seen on this dimension, with live confidence. */
  hypotheses: {
    value: string;
    label?: string;
    status: HypothesisStatus;
    confidence: number;
    live: boolean;
    assertedBySourceType: Partial<Record<SourceType | "UNKNOWN", number>>;
  }[];
}

export interface SourceView {
  id: string;
  label: string;
  type: SourceType;
  status: SourceStatus;
  statusSinceT: Millis;
  reliability: number;
  alpha: number;
  beta: number;
  confirmed: number;
  falsified: number;
}

export interface FeedHealth {
  sourceType: SourceType;
  up: number;
  total: number;
  status: "ok" | "degraded" | "down";
}

export interface CoverageFootprint {
  sourceId: string;
  status: SourceStatus;
  layers: string[];
  footprint: Polygon;
}

export interface Coverage {
  /** Footprints of sources that can currently see (up or degraded). */
  active: CoverageFootprint[];
  /** Footprints of sources that are down: coverage the picture has lost. */
  lost: CoverageFootprint[];
}

export interface DeceptionFlag {
  id: string;
  reason: "CORRELATED_ARRIVAL_TIMING";
  count: number;
  obsIds: string[];
  entityIds: string[];
  firstT: Millis;
  lastT: Millis;
  spanS: number;
  centroid?: LatLon;
}

export interface PictureSnapshot {
  t: Millis;
  /** Highest log sequence number included. */
  logSeq: number;
  entities: EntityView[];
  contradictions: ContradictionView[];
  sources: SourceView[];
  feedHealth: FeedHealth[];
  coverage: Coverage;
  flags: DeceptionFlag[];
  operatorActions: (OperatorActionEvent & { contradictionId?: string })[];
}
