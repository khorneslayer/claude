import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clockToMillis, project, type LogEvent } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { FeedStore } from "../src/feed/store";
import { buildLegacyModel } from "../src/model/legacy";
import { timelineMarks } from "../src/model/timeline";

const def = loadScenarioFile(fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url)));
const compiled = compileScenario(def);
const key = project(compiled.events, compiled.meta.keyFrame!);
const at = (clock: string) => compiled.events.find((e) => new Date(e.t).toISOString().slice(11, 19) >= clock)!.t;

describe("replay: the picture exactly as it stood", () => {
  const store = new FeedStore();
  store.onEvents(compiled.events, true);

  it("matches a from-scratch projection at any moment, scrubbing forwards and backwards", () => {
    const { logStart, end } = compiled.meta;
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }), (fs) => {
        for (const f of fs) {
          const t = Math.round(logStart + f * (end - logStart));
          expect(store.snapshotAt(t)).toEqual(project(compiled.events, t));
        }
      }),
      { numRuns: 25 },
    );
  });

  it("does not see later decisions: CTR-003 is unresolved before OP-2 deferred it", () => {
    const before = store.snapshotAt(at("14:36:00"));
    const after = store.snapshotAt(at("14:37:30"));
    expect(before.contradictions.map((c) => `${c.id}:${c.status}`)).toEqual(["CTR-003:unresolved"]);
    expect(after.contradictions.map((c) => `${c.id}:${c.status}`)).toEqual(["CTR-003:deferred"]);
  });

  it("keeps working as the live log grows", () => {
    const s = new FeedStore();
    const cut = compiled.events.findIndex((e) => e.t > compiled.meta.playFrom);
    s.onEvents(compiled.events.slice(0, cut), true);
    const t = compiled.meta.playFrom - 60_000;
    const a = s.snapshotAt(t);
    s.onEvents(compiled.events.slice(cut) as LogEvent[]);
    expect(s.snapshotAt(t)).toEqual(a);
    expect(s.snapshotAt(compiled.meta.keyFrame!)).toEqual(key);
  });
});

describe("LEGACY view: a fair copy of a fielded COP", () => {
  const tracks = buildLegacyModel(key);
  const track = (id: string) => tracks.find((t) => t.id === id)!;

  it("shows one fused track per contact and drops tracks after the drop timer, never ageing them", () => {
    expect(tracks.map((t) => t.id)).toEqual(["DLH4KT", "EZY91HB", "TRK-1147", "TRK-1155", "TRK-1160", "TRK-1170"]);
    // TRK-1152 (41 min without an update) is dropped; until then it would have looked like any other track.
    const soon = buildLegacyModel(project(compiled.events, clockToMillis(def.date, "14:04:00"))).find((t) => t.id === "TRK-1152");
    expect(soon?.sidc).toBe("SUAPMFQ--------"); // 3.5 min without an update: drawn exactly like a fresh track
    expect(buildLegacyModel(project(compiled.events, clockToMillis(def.date, "14:06:00"))).some((t) => t.id === "TRK-1152")).toBe(false);
  });

  it("resolves competing readings silently to the best score", () => {
    expect(track("TRK-1155").classification).toEqual({ intent: "hobbyist" });
    expect(track("TRK-1155").label).toEqual(["TRK-1155", "UAS · HOBBYIST"]);
    expect(track("TRK-1147").label[1]).toBe("UAS · ALT BELOW 120M");
  });

  it("draws every UAS with the same standard symbol, whatever its confidence", () => {
    const sidcs = new Set(tracks.filter((t) => t.affiliation === "unknown").map((t) => t.sidc));
    expect([...sidcs]).toEqual(["SUAPMFQ--------"]);
    expect(track("TRK-1160").sidc).toBe(track("TRK-1147").sidc);
  });

  it("shows the planted swarm as an ordinary track", () => {
    expect(track("TRK-1170").label[1]).toBe("UAS · HOSTILE SWARM");
  });

  it("keeps track quality as a number, as fielded systems do", () => {
    expect(track("TRK-1147").trackQuality).toBe(14); // 0.93
    expect(track("TRK-1160").trackQuality).toBe(3); // 0.19
  });
});

describe("timeline marks", () => {
  it("marks the moments worth jumping back to", () => {
    const marks = timelineMarks(compiled.events, key).filter((m) => m.t >= compiled.meta.logStart);
    const labels = marks.map((m) => `${new Date(m.t).toISOString().slice(11, 19)} ${m.kind}: ${m.label}`);
    expect(labels).toEqual(
      expect.arrayContaining([
        "14:24:00 verdict: POLICE-UNIT-7 falsified a SOCIAL-SCRAPE report",
        "14:33:00 contradiction: CTR-003 opened · TRK-1147 altitude band",
        "14:37:10 decision: OP-2 deferred CTR-003",
        "14:39:04 contradiction: CTR-004 opened · TRK-1155 intent",
        "14:40:05 sensor: RF-SENSE-SW DOWN · power loss",
      ]),
    );
    expect(marks.some((m) => m.kind === "flag" && /6 reports/.test(m.label))).toBe(true);
    expect(marks.map((m) => m.t)).toEqual([...marks.map((m) => m.t)].sort((a, b) => a - b));
  });
});

describe("timeline lanes", () => {
  it("moves a mark that would overlap its neighbour to the second lane", async () => {
    const { laneMarks } = await import("../src/ui/Timeline");
    const m = (t: number) => ({ t, kind: "decision" as const, label: String(t) });
    const out = laneMarks([m(0), m(5), m(500), m(503), m(506)], 0, 1000);
    expect(out.map((x) => x.lane)).toEqual([0, 1, 0, 1, 0]);
  });
});
