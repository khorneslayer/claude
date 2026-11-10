import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { project, type VerificationEvent } from "@penumbra/core";
import { compileScenario, loadScenarioFile } from "@penumbra/sim";
import { chainOf, defaultSelection, provenance, reconcileSelection, registerCards, sourceRows, type Lookups } from "../src/model/panels";

const def = loadScenarioFile(fileURLToPath(new URL("../../../scenarios/ber-south-uas-surge.yaml", import.meta.url)));
const compiled = compileScenario(def);
const obs = new Map(compiled.events.flatMap((e) => (e.kind === "observation" ? [[e.obsId, e] as const] : [])));
const verdicts = new Map(compiled.events.flatMap((e) => (e.kind === "verification" ? [[e.obsId, e as VerificationEvent] as const] : [])));
const look: Lookups = { obs: (id) => obs.get(id), verdict: (id) => verdicts.get(id) };
const key = project(compiled.events, compiled.meta.keyFrame!);
const end = project(compiled.events, compiled.meta.end);

describe("contradiction register (slide 7, left)", () => {
  const cards = registerCards(key, look);

  it("lists the newest contradiction first with its live status", () => {
    expect(cards.map((c) => `${c.id} · ${c.statusText}`)).toEqual(["CTR-004 · UNRESOLVED", "CTR-003 · DEFERRED 04:12"]);
    expect(cards.map((c) => c.tone)).toEqual(["alert", "parked"]);
  });

  it("explains each contradiction in a sentence", () => {
    expect(cards[0]!.summary).toBe("Two hypotheses for one contact. RF bearing says hobbyist; two civilian calls say coordinated pair.");
    expect(cards[1]!.summary).toBe("Altitude conflict, TRK-1147. EO says below 120m; RF says above 300m. Deferred by OP-2.");
  });

  it("selects the leading candidate when a card is clicked", () => {
    expect(cards[0]!.select).toEqual({ entityId: "TRK-1155", label: "CAND-A" });
  });

  it("reads as resolved after OP-1's decision, with the rejected reading struck", () => {
    const c = registerCards(end, look)[0]!;
    expect(c.statusText).toBe("RESOLVED · HOBBYIST");
    expect(c.summary).toMatch(/Resolved as hobbyist by OP-1\.$/);
    expect(c.hypotheses.map((h) => h.status)).toEqual(["accepted", "rejected"]);
  });
});

describe("source reliability (slide 7, left)", () => {
  it("shows the slide 7 values with tone by reliability", () => {
    const rows = Object.fromEntries(sourceRows(key).map((r) => [r.id, `${r.reliability.toFixed(2)} ${r.tone}`]));
    expect(rows).toMatchObject({ "RF-SENSE-N": "0.91 high", "ADS-B-FEED": "0.88 high", "CIV-CALL-LINE": "0.42 mid", "SOCIAL-SCRAPE": "0.17 low" });
    expect(sourceRows(key).find((r) => r.id === "RF-SENSE-SW")!.note).toBe("DOWN");
    expect(sourceRows(key).find((r) => r.id === "SOCIAL-SCRAPE")!.note).toBe("+0 −1");
  });
});

describe("provenance (slide 7, right)", () => {
  it("opens on CAND-A of the newest open contradiction", () => {
    expect(defaultSelection(key)).toEqual({ entityId: "TRK-1155", label: "CAND-A" });
  });

  it("decomposes CAND-A as on slide 7, with plain-language rows", () => {
    const p = provenance({ entityId: "TRK-1155", label: "CAND-A" }, key, look)!;
    expect([p.title, p.subtitle, p.value]).toEqual(["CAND-A", "TRK-1155 · intent = hobbyist", 0.51]);
    expect(p.rows.map((r) => `${r.heading} | ${r.description} +${r.contribution.toFixed(2)}`)).toEqual([
      "RF-SENSE-N · 14:39:04Z | Bearing only. +0.34",
      "CALLER-2 · 14:36:51Z | Unverified voice report. +0.11",
      "SOC-ACCT-118 · 14:30:12Z | Low reliability, AI-extracted. +0.06",
    ]);
    expect(p.chain.join(" → ")).toBe("INGEST / SCRAPE → NL PARSE → CORRELATE → FUSION OUT → PENUMBRA");
  });

  it("offers RESOLVE for the selected candidate and DEFER for the unresolved contradiction", () => {
    const a = provenance({ entityId: "TRK-1155", label: "CAND-A" }, key, look)!.action;
    expect(a).toMatchObject({ contradictionId: "CTR-004", dimension: "intent", resolveValue: "hobbyist", canResolve: true, canDefer: true });
  });

  it("allows resolving but not re-deferring a deferred contradiction", () => {
    const a = provenance({ entityId: "TRK-1147", label: "CAND-B" }, key, look)!.action;
    expect(a).toMatchObject({ contradictionId: "CTR-003", resolveValue: "above-300m", canResolve: true, canDefer: false });
  });

  it("asks for a candidate when the whole contact is selected", () => {
    const a = provenance({ entityId: "TRK-1155" }, key, look)!.action;
    expect(a.canResolve).toBe(false);
    expect(a.hint).toBe("Select a candidate of CTR-004 to resolve it.");
  });

  it("names the operator and the verifier after the resolution", () => {
    const p = provenance({ entityId: "TRK-1155", label: "CAND-A" }, end, look)!;
    expect(p.status).toBe("accepted");
    expect(p.rows[0]!.description).toBe("Operator decision.");
    expect(p.rows.find((r) => r.heading.startsWith("RF-SENSE-N"))!.description).toBe("Verified by POLICE-UNIT-7.");
    expect(p.action.canResolve).toBe(false);
  });

  it("describes a flagged burst as one coordinated vote", () => {
    const p = provenance({ entityId: "TRK-1170" }, key, look)!;
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.description).toBe("One vote for 6 coordinated accounts (deception flag).");
  });

  it("falls back to the contact once its selected candidate is rejected", () => {
    expect(reconcileSelection({ entityId: "TRK-1155", label: "CAND-B" }, end)).toEqual({ entityId: "TRK-1155" });
    expect(reconcileSelection({ entityId: "TRK-1155", label: "CAND-A" }, end)).toEqual({ entityId: "TRK-1155", label: "CAND-A" });
    expect(reconcileSelection({ entityId: "NOPE" }, end)).toBeUndefined();
  });

  it("rounds contributions so they add up on screen", () => {
    for (const e of key.entities) {
      const p = provenance({ entityId: e.id }, key, look)!;
      const sum = p.rows.reduce((a, r) => a + r.contribution, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(p.value * 100));
    }
  });

  it("merges a single chain unchanged", () => {
    const one = key.entities.find((e) => e.id === "TRK-1147")!.confidence;
    expect(chainOf(one)).toEqual(["INGEST", "CORRELATE", "FUSION OUT", "PENUMBRA"]);
  });
});
