import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { betaMean, combineNoisyOr, decayFactor, evidenceWeight, MAX_WEIGHT, roundPreservingSum, uncertaintyEnvelope } from "../src";

const weight = fc.double({ min: 0, max: 1, noNaN: true });

describe("decayFactor", () => {
  it("is 1 at zero age and halves every half-life", () => {
    expect(decayFactor(0, 300)).toBe(1);
    expect(decayFactor(300, 300)).toBeCloseTo(0.5, 12);
    expect(decayFactor(600, 300)).toBeCloseTo(0.25, 12);
  });
  it("never exceeds 1 for reports stamped in the future", () => {
    expect(decayFactor(-5, 300)).toBe(1);
  });
});

describe("evidenceWeight", () => {
  it("is the product of reliability, quality and decay, capped below certainty", () => {
    expect(evidenceWeight(0.9, 0.5, 0.8)).toBeCloseTo(0.36, 12);
    expect(evidenceWeight(1, 1, 1)).toBe(MAX_WEIGHT);
  });
});

describe("betaMean", () => {
  it("is alpha / (alpha + beta)", () => {
    expect(betaMean(10, 1)).toBeCloseTo(0.909, 3);
    expect(betaMean(2, 10)).toBeCloseTo(0.1667, 4);
  });
});

describe("combineNoisyOr", () => {
  it("is 0 with no evidence and w with one piece", () => {
    expect(combineNoisyOr([]).value).toBe(0);
    expect(combineNoisyOr([0.42]).value).toBeCloseTo(0.42, 12);
  });

  it("matches 1 - prod(1 - w)", () => {
    expect(combineNoisyOr([0.5, 0.5]).value).toBeCloseTo(0.75, 12);
  });

  it("shares always sum to the value (the provenance invariant)", () => {
    fc.assert(
      fc.property(fc.array(weight, { maxLength: 30 }), (ws) => {
        const { value, shares } = combineNoisyOr(ws);
        expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(value, 9);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }),
    );
  });

  it("never decreases when evidence is added", () => {
    fc.assert(
      fc.property(fc.array(weight, { maxLength: 20 }), weight, (ws, extra) => {
        expect(combineNoisyOr([...ws, extra]).value).toBeGreaterThanOrEqual(combineNoisyOr(ws).value - 1e-12);
      }),
    );
  });

  it("does not depend on input order", () => {
    fc.assert(
      fc.property(fc.array(weight, { minLength: 1, maxLength: 12 }), (ws) => {
        const fwd = combineNoisyOr(ws);
        const rev = combineNoisyOr([...ws].reverse());
        expect(rev.value).toBeCloseTo(fwd.value, 12);
        rev.shares.reverse().forEach((s, i) => expect(s).toBeCloseTo(fwd.shares[i]!, 12));
      }),
    );
  });

  it("gives a stronger piece of evidence a larger share", () => {
    const { shares } = combineNoisyOr([0.6, 0.2]);
    expect(shares[0]!).toBeGreaterThan(shares[1]!);
  });
});

describe("roundPreservingSum", () => {
  it("rounded parts add up to the rounded total", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 0.5, noNaN: true }), { maxLength: 10 }), (vs) => {
        const { parts, total } = roundPreservingSum(vs, 2);
        expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(total * 100));
      }),
    );
  });
  it("handles the slide 7 example", () => {
    expect(roundPreservingSum([0.3412, 0.1104, 0.0603]).parts).toEqual([0.34, 0.11, 0.06]);
  });
});

describe("uncertaintyEnvelope", () => {
  const uas = { cruiseSpeedMps: 15, maxSpeedMps: 23, headingPersistenceS: 5, enduranceS: 1800 };

  it("starts at the fix uncertainty", () => {
    const e = uncertaintyEnvelope(0, 50, uas);
    expect(e.plausibleM).toBeCloseTo(50, 6);
    expect(e.reachM).toBeCloseTo(50, 6);
  });

  it("grows with age and never exceeds the kinematic reach", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 7200, noNaN: true }), fc.double({ min: 0, max: 600, noNaN: true }), (a, d) => {
        const e1 = uncertaintyEnvelope(a, 50, uas);
        const e2 = uncertaintyEnvelope(a + d, 50, uas);
        expect(e2.plausibleM).toBeGreaterThanOrEqual(e1.plausibleM - 1e-9);
        expect(e1.plausibleM).toBeLessThanOrEqual(e1.reachM + 1e-9);
      }),
    );
  });

  it("stops the reach growing once endurance is exhausted", () => {
    expect(uncertaintyEnvelope(4000, 50, uas).reachM).toBe(uncertaintyEnvelope(1800, 50, uas).reachM);
  });

  it("gives about 2.4 km for a small UAS lost 41 minutes ago (slide 7)", () => {
    expect(uncertaintyEnvelope(41 * 60, 50, uas).plausibleM).toBeGreaterThan(2200);
    expect(uncertaintyEnvelope(41 * 60, 50, uas).plausibleM).toBeLessThan(2500);
  });
});
