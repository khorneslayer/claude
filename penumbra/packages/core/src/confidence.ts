/**
 * Confidence maths. See docs/M1-DESIGN.md for the rationale.
 *
 *   weight      w_i = reliability(source) x quality_i x 2^(-age_i / halfLife(source))
 *   per origin  W_o = max over that origin's observations of w_i
 *   confidence  C   = 1 - prod_o (1 - W_o)                      (noisy-OR)
 *   share       c_o = C x m_o / sum(m),  m_o = -ln(1 - W_o)     (sums exactly to C)
 */

/** Weights are capped so a single report can never make an entity certain. */
export const MAX_WEIGHT = 0.999;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Fraction of evidential weight left after `ageS` seconds. 1 for zero or negative age. */
export function decayFactor(ageS: number, halfLifeS: number): number {
  if (ageS <= 0) return 1;
  if (!(halfLifeS > 0)) return 0;
  return Math.pow(2, -ageS / halfLifeS);
}

export function evidenceWeight(reliability: number, quality: number, decay: number): number {
  return Math.min(MAX_WEIGHT, clamp01(reliability) * clamp01(quality) * clamp01(decay));
}

/** Posterior mean of a Beta(alpha, beta) reliability. */
export function betaMean(alpha: number, beta: number): number {
  const n = alpha + beta;
  return n > 0 ? alpha / n : 0.5;
}

export interface Combined {
  value: number;
  /** Additive share of each input, same order as the input. Sums to `value`. */
  shares: number[];
}

/**
 * Noisy-OR over independent pieces of evidence, with an order-independent
 * additive decomposition: each input's share is proportional to its
 * evidential mass -ln(1 - w).
 */
export function combineNoisyOr(weights: readonly number[]): Combined {
  const masses = weights.map((w) => -Math.log1p(-Math.min(MAX_WEIGHT, clamp01(w))));
  const total = masses.reduce((a, b) => a + b, 0);
  if (total <= 0) return { value: 0, shares: weights.map(() => 0) };
  const value = -Math.expm1(-total);
  return { value, shares: masses.map((m) => (value * m) / total) };
}

/**
 * Round values to `dp` decimals so the rounded parts still add up to the
 * rounded total (largest-remainder). For the provenance panel: "+0.34 +0.11
 * +0.06 = 0.51" must add up on screen, not just in floating point.
 */
export function roundPreservingSum(values: readonly number[], dp = 2): { parts: number[]; total: number } {
  const scale = 10 ** dp;
  const total = Math.round(values.reduce((a, b) => a + b, 0) * scale);
  const floors = values.map((v) => Math.floor(v * scale));
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  const order = values
    .map((v, i) => ({ i, rem: v * scale - floors[i]! }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  const parts = floors.slice();
  for (let k = 0; remaining > 0 && order.length > 0; k = (k + 1) % order.length, remaining--) parts[order[k]!.i]! += 1;
  return { parts: parts.map((p) => p / scale), total: total / scale };
}

/**
 * Horizontal uncertainty envelopes for a contact that has stopped reporting.
 *
 * plausible: 1-sigma radius of a correlated random walk (Ornstein-Uhlenbeck
 *   velocity). For age >> persistence, the per-axis displacement variance is
 *   2 v^2 tau t. This is where the object most likely is.
 * reach: hard kinematic bound, max speed x min(age, endurance). This is where
 *   it could possibly be.
 */
export function uncertaintyEnvelope(
  ageS: number,
  sigma0M: number,
  p: { cruiseSpeedMps: number; maxSpeedMps: number; headingPersistenceS: number; enduranceS: number },
): { plausibleM: number; reachM: number } {
  const age = Math.max(0, ageS);
  const tau = Math.max(1e-6, p.headingPersistenceS);
  // Exact OU displacement variance: 2 v^2 tau (t - tau (1 - e^{-t/tau})).
  const varWalk = 2 * p.cruiseSpeedMps ** 2 * tau * (age - tau * (1 - Math.exp(-age / tau)));
  const reachM = sigma0M + p.maxSpeedMps * Math.min(age, p.enduranceS);
  const plausibleM = Math.min(reachM, Math.sqrt(sigma0M ** 2 + Math.max(0, varWalk)));
  return { plausibleM, reachM };
}
