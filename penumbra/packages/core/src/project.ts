import { betaMean, combineNoisyOr, decayFactor, evidenceWeight, uncertaintyEnvelope } from "./confidence";
import { centroid, distanceM, pointInPolygon } from "./geo";
import type {
  ConfidenceBreakdown,
  Contribution,
  ContradictionStatus,
  ContradictionView,
  Coverage,
  CoverageFootprint,
  DeceptionFlag,
  EntityClassParams,
  EntityFlag,
  EntityView,
  FeedHealth,
  HypothesisView,
  LatLon,
  LogEvent,
  Millis,
  ObservationEvent,
  OperatorActionEvent,
  PictureSnapshot,
  ProjectionConfig,
  SourceRegisteredEvent,
  SourceStatus,
  SourceType,
  SourceView,
} from "./types";

export const DEFAULT_CLASS_PARAMS: EntityClassParams = {
  cruiseSpeedMps: 15,
  maxSpeedMps: 25,
  headingPersistenceS: 5,
  enduranceS: 1800,
  ghostAfterS: 45,
  retainGhostS: 3600,
};

export const DEFAULT_CONFIG: ProjectionConfig = {
  activeWeightEpsilon: 0.05,
  visibleConfidenceFloor: 0.02,
  contradictionIdStart: 1,
  defaultClass: "UNKNOWN",
  classes: { UNKNOWN: DEFAULT_CLASS_PARAMS },
  deception: { lowReliabilityBelow: 0.5, minReports: 6, burstSpanS: 60, radiusM: 3000, retainS: 600 },
};

type Verdict = "confirmed" | "falsified";
type SourceTypeOrUnknown = SourceType | "UNKNOWN";

interface SourceState {
  reg: SourceRegisteredEvent;
  status: SourceStatus;
  statusSinceT: Millis;
  alpha: number;
  beta: number;
  confirmed: number;
  falsified: number;
}

interface Weighted {
  obs: ObservationEvent;
  weight: number;
  reliability: number;
  decay: number;
  verified?: "confirmed";
}

// ---------------------------------------------------------------------------
// Evidence groups
//
// Within one (origin, source) group every observation shares the source's
// reliability and half-life, so the ratio between any two weights is fixed for
// all time: w_i / w_j = (q_i / q_j) * 2^((t_i - t_j) / h). The strongest
// observation of a group can therefore be kept as events arrive, and reading
// the picture costs one weight per group instead of one per observation. Only
// a verdict (which changes one observation's reliability) forces a rescan.
// ---------------------------------------------------------------------------

class OriginGroup {
  readonly obs: ObservationEvent[] = [];
  private t0 = 0;
  private bestUnverified: ObservationEvent | undefined;
  private bestConfirmed: ObservationEvent | undefined;
  private dirty = false;

  constructor(
    readonly originId: string,
    readonly sourceId: string,
    private readonly halfLifeS: number,
  ) {}

  private rank(o: ObservationEvent): number {
    const q = o.quality > 0 ? Math.log(o.quality) : Number.NEGATIVE_INFINITY;
    return q + ((o.t - this.t0) / 1000 / (this.halfLifeS > 0 ? this.halfLifeS : 1)) * Math.LN2;
  }

  private better(a: ObservationEvent, b: ObservationEvent | undefined): boolean {
    if (!b) return true;
    const ra = this.rank(a);
    const rb = this.rank(b);
    return ra > rb || (ra === rb && a.t >= b.t);
  }

  /** New observations are always unverified: a verdict can only follow its report. */
  add(o: ObservationEvent): void {
    if (this.obs.length === 0) this.t0 = o.t;
    this.obs.push(o);
    if (!this.dirty && this.better(o, this.bestUnverified)) this.bestUnverified = o;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** The observations that can be this group's strongest at any time from now on. */
  candidates(verdicts: Map<string, Verdict>): ObservationEvent[] {
    if (this.dirty) {
      this.bestUnverified = undefined;
      this.bestConfirmed = undefined;
      for (const o of this.obs) {
        const v = verdicts.get(o.obsId);
        if (v === "falsified") continue;
        if (v === "confirmed") {
          if (this.better(o, this.bestConfirmed)) this.bestConfirmed = o;
        } else if (this.better(o, this.bestUnverified)) this.bestUnverified = o;
      }
      this.dirty = false;
    }
    const out: ObservationEvent[] = [];
    if (this.bestUnverified) out.push(this.bestUnverified);
    if (this.bestConfirmed) out.push(this.bestConfirmed);
    return out;
  }

  /** As `candidates`, restricted to observations made at or before `t`. */
  candidatesUpTo(t: Millis, verdicts: Map<string, Verdict>): ObservationEvent[] {
    const c = this.candidates(verdicts);
    if (c.every((o) => o.t <= t)) return c;
    let u: ObservationEvent | undefined;
    let k: ObservationEvent | undefined;
    for (const o of this.obs) {
      if (o.t > t) continue;
      const v = verdicts.get(o.obsId);
      if (v === "falsified") continue;
      if (v === "confirmed") {
        if (this.better(o, k)) k = o;
      } else if (this.better(o, u)) u = o;
    }
    return [u, k].filter((o): o is ObservationEvent => o !== undefined);
  }
}

class GroupSet {
  readonly groups = new Map<string, OriginGroup>();

  add(o: ObservationEvent, halfLifeS: number): OriginGroup {
    const key = `${o.originId}\u0000${o.sourceId}`;
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = new OriginGroup(o.originId, o.sourceId, halfLifeS)));
    g.add(o);
    return g;
  }
}

interface DimState {
  /** Reports on this entity that say nothing about the dimension: consistent with every value. */
  neutral: GroupSet;
  /** Reports asserting each value, in order of first appearance. */
  values: Map<string, GroupSet>;
  lastClaimT: Millis;
}

interface EntityState {
  id: string;
  obs: ObservationEvent[];
  all: GroupSet;
  dims: Map<string, DimState>;
  falsified: number;
}

interface ContradictionState {
  key: string;
  entityId: string;
  dimension: string;
  id: string;
  openedT: Millis;
  actions: OperatorActionEvent[];
  labelCount: number;
}

function candidateLabel(n: number): string {
  let s = "";
  let k = n;
  do {
    s = String.fromCharCode(65 + (k % 26)) + s;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return `CAND-${s}`;
}

/**
 * Incremental projection: fold log events in with `apply`, read the picture
 * at any time at or after the last event with `evaluate`. Nothing a snapshot
 * shows is stored; `evaluate` computes it from the folded evidence.
 */
export class Projector {
  private config: ProjectionConfig = DEFAULT_CONFIG;
  private lastSeq = 0;
  private lastT = Number.NEGATIVE_INFINITY;
  private readonly sources = new Map<string, SourceState>();
  private readonly obsById = new Map<string, ObservationEvent>();
  private readonly timeline: ObservationEvent[] = [];
  private readonly entities = new Map<string, EntityState>();
  private readonly groupsByObs = new Map<string, OriginGroup[]>();
  private readonly verdicts = new Map<string, Verdict>();
  private readonly contradictions = new Map<string, ContradictionState>();
  private readonly candidateLabels = new Map<string, string>(); // `${entity}\0${dim}\0${value}` -> CAND-x
  private readonly operatorActions: (OperatorActionEvent & { contradictionId?: string })[] = [];
  private nextContradiction = DEFAULT_CONFIG.contradictionIdStart;

  get appliedSeq(): number {
    return this.lastSeq;
  }

  get appliedT(): Millis {
    return this.lastT;
  }

  apply(e: LogEvent): void {
    if (e.t < this.lastT) throw new Error(`Projector: events must arrive in time order (got ${e.t} after ${this.lastT})`);
    this.lastT = e.t;
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    switch (e.kind) {
      case "config":
        this.config = { ...DEFAULT_CONFIG, ...e.config, deception: { ...DEFAULT_CONFIG.deception, ...e.config.deception } };
        this.nextContradiction = Math.max(this.nextContradiction, this.config.contradictionIdStart);
        break;
      case "source_registered":
        this.sources.set(e.sourceId, {
          reg: e,
          status: e.status,
          statusSinceT: e.t,
          alpha: e.prior.alpha,
          beta: e.prior.beta,
          confirmed: 0,
          falsified: 0,
        });
        break;
      case "source_status": {
        const s = this.sources.get(e.sourceId);
        if (s && s.status !== e.status) {
          s.status = e.status;
          s.statusSinceT = e.t;
        }
        break;
      }
      case "observation":
        this.applyObservation(e);
        break;
      case "verification": {
        if (this.verdicts.has(e.obsId)) break; // the first verdict stands
        const obs = this.obsById.get(e.obsId);
        if (!obs) break;
        this.verdicts.set(e.obsId, e.outcome);
        for (const g of this.groupsByObs.get(e.obsId) ?? []) g.invalidate();
        if (e.outcome === "falsified") this.entities.get(obs.entityId)!.falsified++;
        const s = this.sources.get(obs.sourceId);
        if (s) {
          if (e.outcome === "confirmed") {
            s.alpha += 1;
            s.confirmed += 1;
          } else {
            s.beta += 1;
            s.falsified += 1;
          }
        }
        break;
      }
      case "operator_action": {
        const c = this.contradictions.get(`${e.entityId}\u0000${e.dimension}`);
        if (c) {
          c.actions.push(e);
          this.operatorActions.push({ ...e, contradictionId: c.id });
        } else {
          this.operatorActions.push({ ...e });
        }
        break;
      }
    }
  }

  private halfLife(sourceId: string): number {
    return this.sources.get(sourceId)?.reg.halfLifeS ?? 0;
  }

  private track(o: ObservationEvent, g: OriginGroup) {
    const list = this.groupsByObs.get(o.obsId);
    if (list) list.push(g);
    else this.groupsByObs.set(o.obsId, [g]);
  }

  private applyObservation(o: ObservationEvent) {
    this.obsById.set(o.obsId, o);
    this.timeline.push(o);
    const h = this.halfLife(o.sourceId);
    let ent = this.entities.get(o.entityId);
    if (!ent) this.entities.set(o.entityId, (ent = { id: o.entityId, obs: [], all: new GroupSet(), dims: new Map(), falsified: 0 }));

    // A dimension seen for the first time: every earlier report on this entity was neutral on it.
    for (const dim of Object.keys(o.claims)) {
      if (ent.dims.has(dim)) continue;
      const d: DimState = { neutral: new GroupSet(), values: new Map(), lastClaimT: o.t };
      for (const prior of ent.obs) this.track(prior, d.neutral.add(prior, this.halfLife(prior.sourceId)));
      ent.dims.set(dim, d);
    }

    ent.obs.push(o);
    this.track(o, ent.all.add(o, h));
    for (const [dim, d] of ent.dims) {
      const v = o.claims[dim];
      if (v === undefined) {
        this.track(o, d.neutral.add(o, h));
      } else {
        let set = d.values.get(v);
        if (!set) d.values.set(v, (set = new GroupSet()));
        this.track(o, set.add(o, h));
        d.lastClaimT = o.t;
      }
    }

    // Contradictions open the first time a second value has live support.
    for (const [dim, value] of Object.entries(o.claims)) {
      const d = ent.dims.get(dim)!;
      if (d.values.size < 2) continue;
      const key = `${o.entityId}\u0000${dim}`;
      const existing = this.contradictions.get(key);
      if (existing && this.candidateLabels.has(`${key}\u0000${value}`)) continue;
      const live = this.liveValues(d, o.t);
      if (existing) {
        this.assignCandidateLabels(existing, d, live, o.t);
      } else if (live.length >= 2) {
        const c: ContradictionState = {
          key,
          entityId: o.entityId,
          dimension: dim,
          id: `CTR-${String(this.nextContradiction++).padStart(3, "0")}`,
          openedT: o.t,
          actions: [],
          labelCount: 0,
        };
        this.contradictions.set(key, c);
        this.assignCandidateLabels(c, d, live, o.t);
      }
    }
  }

  // ------------------------------------------------------------------ weighing

  private weigh(obs: ObservationEvent, at: Millis): Weighted {
    const v = this.verdicts.get(obs.obsId);
    if (v === "falsified") return { obs, weight: 0, reliability: 0, decay: 0 };
    const src = this.sources.get(obs.sourceId);
    const reliability = v === "confirmed" ? 1 : src ? betaMean(src.alpha, src.beta) : 0;
    const decay = decayFactor((at - obs.t) / 1000, src?.reg.halfLifeS ?? 0);
    const weight = evidenceWeight(reliability, obs.quality, decay);
    return v === "confirmed" ? { obs, weight, reliability, decay, verified: v } : { obs, weight, reliability, decay };
  }

  /** Strongest weighted observation per origin across the given sets. */
  private bestPerOrigin(sets: GroupSet[], at: Millis, upTo?: Millis): Weighted[] {
    const best = new Map<string, Weighted>();
    for (const set of sets) {
      for (const g of set.groups.values()) {
        const cands = upTo === undefined ? g.candidates(this.verdicts) : g.candidatesUpTo(upTo, this.verdicts);
        for (const o of cands) {
          const w = this.weigh(o, at);
          const cur = best.get(o.originId);
          if (!cur || w.weight > cur.weight || (w.weight === cur.weight && o.t > cur.obs.t)) best.set(o.originId, w);
        }
      }
    }
    return [...best.values()];
  }

  /** Values on a dimension with live support at `at`, in order of first appearance. */
  private liveValues(d: DimState, at: Millis): string[] {
    const out: string[] = [];
    for (const [value, set] of d.values) {
      if (this.bestPerOrigin([set], at).some((w) => w.weight >= this.config.activeWeightEpsilon)) out.push(value);
    }
    return out;
  }

  /** CAND-x labels are scoped to their contradiction: A is the leading hypothesis at opening. */
  private assignCandidateLabels(c: ContradictionState, d: DimState, values: string[], at: Millis) {
    const fresh = values
      .filter((v) => !this.candidateLabels.has(`${c.key}\u0000${v}`))
      .map((v) => ({ v, conf: combineNoisyOr(this.bestPerOrigin([d.neutral, d.values.get(v)!], at).map((w) => w.weight)).value }))
      .sort((a, b) => b.conf - a.conf || a.v.localeCompare(b.v));
    for (const { v } of fresh) this.candidateLabels.set(`${c.key}\u0000${v}`, candidateLabel(c.labelCount++));
  }

  private sourceType(id: string): SourceTypeOrUnknown {
    return this.sources.get(id)?.reg.sourceType ?? "UNKNOWN";
  }

  private breakdown(votes: Weighted[]): ConfidenceBreakdown {
    const live = votes.filter((w) => w.weight > 0);
    const { value, shares } = combineNoisyOr(live.map((w) => w.weight));
    const contributions: Contribution[] = live.map((w, i) => {
      const c: Contribution = {
        originId: w.obs.originId,
        sourceId: w.obs.sourceId,
        sourceType: this.sourceType(w.obs.sourceId),
        obsId: w.obs.obsId,
        t: w.obs.t,
        reliability: w.reliability,
        quality: w.obs.quality,
        decay: w.decay,
        weight: w.weight,
        contribution: shares[i]!,
        extraction: w.obs.extraction,
        chain: w.obs.chain,
      };
      if (w.verified) c.verified = w.verified;
      if (w.obs.text !== undefined) c.text = w.obs.text;
      return c;
    });
    contributions.sort((a, b) => b.contribution - a.contribution || a.originId.localeCompare(b.originId));
    return { value, contributions };
  }

  /** Origins with at least one standing (not falsified) report in the set. */
  private originsOf(set: GroupSet): { originId: string; sourceType: SourceTypeOrUnknown }[] {
    const seen = new Map<string, SourceTypeOrUnknown>();
    for (const g of set.groups.values()) {
      if (g.candidates(this.verdicts).length > 0 && !seen.has(g.originId)) seen.set(g.originId, this.sourceType(g.sourceId));
    }
    return [...seen].map(([originId, sourceType]) => ({ originId, sourceType }));
  }

  // ------------------------------------------------------------------ evaluation

  /** The picture at `now`. `now` may not precede the last applied event. */
  evaluate(now: Millis): PictureSnapshot {
    if (now < this.lastT) throw new Error(`Projector: cannot evaluate at ${now}, events up to ${this.lastT} are applied`);
    const config = this.config;
    const classParams = (cls: string): EntityClassParams =>
      config.classes[cls] ?? config.classes[config.defaultClass] ?? DEFAULT_CLASS_PARAMS;

    const flags = this.detectDeception(now);
    const flaggedEntities = new Set(flags.flatMap((f) => f.entityIds));

    // Entities
    const entities: EntityView[] = [];
    for (const ent of this.entities.values()) {
      if (ent.falsified >= ent.obs.length) continue;
      const confidence = this.breakdown(this.bestPerOrigin([ent.all], now));

      let fix: ObservationEvent | undefined;
      let entityClass: string | undefined;
      let lastObsT: Millis | undefined;
      for (let i = ent.obs.length - 1; i >= 0 && (!fix || !entityClass || lastObsT === undefined); i--) {
        const o = ent.obs[i]!;
        if (this.verdicts.get(o.obsId) === "falsified") continue;
        if (lastObsT === undefined) lastObsT = o.t;
        if (!fix && o.position) fix = o;
        if (!entityClass && o.entityClass) entityClass = o.entityClass;
      }
      const cls = entityClass ?? config.defaultClass;
      const params = classParams(cls);
      const fixAgeS = fix ? (now - fix.t) / 1000 : undefined;
      const retainedGhost = fixAgeS !== undefined && fixAgeS <= params.retainGhostS;
      if (confidence.value < config.visibleConfidenceFloor && !retainedGhost) continue;

      const hypotheses: HypothesisView[] = [];
      for (const [dim, d] of ent.dims) {
        for (const [value, set] of d.values) {
          const assertedBy = this.originsOf(set);
          if (assertedBy.length === 0) continue; // every assertion was falsified
          const h: HypothesisView = {
            dimension: dim,
            value,
            confidence: this.breakdown(this.bestPerOrigin([d.neutral, set], now)),
            assertedBy,
          };
          const label = this.candidateLabels.get(`${ent.id}\u0000${dim}\u0000${value}`);
          if (label) h.label = label;
          for (let i = ent.obs.length - 1; i >= 0; i--) {
            const o = ent.obs[i]!;
            if (o.claims[dim] === value && o.position && this.verdicts.get(o.obsId) !== "falsified") {
              h.position = o.position;
              break;
            }
          }
          hypotheses.push(h);
        }
      }
      hypotheses.sort(
        (a, b) =>
          a.dimension.localeCompare(b.dimension) || (a.label ?? "￿").localeCompare(b.label ?? "￿") || a.value.localeCompare(b.value),
      );

      const sourceCount = confidence.contributions.filter((c) => c.weight >= config.activeWeightEpsilon).length;
      const entityFlags: EntityFlag[] = [];
      if (sourceCount === 1) entityFlags.push("SINGLE_SOURCE");
      const top = confidence.contributions[0];
      if (top && this.sources.get(top.sourceId)?.status === "degraded") entityFlags.push("DEGRADED_SOURCE");
      if (flaggedEntities.has(ent.id)) entityFlags.push("DECEPTION_FLAG");
      if (confidence.contributions.some((c) => c.verified)) entityFlags.push("VERIFIED");

      const view: EntityView = {
        id: ent.id,
        entityClass: cls,
        state: fixAgeS !== undefined && fixAgeS > params.ghostAfterS ? "ghost" : "active",
        confidence,
        sourceCount,
        lastObsT: lastObsT!,
        hypotheses,
        flags: entityFlags,
      };
      if (fix?.position && fixAgeS !== undefined) {
        const env = uncertaintyEnvelope(fixAgeS, fix.position.sigmaM, params);
        view.position = fix.position;
        view.lastFixT = fix.t;
        view.fixAgeS = fixAgeS;
        view.envelopeRadiusM = env.plausibleM;
        view.maxReachM = env.reachM;
        view.confidenceAtLastFix = this.breakdown(this.bestPerOrigin([ent.all], fix.t, fix.t)).value;
      }
      entities.push(view);
    }
    entities.sort((a, b) => a.id.localeCompare(b.id));

    // Contradictions
    const contradictionViews: ContradictionView[] = [];
    for (const c of this.contradictions.values()) {
      const d = this.entities.get(c.entityId)!.dims.get(c.dimension)!;
      const live = this.liveValues(d, now);
      const hyps: ContradictionView["hypotheses"] = [];
      for (const [value, set] of d.values) {
        const origins = this.originsOf(set);
        if (origins.length === 0) continue;
        const assertedBySourceType: Partial<Record<SourceTypeOrUnknown, number>> = {};
        for (const o of origins) assertedBySourceType[o.sourceType] = (assertedBySourceType[o.sourceType] ?? 0) + 1;
        const h: ContradictionView["hypotheses"][number] = {
          value,
          confidence: combineNoisyOr(this.bestPerOrigin([d.neutral, set], now).map((w) => w.weight)).value,
          live: live.includes(value),
          assertedBySourceType,
        };
        const label = this.candidateLabels.get(`${c.key}\u0000${value}`);
        if (label) h.label = label;
        hyps.push(h);
      }
      hyps.sort((a, b) => (a.label ?? "￿").localeCompare(b.label ?? "￿") || a.value.localeCompare(b.value));

      const last = c.actions[c.actions.length - 1];
      let status: ContradictionStatus = last?.action === "resolve" ? "resolved" : last?.action === "defer" ? "deferred" : "unresolved";
      let statusSinceT = last ? last.t : c.openedT;
      if (status !== "resolved" && live.length < 2) {
        status = "lapsed";
        // When support fell away is not stored; report the later of the last action and the last assertion.
        statusSinceT = Math.max(statusSinceT, d.lastClaimT);
      }
      const view: ContradictionView = {
        id: c.id,
        entityId: c.entityId,
        dimension: c.dimension,
        status,
        openedT: c.openedT,
        statusSinceT,
        hypotheses: hyps,
      };
      if (last) view.actedBy = last.operatorId;
      if (last?.action === "resolve" && last.value !== undefined) view.resolvedValue = last.value;
      contradictionViews.push(view);
    }
    contradictionViews.sort((a, b) => a.openedT - b.openedT || a.id.localeCompare(b.id));
    const contested = new Set(contradictionViews.filter((c) => c.status === "unresolved" || c.status === "deferred").map((c) => c.entityId));
    for (const e of entities) if (contested.has(e.id)) e.flags.push("CONTRADICTED");

    // Sources, feed health, coverage
    const sourceViews: SourceView[] = [...this.sources.values()]
      .map((s) => ({
        id: s.reg.sourceId,
        label: s.reg.label,
        type: s.reg.sourceType,
        status: s.status,
        statusSinceT: s.statusSinceT,
        reliability: betaMean(s.alpha, s.beta),
        alpha: s.alpha,
        beta: s.beta,
        confirmed: s.confirmed,
        falsified: s.falsified,
      }))
      .sort((a, b) => b.reliability - a.reliability || a.id.localeCompare(b.id));

    const byType = new Map<SourceType, SourceState[]>();
    for (const s of this.sources.values()) {
      const list = byType.get(s.reg.sourceType);
      if (list) list.push(s);
      else byType.set(s.reg.sourceType, [s]);
    }
    const feedHealth: FeedHealth[] = [...byType].map(([type, list]) => {
      const up = list.filter((s) => s.status === "up").length;
      const allDown = list.every((s) => s.status === "down");
      return { sourceType: type, up, total: list.length, status: up === list.length ? "ok" : allDown ? "down" : "degraded" };
    });

    const coverage: Coverage = { active: [], lost: [] };
    for (const s of this.sources.values()) {
      if (!s.reg.footprint) continue;
      const fp: CoverageFootprint = { sourceId: s.reg.sourceId, status: s.status, layers: s.reg.coverageLayers ?? [], footprint: s.reg.footprint };
      (s.status === "down" ? coverage.lost : coverage.active).push(fp);
    }

    return {
      t: now,
      logSeq: this.lastSeq,
      entities,
      contradictions: contradictionViews,
      sources: sourceViews,
      feedHealth,
      coverage,
      flags,
      operatorActions: this.operatorActions.map((a) => ({ ...a })),
    };
  }

  /**
   * Raise a flag when many low-reliability reports from distinct origins
   * arrive in a burst tighter than independent observers produce, in one
   * area. The flag draws attention; it never changes a confidence value.
   */
  private detectDeception(now: Millis): DeceptionFlag[] {
    const p = this.config.deception;
    const from = now - (p.retainS + p.burstSpanS) * 1000;
    // Timeline is in time order: binary search the start of the window.
    let lo = 0;
    let hi = this.timeline.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeline[mid]!.t < from) lo = mid + 1;
      else hi = mid;
    }
    const candidates: ObservationEvent[] = [];
    for (let i = lo; i < this.timeline.length; i++) {
      const o = this.timeline[i]!;
      if (o.t > now) break;
      if (this.verdicts.has(o.obsId)) continue; // already adjudicated either way
      const s = this.sources.get(o.sourceId);
      if (s && betaMean(s.alpha, s.beta) < p.lowReliabilityBelow) candidates.push(o);
    }

    const flags: DeceptionFlag[] = [];
    let i = 0;
    while (i < candidates.length) {
      let j = i;
      while (j + 1 < candidates.length && candidates[j + 1]!.t - candidates[i]!.t <= p.burstSpanS * 1000) j++;
      const burst = candidates.slice(i, j + 1);
      const origins = new Set(burst.map((o) => o.originId));
      const positions: LatLon[] = burst.flatMap((o) => (o.position ? [o.position] : []));
      const c = centroid(positions);
      const compact = !c || positions.every((pos) => distanceM(pos, c) <= p.radiusM);
      const last = burst[burst.length - 1]!;
      if (origins.size >= p.minReports && compact) {
        if ((now - last.t) / 1000 <= p.retainS) {
          const flag: DeceptionFlag = {
            id: `DF-${burst[0]!.obsId}`,
            reason: "CORRELATED_ARRIVAL_TIMING",
            count: burst.length,
            obsIds: burst.map((o) => o.obsId),
            entityIds: [...new Set(burst.map((o) => o.entityId))].sort(),
            firstT: burst[0]!.t,
            lastT: last.t,
            spanS: (last.t - burst[0]!.t) / 1000,
          };
          if (c) flag.centroid = c;
          flags.push(flag);
        }
        i = j + 1;
      } else {
        i++;
      }
    }
    return flags;
  }
}

/** Does the log need sorting? Normally it is already in (t, seq) order. */
function isOrdered(log: readonly LogEvent[]): boolean {
  for (let i = 1; i < log.length; i++) {
    const a = log[i - 1]!;
    const b = log[i]!;
    if (b.t < a.t || (b.t === a.t && b.seq <= a.seq)) return false;
  }
  return true;
}

/**
 * The picture exactly as it stood at time `now`, computed from the log alone.
 * Events after `now` are ignored, so passing a longer log never changes a past
 * picture.
 */
export function project(log: readonly LogEvent[], now: Millis): PictureSnapshot {
  const ordered = isOrdered(log) ? log : [...log].sort((a, b) => a.t - b.t || a.seq - b.seq);
  const p = new Projector();
  for (const e of ordered) {
    if (e.t > now) break;
    p.apply(e);
  }
  return p.evaluate(now);
}

/** Can the picture see a point on a given coverage layer ("uas", "cooperative")? */
export function isCovered(coverage: Coverage, point: LatLon, layer = "uas"): boolean {
  return coverage.active.some((f) => f.layers.includes(layer) && pointInPolygon(point, f.footprint));
}

/** Was a point covered by a source that is now down? ("we used to see there") */
export function isCoverageLost(coverage: Coverage, point: LatLon, layer = "uas"): boolean {
  return !isCovered(coverage, point, layer) && coverage.lost.some((f) => f.layers.includes(layer) && pointInPolygon(point, f.footprint));
}
