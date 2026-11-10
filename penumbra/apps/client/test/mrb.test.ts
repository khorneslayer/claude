/**
 * KMRB low-cost scenario: the picture a regional airport gets from one RF
 * detector, three commercial cameras and a Remote ID receiver, and whether the
 * legibility probe is well posed on it (same moments as BER).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clockToMillis, isCovered, pointInPolygon, project } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { demoCuesFor, MRB_DEMO_CUES } from "../src/demo/director";
import { layoutFor } from "../src/map/basemap";
import { MRB_LAYOUT } from "../src/map/mrb-layout";
import { buildLegacyModel } from "../src/model/legacy";
import { buildRenderModel } from "../src/model/view";
import { blindPoint, expected, MOMENTS } from "../src/probe/trials";
import { scenarioKey } from "../src/scenarios";
import { feedChips } from "../src/ui/Header";

const def = loadScenarioFile(fileURLToPath(new URL("../../../scenarios/mrb-lowcost-approach.yaml", import.meta.url)));
const compiled = compileScenario(def);
const { meta, events } = compiled;
const obs = new Map(events.flatMap((e) => (e.kind === "observation" ? [[e.obsId, e] as const] : [])));
const lookup = (id: string) => obs.get(id);
const at = (clock: string) => clockToMillis(meta.date, clock);
const key = project(events, meta.keyFrame!);
const model = buildRenderModel(key, lookup);

describe("KMRB key frame", () => {
  it("draws one contact of every kind, none split into candidates", () => {
    expect(model.glyphs.map((g) => `${g.id}:${g.kind}:${g.category}`).sort()).toEqual([
      "EJA519:track:cooperative",
      "TRK-2205:ghost:ghost",
      "TRK-2210:track:contradicted",
      "TRK-2214:track:corroborated",
      "TRK-2220:track:single",
      "TRK-2230:track:flagged",
    ]);
  });

  it("keeps the camera's 'bird' and the RF detector's 'drone' side by side on TRK-2210", () => {
    const c = key.contradictions.find((x) => x.entityId === "TRK-2210")!;
    expect([c.id, c.dimension, c.status]).toEqual(["CTR-005", "object", "unresolved"]);
    const h = key.entities.find((e) => e.id === "TRK-2210")!.hypotheses.map((x) => `${x.label}:${x.value}:${x.confidence.value.toFixed(2)}`);
    expect(h).toEqual(["CAND-A:small-uas:0.51", "CAND-B:bird:0.40"]);
  });

  it("never splits TRK-2210: a bearing-only fix does not displace the camera fix", () => {
    for (let t = meta.playFrom; t <= meta.end; t += 1000) {
      const e = project(events, t).entities.find((x) => x.id === "TRK-2210")!;
      expect(e.position!.sigmaM).toBeLessThan(150);
    }
  });

  it("separates lost coverage (CAM-08) from ground no drone sensor ever covered", () => {
    const lost = key.coverage.lost.map((f) => f.sourceId);
    expect(lost).toEqual(["CAM-08"]);
    // The callers' drone is in ground nobody covers; Remote ID does not count as drone coverage.
    const callers = key.entities.find((e) => e.id === "TRK-2220")!;
    expect(isCovered(key.coverage, callers.position!, "uas")).toBe(false);
  });

  it("shows that covered is not seen: the autonomous drone vanished inside RF coverage", () => {
    const ghost = key.entities.find((e) => e.id === "TRK-2205")!;
    expect(ghost.state).toBe("ghost");
    expect(isCovered(key.coverage, ghost.position!, "uas")).toBe(true);
    expect(events.some((e) => e.kind === "observation" && e.entityId === "TRK-2205" && e.sourceId === "RF-DET-1")).toBe(false);
  });

  it("flags the social swarm as one burst of six, and keeps the honest callers out of it", () => {
    expect(model.flags).toHaveLength(1);
    expect(model.flags[0]!.reports).toHaveLength(6);
    expect(key.entities.find((e) => e.id === "TRK-2220")!.flags).not.toContain("DECEPTION_FLAG");
  });

  it("reads the low-cost kit in the header", () => {
    expect(feedChips(key.feedHealth).map((c) => `${c.text}:${c.tone}`)).toEqual([
      "ADS-B OK:ok",
      "RF SENSE OK:ok",
      "EO 1/3:degraded",
      "REMOTE ID OK:ok",
      "CIV REPORTS OK:ok",
    ]);
  });

  it("LEGACY shows the fake swarm as a hostile track and silently drops the ghost", () => {
    const legacy = buildLegacyModel(key);
    expect(legacy.find((t) => t.id === "TRK-2230")!.classification.intent).toBe("hostile-swarm");
    expect(legacy.some((t) => t.id === "TRK-2205")).toBe(false);
  });
});

describe("KMRB ending", () => {
  it("stays resolved although the camera keeps calling the drone a bird", () => {
    const end = project(events, meta.end);
    const c = end.contradictions.find((x) => x.id === "CTR-005")!;
    expect([c.status, c.resolvedValue, c.reopened]).toEqual(["resolved", "small-uas", undefined]);
    const lateBird = events.filter((e) => e.kind === "observation" && e.entityId === "TRK-2210" && e.claims.object === "bird" && e.t > at("14:41:30"));
    expect(lateBird.length).toBeGreaterThan(5);
  });

  it("leaves the open decision to the operator when playing interactively", () => {
    const manual = compileScenario(def, { manualOperator: true });
    const c = project(manual.events, manual.meta.end).contradictions.find((x) => x.id === "CTR-005")!;
    expect(c.status).toBe("unresolved");
  });
});

describe("KMRB scenario consistency", () => {
  it("every sensor report lies inside that sensor's own footprint", () => {
    const footprints = new Map(events.flatMap((e) => (e.kind === "source_registered" && e.footprint ? [[e.sourceId, e.footprint] as const] : [])));
    const outside = events
      .filter((e) => e.kind === "observation" && e.position && footprints.has(e.sourceId))
      .filter((e) => e.kind === "observation" && !pointInPolygon(e.bearing ? e.bearing.origin : e.position!, footprints.get(e.sourceId)!))
      .map((e) => (e.kind === "observation" ? `${e.sourceId} -> ${e.entityId}` : ""));
    expect([...new Set(outside)]).toEqual([]);
    // Bearing reports: the true target (the entity's camera / Remote ID fix) is within the detector's range.
    const rf = def.sources.find((s) => s.id === "RF-DET-1")!;
    const rfFoot = footprints.get("RF-DET-1")!;
    for (const id of ["TRK-2210", "TRK-2214"]) {
      const e = key.entities.find((x) => x.id === id)!;
      expect(pointInPolygon(e.position!, rfFoot), `${id} within ${rf.id} range`).toBe(true);
    }
  });

  it("uses the same probe moments as BER, and the questions are well posed at both", () => {
    for (const clock of MOMENTS) {
      const snap = project(events, at(clock));
      for (const view of ["penumbra", "legacy"] as const) {
        expect(expected("least_reliable", snap, view, meta.area.center).ids!.length, `${clock} ${view}`).toBeGreaterThan(0);
        expect(expected("stale", snap, view, meta.area.center).ids!.length, `${clock} ${view}`).toBeGreaterThan(0);
      }
      expect(blindPoint(snap, meta.area.center)).toBeDefined();
    }
  });
});

describe("client wiring", () => {
  it("picks the scenario, basemap and demo script by id", () => {
    expect([scenarioKey("mrb"), scenarioKey("mrb-lowcost-approach"), scenarioKey(null), scenarioKey("nope")]).toEqual(["mrb", "mrb", "ber", "ber"]);
    expect(layoutFor(meta.id)).toBe(MRB_LAYOUT);
    expect(layoutFor("ber-south-uas-surge").icao).toBe("EDDB");
    expect(demoCuesFor(meta.id)).toBe(MRB_DEMO_CUES);
  });

  it("selects only contacts that exist when each demo cue fires", () => {
    for (const cue of MRB_DEMO_CUES) {
      if (typeof cue.at !== "string" || !cue.select) continue;
      const snap = project(events, at(cue.at));
      expect(snap.entities.some((e) => e.id === cue.select!.entityId), `${cue.at} ${cue.select.entityId}`).toBe(true);
    }
  });

  it("puts the runway where the chart says: 2687 m at 072 deg true", async () => {
    const { bearingDeg, distanceM } = await import("@penumbra/core");
    const [w, e] = MRB_LAYOUT.RUNWAYS[0]!.path.map(([lon, lat]) => ({ lat, lon }));
    expect(Math.round(distanceM(w!, e!))).toBe(2687);
    expect(bearingDeg(w!, e!)).toBeCloseTo(72, 0);
  });
});
