/**
 * Live comparison of a new version on part of a fleet (the canary) with the robots that keep the old one
 * (the control), over the same hours. Every metric is a ratio of two counters summed over robots, such as
 * interventions per active hour or failures per task. Methods and coverage: docs/STATISTICS.md, "Fleet rollouts".
 */
import { normalQuantile } from "./stats.ts";

export interface RobotCounts { robot: string; site: string; arm: "canary" | "control"; counts: Record<string, number> }
/** `margin` is relative: 0.1 tolerates a rate up to 10% worse than the old version's. */
export interface FleetMetric { name: string; num: string; den: string; better: "lower" | "higher"; margin: number }
export interface RatioInterval { ratio: number; lo: number; hi: number }
export type MetricCall = "worse" | "not_worse" | "inconclusive" | "not_enough_data";
export interface MetricResult extends RatioInterval {
  metric: string; better: FleetMetric["better"]; call: MetricCall; limit: number; /** 1/k: how much robots differ beyond chance (0: not at all) */ dispersion: number;
  canary: { events: number; exposure: number; robots: number }; control: { events: number; exposure: number; robots: number };
  /** Per site, at α/sites: a clearly worse site blocks even when the fleet as a whole looks fine. */
  sites: Array<RatioInterval & { site: string; worse: boolean }>;
}
export type RolloutDecision = "roll_back" | "promote" | "continue" | "hold";

/** One site's counts: events and exposure per robot, for each version. */
interface Site { site: string; canary: Array<[number, number]>; control: Array<[number, number]> }
const total = (xs: Array<[number, number]>, i: 0 | 1) => xs.reduce((s, r) => s + r[i], 0);

/**
 * Indirect standardisation: the canary's events against the events the control's rate at the same site
 * predicts for the canary's exposure, so a canary placed at a busy site is not called worse for being there.
 * Robots differ more than a Poisson count allows, so each robot's count gets negative-binomial variance
 * μ(1 + μ/k), with 1/k estimated from the control robots. Each bound is the wider of two: a Wald bound on the
 * log ratio, and a score bound (the ρ at which the canary's count sits z standard deviations from ρ·expected,
 * with the variance taken at ρ). With few canary robots the score bound keeps the upper end honest when they
 * happen to have a quiet day, and the Wald bound keeps the lower end honest; measured coverage in STATISTICS.md.
 */
function interval(sites: Site[], inv: number, z: number): RatioInterval {
  const nb = (mu: number) => mu * (1 + inv * mu);
  const rate = (s: Site) => Math.max(total(s.control, 0), 0.5) / total(s.control, 1); // 0.5: no control events yet
  let O = 0, E = 0, varE = 0;
  for (const s of sites) {
    const r = rate(s), Ec = total(s.canary, 1), Xc = total(s.control, 1);
    O += total(s.canary, 0); E += r * Ec;
    varE += (Ec / Xc) ** 2 * s.control.reduce((v, [, e]) => v + nb(r * e), 0);
  }
  const sd = (rho: number) => Math.sqrt(sites.reduce((v, s) => v + s.canary.reduce((w, [, e]) => w + nb(rho * rate(s) * e), 0), 0) + rho * rho * varE);
  const root = (f: (rho: number) => number, a: number, b: number) => { for (let i = 0; i < 80; i++) { const c = (a + b) / 2; if (f(c) > 0) b = c; else a = c; } return (a + b) / 2; };
  const est = O / E, MAX = 1e6, o = Math.max(O, 0.5);
  const wald = z * Math.sqrt((sd(o / E) ** 2 - (o / E) ** 2 * varE) / (o * o) + varE / (E * E));
  const lo = O === 0 ? 0 : root((rho) => rho * E - O + z * sd(rho), 0, est);
  const hi = (MAX * E - O - z * sd(MAX)) <= 0 ? Infinity : root((rho) => rho * E - O - z * sd(rho), est, MAX);
  return { ratio: est, lo: Math.min(lo, (o / E) * Math.exp(-wald)), hi: Math.max(hi, (o / E) * Math.exp(wald)) };
}

export function compareRates(rows: RobotCounts[], m: FleetMetric, alpha = 0.05, minRobots = 2): MetricResult {
  const pair = (r: RobotCounts): [number, number] => [r.counts[m.num] ?? 0, r.counts[m.den] ?? 0];
  const live = rows.filter((r) => pair(r)[1] > 0);
  const sites: Site[] = [];
  let excess = 0, scale = 0, df = 0;
  for (const site of [...new Set(live.map((r) => r.site))].sort()) {
    const canary = live.filter((r) => r.site === site && r.arm === "canary").map(pair), control = live.filter((r) => r.site === site && r.arm === "control").map(pair);
    if (!canary.length || !control.length) continue; // a site without both versions cannot be compared within itself
    const rate = total(control, 0) / total(control, 1);
    // moments of the control robots: variance beyond Poisson, (y − μ)² − μ, against μ²
    for (const [y, e] of control) { const mu = rate * e; excess += (y - mu) ** 2 - mu; scale += mu * mu; }
    df += control.length - 1;
    sites.push({ site, canary, control });
  }
  const inv = scale > 0 ? Math.max(0, excess / scale) : 0;
  const limit = m.better === "lower" ? 1 + m.margin : 1 - m.margin;
  const all = (arm: "canary" | "control") => sites.flatMap((s) => s[arm]);
  const base = {
    metric: m.name, better: m.better, limit, dispersion: inv,
    canary: { events: total(all("canary"), 0), exposure: total(all("canary"), 1), robots: all("canary").length },
    control: { events: total(all("control"), 0), exposure: total(all("control"), 1), robots: all("control").length },
  };
  if (!sites.length || base.canary.robots < minRobots || df < 2) return { ...base, ratio: NaN, lo: NaN, hi: NaN, call: "not_enough_data", sites: [] };
  const worse = (iv: RatioInterval) => (m.better === "lower" ? iv.lo > limit : iv.hi < limit);
  const fine = (iv: RatioInterval) => (m.better === "lower" ? iv.hi < limit : iv.lo > limit);
  const pooled = interval(sites, inv, normalQuantile(1 - alpha / 2));
  const zSite = normalQuantile(1 - alpha / (2 * sites.length));
  const perSite = sites.length > 1 ? sites.map((s) => { const iv = interval([s], inv, zSite); return { site: s.site, ...iv, worse: worse(iv) }; }) : [];
  const call: MetricCall = worse(pooled) || perSite.some((s) => s.worse) ? "worse" : fine(pooled) ? "not_worse" : "inconclusive";
  return { ...base, ...pooled, call, sites: perSite };
}

const x = (r: number) => `${r.toFixed(2)}×`;
const where = (r: MetricResult) => {
  const pooled = r.better === "lower" ? r.lo > r.limit : r.hi < r.limit, site = r.sites.find((s) => s.worse);
  return site && !pooled ? `${x(site.ratio)} the old version's rate at ${site.site} (between ${x(site.lo)} and ${x(site.hi)})` : `${x(r.ratio)} the old version's rate (between ${x(r.lo)} and ${x(r.hi)})`;
};

/**
 * One planned look at a rollout. Intervals use α/looks (Bonferroni over the looks planned in advance), so
 * looking several times keeps the chance of a false call at most α. Any metric clearly worse rolls back;
 * every metric within its margin promotes; otherwise wait, and after the last look a person decides.
 */
export function decideRollout(rows: RobotCounts[], metrics: FleetMetric[], opts: { look: number; looks: number; alpha?: number; minRobots?: number }):
  { decision: RolloutDecision; results: MetricResult[]; reason: string } {
  const results = metrics.map((m) => compareRates(rows, m, (opts.alpha ?? 0.05) / opts.looks, opts.minRobots));
  const worse = results.filter((r) => r.call === "worse");
  if (worse.length) return { decision: "roll_back", results, reason: worse.map((r) => `${r.metric}: ${where(r)}; the limit is ${x(r.limit)}`).join(". ") };
  if (results.every((r) => r.call === "not_worse")) return { decision: "promote", results, reason: `Every metric is within its margin: ${results.map((r) => `${r.metric} ${x(r.ratio)}`).join(", ")}` };
  const open = results.filter((r) => r.call !== "not_worse").map((r) => r.call === "not_enough_data" ? `${r.metric} (not enough data)` : r.metric).join(", ");
  return opts.look >= opts.looks
    ? { decision: "hold", results, reason: `The planned looks ended without a clear answer for ${open}. A person decides.` }
    : { decision: "continue", results, reason: `Not yet clear for ${open}. Look ${opts.look} of ${opts.looks}.` };
}
