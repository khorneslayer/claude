import { describe, expect, it } from "vitest";
import { betaMean, EventLog, isCovered, isCoverageLost, offsetM, project, validateOperatorAction } from "../src";
import { CENTER, LogBuilder, s, T0, testConfig } from "./helpers";

const sumOf = (cs: { contribution: number }[]) => cs.reduce((a, c) => a + c.contribution, 0);

describe("project: confidence", () => {
  it("is computed from reliability x quality x decay and decomposes exactly", () => {
    const b = new LogBuilder().source("RF-1").source("EO-1", { type: "EO", alpha: 8, beta: 2, halfLifeS: 120 });
    b.report(s(0), "RF-1", "TRK-1", { quality: 0.6 });
    b.report(s(0), "EO-1", "TRK-1", { quality: 0.5 });
    const e = project(b.events, s(0)).entities[0]!;
    expect(e.confidence.value).toBeCloseTo(1 - (1 - 0.9 * 0.6) * (1 - 0.8 * 0.5), 12);
    expect(sumOf(e.confidence.contributions)).toBeCloseTo(e.confidence.value, 12);
    expect(e.sourceCount).toBe(2);
  });

  it("decays as the evidence ages", () => {
    const b = new LogBuilder().source("RF-1");
    b.report(s(0), "RF-1", "TRK-1");
    const fresh = project(b.events, s(0)).entities[0]!.confidence.value;
    const aged = project(b.events, s(300)).entities[0]!.confidence.value;
    expect(aged).toBeCloseTo(fresh / 2, 12);
  });

  it("does not let one origin corroborate itself", () => {
    const one = new LogBuilder().source("RF-1");
    one.report(s(0), "RF-1", "TRK-1");
    const many = new LogBuilder().source("RF-1");
    for (let i = 0; i < 50; i++) many.report(s(0), "RF-1", "TRK-1");
    const a = project(one.events, s(1)).entities[0]!;
    const b = project(many.events, s(1)).entities[0]!;
    expect(b.confidence.value).toBeCloseTo(a.confidence.value, 12);
    expect(b.sourceCount).toBe(1);
  });

  it("lets distinct origins behind one source corroborate (independent callers)", () => {
    const b = new LogBuilder().source("CIV", { type: "CIV_CALL", alpha: 5, beta: 7, halfLifeS: 600 });
    b.report(s(0), "CIV", "TRK-1", { origin: "CALLER-1" });
    b.report(s(0), "CIV", "TRK-1", { origin: "CALLER-2" });
    expect(project(b.events, s(0)).entities[0]!.sourceCount).toBe(2);
  });

  it("ignores events after `now`, so a longer log never changes a past picture", () => {
    const b = new LogBuilder().source("RF-1");
    b.report(s(0), "RF-1", "TRK-1");
    const before = project(b.events, s(10));
    b.report(s(20), "RF-1", "TRK-1", { quality: 0.9 });
    b.report(s(25), "RF-1", "TRK-2");
    expect(project(b.events, s(10))).toEqual(before);
  });
});

describe("project: verification and source reliability", () => {
  it("drops a falsified report and lowers its source's reliability", () => {
    const b = new LogBuilder().source("SOC", { type: "SOCIAL", alpha: 2, beta: 9, halfLifeS: 900 });
    const o = b.report(s(0), "SOC", "TRK-9", { origin: "ACCT-1" });
    b.add({ kind: "verification", t: s(60), obsId: o.obsId, outcome: "falsified", by: "POLICE" });
    const snap = project(b.events, s(60));
    expect(snap.entities.find((e) => e.id === "TRK-9")).toBeUndefined();
    const src = snap.sources.find((x) => x.id === "SOC")!;
    expect(src.reliability).toBeCloseTo(betaMean(2, 10), 12);
    expect(src.falsified).toBe(1);
    // Before the verdict, the picture still showed it.
    expect(project(b.events, s(59)).entities.find((e) => e.id === "TRK-9")).toBeDefined();
  });

  it("treats a confirmed report as fully reliable and credits its source", () => {
    const b = new LogBuilder().source("RF-1");
    const o = b.report(s(0), "RF-1", "TRK-1", { quality: 0.5 });
    b.add({ kind: "verification", t: s(1), obsId: o.obsId, outcome: "confirmed", by: "POLICE" });
    const snap = project(b.events, s(1));
    const c = snap.entities[0]!.confidence.contributions[0]!;
    expect(c.reliability).toBe(1);
    expect(c.verified).toBe("confirmed");
    expect(snap.entities[0]!.flags).toContain("VERIFIED");
    expect(snap.sources[0]!.alpha).toBe(10);
  });

  it("falls back to an origin's next-strongest report when its strongest is falsified", () => {
    const b = new LogBuilder().source("RF-1");
    b.report(s(0), "RF-1", "TRK-1", { quality: 0.4 });
    const strong = b.report(s(1), "RF-1", "TRK-1", { quality: 0.9 });
    b.report(s(2), "RF-1", "TRK-1", { quality: 0.3 });
    expect(project(b.events, s(2)).entities[0]!.confidence.contributions[0]!.obsId).toBe(strong.obsId);
    b.add({ kind: "verification", t: s(3), obsId: strong.obsId, outcome: "falsified", by: "POLICE" });
    const c = project(b.events, s(3)).entities[0]!.confidence.contributions[0]!;
    expect(c.obsId).toBe("O1"); // q 0.4 two seconds older still outweighs q 0.3
    expect(c.quality).toBe(0.4);
  });

  it("keeps the first verdict when an observation is verified twice", () => {
    const b = new LogBuilder().source("RF-1");
    const o = b.report(s(0), "RF-1", "TRK-1");
    b.add({ kind: "verification", t: s(1), obsId: o.obsId, outcome: "confirmed", by: "A" });
    b.add({ kind: "verification", t: s(2), obsId: o.obsId, outcome: "falsified", by: "B" });
    const snap = project(b.events, s(2));
    expect(snap.entities).toHaveLength(1);
    expect(snap.sources[0]!.falsified).toBe(0);
  });
});

describe("project: contradictions", () => {
  const conflict = () => {
    const b = new LogBuilder({ ...testConfig, contradictionIdStart: 3 })
      .source("RF-N")
      .source("CIV", { type: "CIV_CALL", alpha: 5, beta: 7, halfLifeS: 600 });
    b.report(s(0), "CIV", "C-1", { origin: "CALLER-1", quality: 0.5, claims: { intent: "coordinated-pair" } });
    b.report(s(30), "RF-N", "C-1", { quality: 0.6, claims: { intent: "hobbyist" } });
    return b;
  };

  it("opens when a second value has live support, keeping both hypotheses", () => {
    const b = conflict();
    expect(project(b.events, s(10)).contradictions).toHaveLength(0);
    const snap = project(b.events, s(30));
    expect(snap.contradictions).toHaveLength(1);
    const c = snap.contradictions[0]!;
    expect(c.id).toBe("CTR-003");
    expect(c.status).toBe("unresolved");
    expect(c.hypotheses.map((h) => h.value).sort()).toEqual(["coordinated-pair", "hobbyist"]);
    const e = snap.entities[0]!;
    expect(e.flags).toContain("CONTRADICTED");
    // Neither hypothesis is averaged away: each has its own breakdown that sums to its value.
    for (const h of e.hypotheses) expect(sumOf(h.confidence.contributions)).toBeCloseTo(h.confidence.value, 12);
  });

  it("labels the leading hypothesis CAND-A at the moment of opening", () => {
    const snap = project(conflict().events, s(30));
    const labels = Object.fromEntries(snap.contradictions[0]!.hypotheses.map((h) => [h.value, h.label]));
    expect(labels).toEqual({ hobbyist: "CAND-A", "coordinated-pair": "CAND-B" });
  });

  it("records a deferral without changing any confidence", () => {
    const b = conflict();
    const before = project(b.events, s(40));
    b.add({ kind: "operator_action", t: s(40), operatorId: "OP-2", action: "defer", entityId: "C-1", dimension: "intent" });
    const deferred = project(b.events, s(40));
    expect(deferred.contradictions[0]!.status).toBe("deferred");
    expect(deferred.contradictions[0]!.actedBy).toBe("OP-2");
    expect(deferred.entities[0]!.hypotheses).toEqual(before.entities[0]!.hypotheses);
    expect(deferred.entities[0]!.confidence).toEqual(before.entities[0]!.confidence);
  });

  it("treats a resolution as evidence: operator vote for the accepted value, rejected value to zero", () => {
    const b = conflict();
    const before = project(b.events, s(50)).entities[0]!;
    b.add({ kind: "operator_action", t: s(50), operatorId: "OP-1", action: "resolve", entityId: "C-1", dimension: "intent", value: "hobbyist" });
    const snap = project(b.events, s(50));
    const e = snap.entities[0]!;
    const accepted = e.hypotheses.find((h) => h.value === "hobbyist")!;
    const rejected = e.hypotheses.find((h) => h.value === "coordinated-pair")!;
    const beforeAccepted = before.hypotheses.find((h) => h.value === "hobbyist")!;

    expect([accepted.status, rejected.status]).toEqual(["accepted", "rejected"]);
    expect(rejected.confidence).toEqual({ value: 0, contributions: [] });
    expect(accepted.confidence.value).toBeGreaterThan(beforeAccepted.confidence.value);
    // The operator is a visible contribution, and the caller who asserted the rejected value now counts for the accepted one.
    const origins = accepted.confidence.contributions.map((c) => c.originId).sort();
    expect(origins).toEqual(["CALLER-1", "OP-1", "RF-N"]);
    const op = accepted.confidence.contributions.find((c) => c.originId === "OP-1")!;
    expect([op.sourceType, op.extraction, op.reliability]).toEqual(["OPERATOR", "human", 0.8]);
    expect(sumOf(accepted.confidence.contributions)).toBeCloseTo(accepted.confidence.value, 12);
    // Existence confidence gains the operator's vote too.
    expect(e.confidence.value).toBeGreaterThan(before.confidence.value);

    const c = snap.contradictions[0]!;
    expect([c.status, c.resolvedValue, c.actedBy]).toEqual(["resolved", "hobbyist", "OP-1"]);
    expect(c.hypotheses.find((h) => h.value === "coordinated-pair")).toMatchObject({ status: "rejected", confidence: 0 });
    expect(e.flags).not.toContain("CONTRADICTED");
    expect(snap.operatorActions.map((a) => a.contradictionId)).toEqual(["CTR-003"]);
    // The virtual OPERATOR source is listed, but it is not a feed.
    expect(snap.sources.some((x) => x.id === "OPERATOR")).toBe(true);
    expect(snap.feedHealth.some((f) => f.sourceType === "OPERATOR")).toBe(false);
  });

  it("reopens when fresh live evidence for a rejected value arrives after the resolution", () => {
    const b = conflict();
    b.add({ kind: "operator_action", t: s(50), operatorId: "OP-1", action: "resolve", entityId: "C-1", dimension: "intent", value: "hobbyist" });
    b.report(s(80), "CIV", "C-1", { origin: "CALLER-9", quality: 0.6, claims: { intent: "coordinated-pair" } });
    const snap = project(b.events, s(80));
    const c = snap.contradictions[0]!;
    expect([c.status, c.reopened, c.statusSinceT, c.resolvedValue]).toEqual(["unresolved", true, s(80), undefined]);
    const pair = snap.entities[0]!.hypotheses.find((h) => h.value === "coordinated-pair")!;
    expect(pair.status).toBe("open");
    expect(pair.confidence.value).toBeGreaterThan(0);
    expect(snap.entities[0]!.flags).toContain("CONTRADICTED");
    // A fresh resolution settles it again.
    b.add({ kind: "operator_action", t: s(90), operatorId: "OP-1", action: "resolve", entityId: "C-1", dimension: "intent", value: "coordinated-pair" });
    const again = project(b.events, s(90)).contradictions[0]!;
    expect([again.status, again.resolvedValue, again.reopened]).toEqual(["resolved", "coordinated-pair", undefined]);
  });

  it("can be switched back to resolution-as-record-only", () => {
    const b = new LogBuilder({ ...testConfig, operator: { ...testConfig.operator, resolutionIsEvidence: false } })
      .source("RF-N")
      .source("CIV", { type: "CIV_CALL", alpha: 5, beta: 7, halfLifeS: 600 });
    b.report(s(0), "CIV", "C-1", { origin: "CALLER-1", quality: 0.5, claims: { intent: "coordinated-pair" } });
    b.report(s(30), "RF-N", "C-1", { quality: 0.6, claims: { intent: "hobbyist" } });
    const before = project(b.events, s(50)).entities[0]!;
    b.add({ kind: "operator_action", t: s(50), operatorId: "OP-1", action: "resolve", entityId: "C-1", dimension: "intent", value: "hobbyist" });
    const after = project(b.events, s(50));
    expect(after.contradictions[0]!.status).toBe("resolved");
    expect(after.entities[0]!.confidence).toEqual(before.confidence);
    expect(after.entities[0]!.hypotheses.map((h) => h.confidence)).toEqual(before.hypotheses.map((h) => h.confidence));
  });

  it("lapses when support for all but one value has decayed", () => {
    const snap = project(conflict().events, s(30 + 3600));
    expect(snap.contradictions[0]!.status).toBe("lapsed");
  });

  it("does not open for two reports agreeing on a value", () => {
    const b = new LogBuilder().source("RF-1").source("RF-2");
    b.report(s(0), "RF-1", "C-1", { claims: { intent: "hobbyist" } });
    b.report(s(1), "RF-2", "C-1", { claims: { intent: "hobbyist" } });
    expect(project(b.events, s(1)).contradictions).toHaveLength(0);
  });
});

describe("project: ghosts", () => {
  it("turns a contact into a ghost with a growing envelope once fixes stop", () => {
    const b = new LogBuilder().source("RF-1");
    b.report(s(0), "RF-1", "TRK-1");
    expect(project(b.events, s(10)).entities[0]!.state).toBe("active");
    const g1 = project(b.events, s(120)).entities[0]!;
    const g2 = project(b.events, s(1200)).entities[0]!;
    expect(g1.state).toBe("ghost");
    expect(g2.envelopeRadiusM!).toBeGreaterThan(g1.envelopeRadiusM!);
    expect(g2.maxReachM!).toBeGreaterThan(g2.envelopeRadiusM!);
    expect(g2.confidenceAtLastFix).toBeCloseTo(0.54, 12);
  });

  it("keeps a ghost on the picture until its retention expires, even at near-zero confidence", () => {
    const b = new LogBuilder().source("RF-1");
    b.report(s(0), "RF-1", "TRK-1");
    expect(project(b.events, s(3000)).entities).toHaveLength(1);
    expect(project(b.events, s(3601)).entities).toHaveLength(0);
  });
});

describe("project: deception flags", () => {
  const burst = (spacingS: number, reliability: [number, number] = [2, 9]) => {
    const b = new LogBuilder().source("SOC", { type: "SOCIAL", alpha: reliability[0], beta: reliability[1], halfLifeS: 900 });
    for (let i = 0; i < 6; i++) b.report(s(i * spacingS), "SOC", "TRK-70", { origin: `ACCT-${i}`, position: offsetM(CENTER, i * 50, 0) });
    return b;
  };

  it("raises a flag for six low-reliability origins inside the burst window", () => {
    const snap = project(burst(7).events, s(40));
    expect(snap.flags).toHaveLength(1);
    expect(snap.flags[0]!.count).toBe(6);
    expect(snap.entities[0]!.flags).toContain("DECEPTION_FLAG");
  });

  it("counts a flagged burst as one shared vote", () => {
    const e = project(burst(7).events, s(40)).entities[0]!;
    expect(e.sourceCount).toBe(1);
    expect(e.confidence.contributions).toHaveLength(1);
    const vote = e.confidence.contributions[0]!;
    expect(vote.originId).toMatch(/^DF-/);
    expect(vote.members).toEqual(["ACCT-0", "ACCT-1", "ACCT-2", "ACCT-3", "ACCT-4", "ACCT-5"]);
    expect(e.confidence.value).toBeCloseTo(vote.weight, 12);
  });

  it("uses independent votes again when collapsing is switched off", () => {
    const b2 = new LogBuilder({ ...testConfig, deception: { ...testConfig.deception, collapseFlaggedOrigins: false } }).source("SOC", { type: "SOCIAL", alpha: 2, beta: 9, halfLifeS: 900 });
    for (let i = 0; i < 6; i++) b2.report(s(i * 7), "SOC", "TRK-70", { origin: `ACCT-${i}`, position: offsetM(CENTER, i * 50, 0) });
    const snap = project(b2.events, s(40));
    expect(snap.flags).toHaveLength(1);
    expect(snap.entities[0]!.sourceCount).toBe(6);
    expect(snap.entities[0]!.confidence.value).toBeGreaterThan(project(burst(7).events, s(40)).entities[0]!.confidence.value);
  });

  it("restores independent votes once the flag expires", () => {
    const e = project(burst(7).events, s(35 + 601)).entities[0]!;
    expect(e.confidence.contributions.every((c) => c.members === undefined)).toBe(true);
  });

  it("does not flag the same number of reports spread out like independent observers", () => {
    expect(project(burst(90).events, s(460)).flags).toHaveLength(0);
  });

  it("does not flag a burst from reliable sources", () => {
    expect(project(burst(7, [9, 1]).events, s(40)).flags).toHaveLength(0);
  });

  it("drops the flag after its retention period", () => {
    expect(project(burst(7).events, s(35 + 601)).flags).toHaveLength(0);
  });
});

describe("project: coverage and feed health", () => {
  it("moves a footprint to lost when its source goes down", () => {
    const b = new LogBuilder().source("RF-1", { radiusM: 2000 }).source("RF-2");
    const near = offsetM(CENTER, 500, 0);
    expect(isCovered(project(b.events, s(0)).coverage, near)).toBe(true);
    b.add({ kind: "source_status", t: s(10), sourceId: "RF-1", status: "down" });
    const snap = project(b.events, s(10));
    expect(isCovered(snap.coverage, near)).toBe(false);
    expect(isCoverageLost(snap.coverage, near)).toBe(true);
    expect(isCoverageLost(snap.coverage, offsetM(CENTER, 5000, 0))).toBe(false);
    expect(snap.feedHealth).toEqual([{ sourceType: "RF", up: 1, total: 2, status: "degraded" }]);
  });

  it("counts a degraded source as still seeing but not healthy", () => {
    const b = new LogBuilder().source("RF-1", { radiusM: 2000 });
    b.add({ kind: "source_status", t: s(10), sourceId: "RF-1", status: "degraded" });
    const snap = project(b.events, s(10));
    expect(isCovered(snap.coverage, CENTER)).toBe(true);
    expect(snap.feedHealth[0]!.status).toBe("degraded");
    expect(snap.feedHealth[0]!.up).toBe(0);
  });
});

describe("EventLog", () => {
  it("assigns increasing seqs and refuses to rewrite the past", () => {
    const log = new EventLog();
    const a = log.append({ kind: "source_status", t: T0, sourceId: "X", status: "up" });
    const b = log.append({ kind: "source_status", t: T0 + 1, sourceId: "X", status: "down" });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(() => log.append({ kind: "source_status", t: T0, sourceId: "X", status: "up" })).toThrow(/backwards/);
    expect(() => log.push({ ...b, t: T0 + 2 })).toThrow(/seq must increase/);
    expect(log.since(1).map((e) => e.seq)).toEqual([2]);
    expect(Object.isFrozen(log.all()[0])).toBe(true);
  });
});

describe("validateOperatorAction", () => {
  const b = new LogBuilder().source("RF-N").source("CIV", { type: "CIV_CALL", alpha: 5, beta: 7, halfLifeS: 600 });
  b.report(s(0), "CIV", "C-1", { origin: "CALLER-1", quality: 0.5, claims: { intent: "coordinated-pair" } });
  b.report(s(30), "RF-N", "C-1", { quality: 0.6, claims: { intent: "hobbyist" } });
  const snap = project(b.events, s(30));
  const base = { operatorId: "OP-1", entityId: "C-1", dimension: "intent" };

  it("accepts resolve to a live value and defer on an unresolved contradiction", () => {
    expect(validateOperatorAction(snap, { ...base, action: "resolve", value: "hobbyist" })).toBeUndefined();
    expect(validateOperatorAction(snap, { ...base, action: "defer" })).toBeUndefined();
  });

  it("explains what is wrong otherwise", () => {
    expect(validateOperatorAction(snap, { ...base, action: "resolve", value: "space" })).toMatch(/must be one of/);
    expect(validateOperatorAction(snap, { ...base, entityId: "X", action: "defer" })).toMatch(/no contradiction/);
    expect(validateOperatorAction(snap, { ...base, operatorId: "", action: "defer" })).toMatch(/operatorId/);
    const b2 = new LogBuilder().source("RF-N").source("CIV", { type: "CIV_CALL", alpha: 5, beta: 7, halfLifeS: 600 });
    b2.report(s(0), "CIV", "C-1", { origin: "CALLER-1", quality: 0.5, claims: { intent: "coordinated-pair" } });
    b2.report(s(30), "RF-N", "C-1", { quality: 0.6, claims: { intent: "hobbyist" } });
    b2.add({ kind: "operator_action", t: s(40), operatorId: "OP-2", action: "defer", entityId: "C-1", dimension: "intent" });
    expect(validateOperatorAction(project(b2.events, s(40)), { ...base, action: "defer" })).toMatch(/already deferred/);
    expect(validateOperatorAction(project(b2.events, s(40)), { ...base, action: "resolve", value: "hobbyist" })).toBeUndefined();
  });
});
