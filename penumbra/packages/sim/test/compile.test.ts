import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clockToMillis, isCovered, offsetM, project, Projector, type PictureSnapshot } from "@penumbra/core";
import { compileScenario, loadScenarioFile, parseScenario, ScenarioError } from "../src";

const SCENARIO = fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url));
const def = loadScenarioFile(SCENARIO);
const compiled = compileScenario(def);
const at = (clock: string) => clockToMillis(def.date, clock);

describe("compileScenario: determinism", () => {
  it("produces a byte-identical event stream for the same seed", () => {
    expect(JSON.stringify(compileScenario(def).events)).toBe(JSON.stringify(compiled.events));
    expect(JSON.stringify(compileScenario(loadScenarioFile(SCENARIO)).events)).toBe(JSON.stringify(compiled.events));
  });

  it("produces a different stream for a different seed", () => {
    expect(JSON.stringify(compileScenario(def, { seed: 7 }).events)).not.toBe(JSON.stringify(compiled.events));
  });

  it("emits events in (t, seq) order with contiguous sequence numbers", () => {
    compiled.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      if (i > 0) expect(e.t).toBeGreaterThanOrEqual(compiled.events[i - 1]!.t);
    });
    expect(compiled.events[0]!.kind).toBe("config");
  });

  it("can drop scripted operator actions for a live operator", () => {
    const manual = compileScenario(def, { manualOperator: true });
    expect(manual.events.some((e) => e.kind === "operator_action")).toBe(false);
    expect(compiled.events.some((e) => e.kind === "operator_action")).toBe(true);
  });

  it("resolves verify references to observation ids", () => {
    const v = compiled.events.filter((e) => e.kind === "verification");
    expect(v).toHaveLength(2);
    const ids = new Set(compiled.events.flatMap((e) => (e.kind === "observation" ? [e.obsId] : [])));
    for (const e of v) expect(ids.has(e.obsId)).toBe(true);
  });
});

describe("acceptance properties (any seed, any moment)", () => {
  const seeds = fc.integer({ min: 1, max: 1_000_000 });
  const moment = fc.double({ min: 0, max: 1, noNaN: true });
  const cache = new Map<number, ReturnType<typeof compileScenario>>();
  const get = (seed: number) => {
    if (!cache.has(seed)) cache.set(seed, compileScenario(def, { seed }));
    return cache.get(seed)!;
  };
  const timeOf = (c: ReturnType<typeof compileScenario>, f: number) => Math.round(c.meta.logStart + f * (c.meta.end - c.meta.logStart));

  const checkSums = (snap: PictureSnapshot) => {
    for (const e of snap.entities) {
      const breakdowns = [e.confidence, ...e.hypotheses.map((h) => h.confidence)];
      for (const b of breakdowns) {
        const sum = b.contributions.reduce((a, c) => a + c.contribution, 0);
        expect(Math.abs(sum - b.value)).toBeLessThan(1e-9);
      }
    }
  };

  it("provenance contributions sum to the displayed confidence for every entity and hypothesis", () => {
    fc.assert(
      fc.property(fc.constantFrom(def.seed, 7, 42), moment, (seed, f) => {
        const c = get(seed);
        checkSums(project(c.events, timeOf(c, f)));
      }),
      { numRuns: 60 },
    );
  });

  it("holds for random seeds too", () => {
    fc.assert(
      fc.property(seeds, moment, (seed, f) => {
        const c = get(seed);
        checkSums(project(c.events, timeOf(c, f)));
      }),
      { numRuns: 15 },
    );
  });

  it("the incremental projector always agrees with a from-scratch projection", () => {
    fc.assert(
      fc.property(fc.array(moment, { minLength: 1, maxLength: 6 }), fc.constantFrom(def.seed, 7), (fs, seed) => {
        const c = get(seed);
        const times = fs.map((f) => timeOf(c, f)).sort((a, b) => a - b);
        const p = new Projector();
        let i = 0;
        for (const t of times) {
          while (i < c.events.length && c.events[i]!.t <= t) p.apply(c.events[i++]!);
          expect(p.evaluate(t)).toEqual(project(c.events, t));
        }
      }),
      { numRuns: 20 },
    );
  });

  it("a past picture is reconstructed exactly: future events never leak into it", () => {
    fc.assert(
      fc.property(moment, (f) => {
        const t = timeOf(compiled, f);
        const truncated = compiled.events.filter((e) => e.t <= t);
        expect(project(compiled.events, t)).toEqual(project(truncated, t));
      }),
      { numRuns: 25 },
    );
  });
});

describe("key frame 14:41:22Z reproduces the slide 7 target screen", () => {
  const snap = project(compiled.events, compiled.meta.keyFrame!);
  const entity = (id: string) => snap.entities.find((e) => e.id === id)!;
  const r2 = (x: number) => Math.round(x * 100) / 100;

  it("is the configured key frame", () => {
    expect(compiled.meta.keyFrame).toBe(at("14:41:22"));
  });

  it("shows feed health: ADS-B OK, RF 4/6, civilian reports degraded", () => {
    const h = Object.fromEntries(snap.feedHealth.map((x) => [x.sourceType, x]));
    expect(h.ADSB!.status).toBe("ok");
    expect([h.RF!.up, h.RF!.total, h.RF!.status]).toEqual([4, 6, "degraded"]);
    expect(h.CIV_CALL!.status).toBe("degraded");
  });

  it("CTR-004 unresolved: hobbyist (RF) vs coordinated pair (two civilian calls)", () => {
    const c = snap.contradictions.find((x) => x.id === "CTR-004")!;
    expect(c.status).toBe("unresolved");
    const a = c.hypotheses.find((h) => h.label === "CAND-A")!;
    const b = c.hypotheses.find((h) => h.label === "CAND-B")!;
    expect([a.value, r2(a.confidence), a.assertedBySourceType]).toEqual(["hobbyist", 0.51, { RF: 1 }]);
    expect([b.value, r2(b.confidence), b.assertedBySourceType]).toEqual(["coordinated-pair", 0.44, { CIV_CALL: 2 }]);
  });

  it("CTR-003 altitude conflict on TRK-1147, deferred 04:12 by OP-2", () => {
    const c = snap.contradictions.find((x) => x.id === "CTR-003")!;
    expect([c.entityId, c.dimension, c.status, c.actedBy]).toEqual(["TRK-1147", "altitude_band", "deferred", "OP-2"]);
    expect((snap.t - c.statusSinceT) / 1000).toBe(4 * 60 + 12);
  });

  it("source reliability: RF-SENSE-N 0.91, ADS-B 0.88, civ call line 0.42, social scrape 0.17", () => {
    const rel = Object.fromEntries(snap.sources.map((x) => [x.id, r2(x.reliability)]));
    expect(rel).toMatchObject({ "RF-SENSE-N": 0.91, "ADS-B-FEED": 0.88, "CIV-CALL-LINE": 0.42, "SOCIAL-SCRAPE": 0.17 });
  });

  it("TRK-1147 corroborated: conf 0.93, 4 sources, fresh", () => {
    const e = entity("TRK-1147");
    expect([r2(e.confidence.value), e.sourceCount, e.state]).toEqual([0.93, 4, "active"]);
    expect(e.fixAgeS!).toBeLessThan(3);
  });

  it("TRK-1152 ghost: last fix 41 min ago, envelope about 2.4 km", () => {
    const e = entity("TRK-1152");
    expect(e.state).toBe("ghost");
    expect(Math.round(e.fixAgeS! / 60)).toBe(41);
    expect(Math.round(e.envelopeRadiusM! / 100) / 10).toBe(2.4);
  });

  it("CAND-A provenance decomposes as +0.34 RF, +0.11 civilian call 2, +0.06 social scrape", () => {
    const h = entity("TRK-1155").hypotheses.find((x) => x.label === "CAND-A")!;
    expect(r2(h.confidence.value)).toBe(0.51);
    expect(h.confidence.contributions.map((c) => [c.originId, r2(c.contribution)])).toEqual([
      ["RF-SENSE-N", 0.34],
      ["CALLER-2", 0.11],
      ["SOC-ACCT-118", 0.06],
    ]);
  });

  it("TRK-1160 faint: conf 0.19, single degraded source", () => {
    const e = entity("TRK-1160");
    expect(r2(e.confidence.value)).toBe(0.19);
    expect(e.flags).toEqual(expect.arrayContaining(["SINGLE_SOURCE", "DEGRADED_SOURCE"]));
  });

  it("deception flag: correlated arrival timing, 6 reports", () => {
    expect(snap.flags).toHaveLength(1);
    expect([snap.flags[0]!.reason, snap.flags[0]!.count, snap.flags[0]!.entityIds]).toEqual(["CORRELATED_ARRIVAL_TIMING", 6, ["TRK-1170"]]);
  });

  it("sector SW is blind for drones, though cooperative traffic is still seen there", () => {
    const sw = offsetM({ lat: 52.36, lon: 13.5 }, -4500, -4500);
    expect(isCovered(snap.coverage, sw, "uas")).toBe(false);
    expect(isCovered(snap.coverage, sw, "cooperative")).toBe(true);
    expect(isCovered(project(compiled.events, at("14:40:00")).coverage, sw, "uas")).toBe(true);
  });

  it("the falsified stadium report is gone from the picture", () => {
    expect(snap.entities.find((e) => e.id === "TRK-1139")).toBeUndefined();
  });

  it("the planted swarm burst counts as one vote, so TRK-1170 stays weak", () => {
    const e = entity("TRK-1170");
    expect(e.sourceCount).toBe(1);
    expect(e.confidence.contributions[0]!.members).toHaveLength(6);
    expect(e.confidence.value).toBeLessThan(0.15);
  });

  it("after the key frame, police confirmation and OP-1 resolve CTR-004 as hobbyist", () => {
    const end = project(compiled.events, compiled.meta.end);
    const c = end.contradictions.find((x) => x.id === "CTR-004")!;
    expect([c.status, c.resolvedValue, c.actedBy]).toEqual(["resolved", "hobbyist", "OP-1"]);
    expect(end.sources.find((s) => s.id === "RF-SENSE-N")!.confirmed).toBe(1);
    const hyps = end.entities.find((e) => e.id === "TRK-1155")!.hypotheses;
    const a = hyps.find((h) => h.label === "CAND-A")!;
    const b = hyps.find((h) => h.label === "CAND-B")!;
    expect([a.status, b.status, b.confidence.value]).toEqual(["accepted", "rejected", 0]);
    expect(a.confidence.value).toBeGreaterThan(0.9);
    expect(a.confidence.contributions.map((x) => x.originId)).toEqual(expect.arrayContaining(["OP-1", "RF-SENSE-N", "CALLER-1", "CALLER-3"]));
  });
});

describe("scenario validation", () => {
  const base = () => structuredClone(def) as unknown as Record<string, unknown>;

  it("accepts the reference scenario", () => {
    expect(() => parseScenario(JSON.stringify(def))).not.toThrow();
  });

  it("lists every problem with a path a designer can act on", () => {
    const bad = base();
    (bad.beats as unknown[]).push({ at: "14:00:00", report: { source: "NOPE", entity: "X", sigmaM: 1, quality: 2, position: [52, 13] } });
    (bad.beats as unknown[]).push({ at: "25:99", verify: { ref: "missing", outcome: "maybe", by: "X" } });
    try {
      parseScenario(JSON.stringify(bad));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioError);
      const msg = (e as ScenarioError).problems.join("\n");
      expect(msg).toMatch(/report\.source: unknown source "NOPE"/);
      expect(msg).toMatch(/report\.quality: number in \[0, 1\]/);
      expect(msg).toMatch(/verify\.outcome/);
      expect(msg).toMatch(/verify\.ref: no report with id "missing"/);
    }
  });

  it("rejects a beat with two kinds", () => {
    const bad = base();
    (bad.beats as unknown[]).push({ at: "14:00:00", status: { source: "EO-1", status: "down" }, operator: {} });
    expect(() => parseScenario(JSON.stringify(bad))).toThrow(/exactly one of/);
  });

  it("refuses a verification scheduled before its report", () => {
    const bad = base() as unknown as typeof def;
    bad.beats = bad.beats.map((b) => ("verify" in b && b.verify.ref === "rf-hobbyist" ? { ...b, at: "14:39:00" } : b));
    expect(() => compileScenario(bad)).toThrow(/before it was reported/);
  });
});
