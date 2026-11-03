/**
 * Small-sample statistics for paired robot evaluations. Methods, references
 * and coverage results: docs/STATISTICS.md.
 */

/** Two-sided exact binomial test of k (the smaller count) out of n against p = 0.5: exact McNemar on discordant pairs. */
export function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let logC = 0, tail = 0;
  for (let i = 0; i <= lo; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Wilson score interval: honest at small n and at rates near 0 or 1. */
export function wilson(successes: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const z = normalQuantile(1 - alpha / 2), p = successes / n, z2 = z * z, den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den, half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Interval for a difference of paired proportions: Newcombe (1998), "Improved confidence intervals for the
 * difference between binomial proportions based on paired data", Statistics in Medicine 17:2635, method 10.
 * a: both pass · b: baseline only · c: candidate only · d: both fail. Returns Δ = p(candidate) − p(baseline) and its interval.
 */
export function newcombePaired(a: number, b: number, c: number, d: number, alpha = 0.05): { estimate: number; lo: number; hi: number } {
  const n = a + b + c + d;
  if (n === 0) return { estimate: 0, lo: -1, hi: 1 };
  const p1 = (a + c) / n, p2 = (a + b) / n;
  const [l1, u1] = wilson(a + c, n, alpha), [l2, u2] = wilson(a + b, n, alpha);
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  let num = a * d - b * c;
  if (num > 0) num = Math.max(0, num - n / 2); // Newcombe's continuity adjustment of φ
  const phi = den > 0 ? num / Math.sqrt(den) : 0;
  const lower = Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const upper = Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  const est = p1 - p2;
  return { estimate: est, lo: Math.max(-1, est - lower), hi: Math.min(1, est + upper) };
}

/** Deterministic PRNG (mulberry32), so a report recomputes to the same numbers. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Student t quantile (Cornish–Fisher expansion around the normal; accurate to ~1e-4 for df ≥ 5). */
export function tQuantile(p: number, df: number): number {
  const z = normalQuantile(p), z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

const normalCdf = (x: number) => {
  // Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};

/**
 * Mean paired difference with an expanded percentile bootstrap (Hesterberg 2015, "What teachers should know about
 * the bootstrap", The American Statistician 69:371): resamples whole pairs, and widens the percentile levels to
 * correct the plain percentile interval's under-coverage at small n.
 */
export function pairedBootstrap(diffs: number[], alpha = 0.05, resamples = 10_000, seed = 1): { estimate: number; lo: number; hi: number } {
  const n = diffs.length;
  const expanded = n > 1 ? normalCdf(-Math.sqrt(n / (n - 1)) * tQuantile(1 - alpha / 2, n - 1)) : alpha / 2;
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const r = rng(seed), means = new Float64Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(r() * n)];
    means[i] = s / n;
  }
  const sorted = Array.from(means).sort((x, y) => x - y);
  return { estimate: mean, lo: quantile(sorted, expanded), hi: quantile(sorted, 1 - expanded) };
}

/** The change a paired comparison of n worlds can resolve with 80% power, and the worlds needed to resolve `margin`. */
export function power(sd: number, n: number, margin: number, alpha = 0.05): { resolvable: number; needed: number } {
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(0.8);
  return { resolvable: n > 0 ? (z * sd) / Math.sqrt(n) : Infinity, needed: Math.ceil(((z * sd) / margin) ** 2) };
}

export type MetricVerdict = "meaningfully_improved" | "meaningfully_regressed" | "no_meaningful_change" | "inconclusive";

/** R4.4: [lo, hi] is the interval of the change, signed so that positive is better; margin is the smallest change that matters. */
export function decide(lo: number, hi: number, margin: number): MetricVerdict {
  if (lo > margin) return "meaningfully_improved";
  if (hi < -margin) return "meaningfully_regressed";
  if (lo > -margin && hi < margin) return "no_meaningful_change";
  return "inconclusive";
}
