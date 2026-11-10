import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clockToMillis, destination, offsetM, project } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { expected, MOMENTS, score, summarise, trialsFor, type ProbeResult } from "../src/probe/trials";
import { SessionRecorder } from "../src/session/recorder";

const def = loadScenarioFile(fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url)));
const compiled = compileScenario(def, { manualOperator: true });
const arp = compiled.meta.area.center;
const snapAt = (clock: string) => project(compiled.events, clockToMillis(def.date, clock));
const key = snapAt("14:41:22");

describe("probe: right answers come from the engine's picture", () => {
  it("is well-posed at both moments in both views", () => {
    const table = MOMENTS.flatMap((m) =>
      (["penumbra", "legacy"] as const).flatMap((v) =>
        (["least_reliable", "stale"] as const).map((q) => `${m} ${v} ${q}: ${expected(q, snapAt(m), v, arp).ids!.join("|")}`),
      ),
    );
    expect(table).toEqual([
      "14:41:22 penumbra least_reliable: TRK-1160|TRK-1170",
      "14:41:22 penumbra stale: TRK-1152",
      "14:41:22 legacy least_reliable: TRK-1160|TRK-1170",
      "14:41:22 legacy stale: TRK-1155", // LEGACY has dropped TRK-1152; its stalest displayed track is fair game
      "14:40:55 penumbra least_reliable: TRK-1160",
      "14:40:55 penumbra stale: TRK-1152",
      "14:40:55 legacy least_reliable: TRK-1160",
      "14:40:55 legacy stale: TRK-1155",
    ]);
  });

  it("scores contact answers", () => {
    expect(score("least_reliable", { contact: "TRK-1170" }, key, "penumbra", arp)).toBe(true);
    expect(score("least_reliable", { contact: "TRK-1147" }, key, "penumbra", arp)).toBe(false);
    expect(score("stale", { contact: "TRK-1152" }, key, "penumbra", arp)).toBe(true);
    expect(score("stale", { contact: "TRK-1152" }, key, "legacy", arp)).toBe(false); // not on the LEGACY picture
    expect(score("stale", { skipped: true }, key, "penumbra", arp)).toBe(false);
  });

  it("scores 'where can we not see' by coverage, near the airport only", () => {
    expect(score("blind", { location: destination(arp, 213, 3000) }, key, "penumbra", arp)).toBe(true); // lost SW sector
    expect(score("blind", { location: offsetM(arp, 300, 200) }, key, "legacy", arp)).toBe(false); // covered
    expect(score("blind", { location: offsetM(arp, 9000, 9000) }, key, "penumbra", arp)).toBe(false); // too far out to count
  });
});

describe("probe: trial plan", () => {
  it("asks all three questions in both views, at different moments", () => {
    const t = trialsFor("P-0001");
    expect(t).toHaveLength(6);
    for (const view of ["penumbra", "legacy"]) expect(t.filter((x) => x.view === view).map((x) => x.question).sort()).toEqual(["blind", "least_reliable", "stale"]);
    const at = new Set(t.map((x) => `${x.view}@${x.at}`));
    expect(at.size).toBe(2);
    expect(new Set(t.map((x) => x.at)).size).toBe(2);
    // a view's block is contiguous
    expect(t.slice(0, 3).every((x) => x.view === t[0]!.view)).toBe(true);
  });

  it("is deterministic per participant and counterbalanced across participants", () => {
    expect(trialsFor("P-0042")).toEqual(trialsFor("P-0042"));
    const firsts = new Set<string>();
    const moments = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const t = trialsFor(`P-${i}`);
      firsts.add(t[0]!.view);
      moments.add(t.find((x) => x.view === "penumbra")!.at);
    }
    expect([...firsts].sort()).toEqual(["legacy", "penumbra"]);
    expect(moments.size).toBe(2);
  });

  it("summarises accuracy and median time per view", () => {
    const t = trialsFor("P-1");
    const rs: ProbeResult[] = t.map((trial, i) => ({ trial, correct: trial.view === "penumbra" || i % 2 === 0, latencyMs: trial.view === "penumbra" ? 2000 + i : 6000 + i, answer: {}, expected: "" }));
    const s = summarise(rs);
    expect(s.penumbra.correct).toBe(3);
    expect(s.penumbra.medianMs).toBeLessThan(s.legacy.medianMs);
  });
});

describe("session recorder", () => {
  it("stamps events with context and sends unsent batches as NDJSON", async () => {
    const sent: { url: string; body: string }[] = [];
    let ok = false;
    let clock = 0;
    const r = new SessionRecorder(() => ({ simT: Date.UTC(2026, 8, 12, 14, 41, 22), view: "penumbra", replay: false, mode: "live" }), {
      id: "S-test",
      send: async (url, body) => {
        sent.push({ url, body });
        return ok;
      },
      now: () => clock,
    });
    r.enableRemote(60_000);
    clock = 1500;
    r.log("select", { entityId: "TRK-1155", label: "CAND-A" });
    await r.flush(); // fails: stays queued
    ok = true;
    r.log("action", { action: "resolve" });
    await r.flush();
    await r.flush(); // nothing new
    r.stop();
    expect(sent.map((s) => s.url)).toEqual(["/api/sessions/S-test", "/api/sessions/S-test"]);
    const lines = sent[1]!.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["select", "action"]);
    expect(lines[0]).toMatchObject({ session: "S-test", seq: 1, ms: 1500, sim: "2026-09-12T14:41:22.000Z", view: "penumbra", replay: false, mode: "live" });
    expect(r.toJSONL().trim().split("\n")).toHaveLength(2);
  });
});

describe("probe: blind point helper", () => {
  it("finds an uncovered point near the airport once the SW sensor is down, and none before", async () => {
    const { blindPoint } = await import("../src/probe/trials");
    const p = blindPoint(key, arp)!;
    expect(score("blind", { location: p }, key, "penumbra", arp)).toBe(true);
    expect(blindPoint(snapAt("14:39:30"), arp)).toBeUndefined();
  });
});
