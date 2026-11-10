import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { offsetM, project } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { BLIND, boundsAround, computeCoverageMask, COVERED, coverageKey, LOST } from "../src/model/coverage";
import { placeLabels } from "../src/model/place";
import { age, buildRenderModel, sectorName } from "../src/model/view";
import { feedChips } from "../src/ui/Header";

const def = loadScenarioFile(fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url)));
const compiled = compileScenario(def);
const obs = new Map(compiled.events.flatMap((e) => (e.kind === "observation" ? [[e.obsId, e] as const] : [])));
const lookup = (id: string) => obs.get(id);
const key = project(compiled.events, compiled.meta.keyFrame!);
const model = buildRenderModel(key, lookup);
const glyph = (id: string) => model.glyphs.find((g) => g.id === id)!;
const center = compiled.meta.area.center;

describe("render model at the key frame (slide 7)", () => {
  it("draws every contact once, splitting only the contradicted contact into candidates", () => {
    expect(model.glyphs.map((g) => `${g.id}:${g.kind}:${g.category}`).sort()).toEqual([
      "DLH4KT:track:cooperative",
      "EZY91HB:track:cooperative",
      "TRK-1147:track:corroborated",
      "TRK-1152:ghost:ghost",
      "TRK-1155:CAND-A:candidate:contradicted",
      "TRK-1155:CAND-B:candidate:contradicted",
      "TRK-1160:track:degraded",
      "TRK-1170:track:flagged",
    ]);
  });

  it("keeps TRK-1147 corroborated while its altitude conflict is deferred, and tags it", () => {
    const g = glyph("TRK-1147");
    expect(g.label).toEqual(["TRK-1147 · CTR-003 DEFERRED", expect.stringMatching(/^CONF 0\.93 · 4 SRC · \d+s$/)]);
    expect(g.rings).toBe(4);
  });

  it("labels the competing hypotheses as on slide 7, with neither averaged away", () => {
    expect(glyph("TRK-1155:CAND-A").label).toEqual(["CAND-A · HOBBYIST", "CONF 0.51 · RF BEARING"]);
    expect(glyph("TRK-1155:CAND-B").label).toEqual(["CAND-B · COORDINATED PAIR", "CONF 0.44 · 2 CIV CALLS"]);
    expect(model.links).toHaveLength(1);
  });

  it("draws the RF bearing behind CAND-A as a wedge from the sensor, not a point", () => {
    expect(model.wedges).toHaveLength(1);
    const w = model.wedges[0]!;
    expect(w.id).toContain("CAND-A");
    const rfN = def.sources.find((x) => x.id === "RF-SENSE-N")!.position!;
    expect(w.polygon[0]).toEqual([rfN[1], rfN[0]]); // the wedge starts at RF-SENSE-N
  });

  it("draws the ghost with its plausible envelope and a faint hard-reach ring", () => {
    expect(glyph("TRK-1152").label).toEqual(["TRK-1152 · GHOST", "LAST CONF 41m · ENVELOPE 2.4km"]);
    expect(model.envelopes.map((e) => e.id).sort()).toEqual(["TRK-1152:plausible", "TRK-1152:reach"]);
  });

  it("marks the faint single-sensor contact as degraded", () => {
    expect(glyph("TRK-1160").label[1]).toMatch(/^CONF 0\.19 · 1 SRC · \d+s · DEGRADED$/);
  });

  it("places one deception flag with spokes to its six reports", () => {
    expect(model.flags).toHaveLength(1);
    expect(model.flags[0]!.label).toEqual(["DECEPTION FLAG", "CORRELATED ARRIVAL TIMING · 6 REPORTS"]);
    expect(model.flags[0]!.reports).toHaveLength(6);
  });

  it("never splits a well-tracked contact: its altitude conflict stays on the track", () => {
    for (const clock of ["14:34:00", "14:36:00", "14:38:40", "14:41:22"]) {
      const t = compiled.events.find((e) => new Date(e.t).toISOString().slice(11, 19) >= clock)!.t;
      const m = buildRenderModel(project(compiled.events, t), lookup);
      expect(m.glyphs.filter((g) => g.entityId === "TRK-1147").map((g) => g.kind)).toEqual(["track"]);
    }
  });

  it("collapses the candidates back into one track once CTR-004 is resolved", () => {
    const end = buildRenderModel(project(compiled.events, compiled.meta.end), lookup);
    expect(end.glyphs.filter((g) => g.entityId === "TRK-1155").map((g) => g.kind)).toEqual(["track"]);
    expect(end.links).toHaveLength(0);
  });
});

describe("coverage mask", () => {
  const bounds = boundsAround(center, 10);
  const cell = (mask: ReturnType<typeof computeCoverageMask>, p: { lat: number; lon: number }) => {
    const c = Math.floor(((p.lon - bounds.west) / (bounds.east - bounds.west)) * mask.cols);
    const r = Math.floor(((bounds.north - p.lat) / (bounds.north - bounds.south)) * mask.rows);
    return mask.cells[r * mask.cols + c];
  };
  const sw = offsetM(center, -3000, -3000);

  it("separates covered, lost and never-covered ground", () => {
    const mask = computeCoverageMask(key.coverage, bounds, 160, 160);
    expect(cell(mask, sw)).toBe(LOST);
    expect(cell(mask, offsetM(center, 500, 300))).toBe(COVERED);
    expect(cell(mask, { lat: bounds.north - 0.001, lon: bounds.east - 0.001 })).toBe(BLIND);
    expect(mask.lostSources).toEqual(["RF-SENSE-SW"]);
    expect(sectorName(center, mask.lostCentroid!)).toBe("SW");
  });

  it("changes key only when a footprint's status changes", () => {
    const before = project(compiled.events, compiled.meta.playFrom);
    const between = project(compiled.events, compiled.meta.playFrom + 30_000);
    expect(coverageKey(before.coverage)).toBe(coverageKey(between.coverage));
    expect(coverageKey(before.coverage)).not.toBe(coverageKey(key.coverage));
  });
});

describe("header feed chips", () => {
  it("reads like slide 7", () => {
    expect(feedChips(key.feedHealth).map((c) => `${c.text}:${c.tone}`)).toEqual([
      "ADS-B OK:ok",
      "RF SENSE 4/6:degraded",
      "EO OK:ok",
      "CIV REPORTS DEGRADED:down",
    ]);
  });
});

describe("label placement", () => {
  const identity = (p: [number, number]) => p;
  it("puts the first label right and moves a colliding neighbour", () => {
    const placed = placeLabels(
      [
        { id: "a", position: [100, 100], lines: ["AAAAAAAAAAAA", "aaaaaaaaaaaa"], priority: 2 },
        { id: "b", position: [160, 104], lines: ["BBBBBBBBBBBB", "bbbbbbbbbbbb"], priority: 1 },
      ],
      identity,
    );
    expect(placed.get("a")!.anchor).toBe("start");
    expect(placed.get("b")!.anchor).not.toBe("start");
  });

  it("hides a low-priority label with nowhere to go, but never a high-priority one", () => {
    const crowd = (priority: number) =>
      placeLabels(
        [
          { id: "anchor", position: [100, 100], lines: ["X"], priority: 9 },
          { id: "boxed", position: [100, 100], lines: ["BBBBBBBB"], priority },
        ],
        identity,
        [],
        [{ x0: 0, y0: 0, x1: 400, y1: 400 }],
      );
    expect(crowd(3).get("boxed")).toBeNull();
    expect(crowd(6).get("boxed")).not.toBeNull();
  });

  it("formats ages the way the screen does", () => {
    expect([age(0.2), age(42), age(41 * 60), age(3 * 3600)]).toEqual(["1s", "42s", "41m", "3h"]);
  });
});
