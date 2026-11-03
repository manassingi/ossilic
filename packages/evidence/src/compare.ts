/**
 * Compare two pieces of evidence world by world (docs/I1-SPEC.md §4–5).
 *
 * Same brain, body and world: a reproduction, judged exactly or within tolerance.
 * Anything else that ran the same test: a change, judged on the suite's primary
 * metric against its margin, with guardrails that can block a release.
 */
import { NOT_POLICY, type ArtifactSummary, type EpisodeResult, type Evidence, type MetricRule, type Suite } from "@ossilic/spec";
import { binomTwoSided, decide, newcombePaired, pairedBootstrap, power, quantile, type MetricVerdict } from "./stats.ts";

export type Verdict = MetricVerdict | "not_comparable" | "invalid_evaluation" | "exact_reproduction" | "equivalent_reproduction" | "did_not_reproduce";

/** Metric verdicts need at least this many valid pairs; below it the bootstrap under-covers (docs/STATISTICS.md). */
export const MIN_METRIC_PAIRS = 30;

export interface Effect {
  rule: MetricRule;
  /** Change, signed so that positive is better, with its interval. */
  estimate: number; lo: number; hi: number;
  pairs: number;
  verdict: MetricVerdict;
  /** The interval excludes zero: a change was detected, whatever its size. */
  detected: boolean;
  /** Not meaningfully worse: the interval's lower end is above −margin. */
  nonInferior: boolean;
  better: number; worse: number;
  median?: number; iqr?: [number, number];
  /** Exact McNemar p-value, for success only. */
  p?: number;
  note?: string;
}

export interface ArtifactChange { kind: "param" | "node" | "edge" | "body" | "file" | "tick"; path: string; from?: unknown; to?: unknown }

export interface Comparison {
  verdict: Verdict;
  /** One plain sentence. */
  reason: string;
  gate: { pass: boolean; reasons: string[] };
  primary?: Effect;
  guardrails: Effect[];
  exploratory: Effect[];
  newlyFailing: number[];
  newlyPassing: number[];
  /** Worlds left out of the paired analysis, with why. Never silently. */
  dropped: Array<{ seed: number; reason: string }>;
  paired: number;
  invalidRate: { base: number; cand: number };
  power?: { metric: string; resolvable: number; needed: number; margin: number };
  changes: ArtifactChange[];
  alpha: number;
  base: { version: string; manifest: string; summary: Evidence["summary"]; accounting: Evidence["accounting"] };
  cand: { version: string; manifest: string; summary: Evidence["summary"]; accounting: Evidence["accounting"] };
}

const passed = (e: EpisodeResult) => e.status === "success";
const valid = (e: EpisodeResult) => !NOT_POLICY.includes(e.status);

function metricValue(e: EpisodeResult, metric: string): number | undefined {
  if (metric === "success") return passed(e) ? 1 : 0;
  if (metric === "score") return e.score ?? undefined;
  const v = e.scorecard[metric];
  return typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : undefined;
}

/** A stable bootstrap seed per comparison, so a report recomputes to the same numbers. */
const seedOf = (a: Evidence, b: Evidence) => parseInt(a.identity.brain.slice(0, 7), 16) ^ parseInt(b.identity.brain.slice(0, 7), 16) ^ parseInt(b.identity.suite.slice(0, 7), 16);

function effect(rule: MetricRule, pairs: Array<[EpisodeResult, EpisodeResult]>, alpha: number, seed: number): Effect {
  const sign = rule.direction === "higher" ? 1 : -1;
  if (rule.metric === "success") {
    let a = 0, b = 0, c = 0, d = 0;
    for (const [x, y] of pairs) { const px = passed(x), py = passed(y); if (px && py) a++; else if (px) b++; else if (py) c++; else d++; }
    const ci = newcombePaired(a, b, c, d, alpha);
    const [lo, hi] = sign > 0 ? [ci.lo, ci.hi] : [-ci.hi, -ci.lo];
    return { rule, estimate: sign * ci.estimate, lo, hi, pairs: pairs.length, verdict: decide(lo, hi, rule.margin), detected: lo > 0 || hi < 0, nonInferior: lo > -rule.margin, better: sign > 0 ? c : b, worse: sign > 0 ? b : c, p: binomTwoSided(Math.min(b, c), b + c) };
  }
  const diffs = pairs.map(([x, y]) => [metricValue(x, rule.metric), metricValue(y, rule.metric)]).filter((v): v is [number, number] => v[0] !== undefined && v[1] !== undefined).map(([x, y]) => sign * (y - x));
  const better = diffs.filter((v) => v > 1e-12).length, worse = diffs.filter((v) => v < -1e-12).length;
  if (diffs.length < MIN_METRIC_PAIRS) {
    const est = diffs.length ? diffs.reduce((s, v) => s + v, 0) / diffs.length : 0;
    return { rule, estimate: est, lo: -Infinity, hi: Infinity, pairs: diffs.length, verdict: "inconclusive", detected: false, nonInferior: false, better, worse, note: `needs at least ${MIN_METRIC_PAIRS} valid pairs for an interval` };
  }
  const ci = pairedBootstrap(diffs, alpha, 10_000, seed);
  const sorted = [...diffs].sort((x, y) => x - y);
  return { rule, estimate: ci.estimate, lo: ci.lo, hi: ci.hi, pairs: diffs.length, verdict: decide(ci.lo, ci.hi, rule.margin), detected: ci.lo > 0 || ci.hi < 0, nonInferior: ci.lo > -rule.margin, better, worse, median: quantile(sorted, 0.5), iqr: [quantile(sorted, 0.25), quantile(sorted, 0.75)] };
}

/** R8.1: what differs between the two tested artifacts. Policy files are compared by hash only. */
export function artifactDiff(a: ArtifactSummary, b: ArtifactSummary): ArtifactChange[] {
  const out: ArtifactChange[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (a.tickHz !== b.tickHz) out.push({ kind: "tick", path: "brain.tickHz", from: a.tickHz, to: b.tickHz });
  for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    const x = a.nodes[id], y = b.nodes[id];
    if (!x || !y || x.skill !== y.skill) { out.push({ kind: "node", path: id, from: x?.skill, to: y?.skill }); continue; }
    for (const k of new Set([...Object.keys(x.params), ...Object.keys(y.params)])) if (!same(x.params[k], y.params[k])) out.push({ kind: "param", path: `${id}.${k}`, from: x.params[k], to: y.params[k] });
  }
  for (const e of a.edges.filter((e) => !b.edges.includes(e))) out.push({ kind: "edge", path: e, from: "wired", to: "removed" });
  for (const e of b.edges.filter((e) => !a.edges.includes(e))) out.push({ kind: "edge", path: e, from: "absent", to: "wired" });
  for (const k of new Set([...Object.keys(a.body), ...Object.keys(b.body)])) if (!same(a.body[k], b.body[k])) out.push({ kind: "body", path: k, from: a.body[k], to: b.body[k] });
  for (const f of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) if (a.files[f]?.sha256 !== b.files[f]?.sha256) out.push({ kind: "file", path: f, from: a.files[f]?.sha256.slice(0, 12) ?? "absent", to: b.files[f]?.sha256.slice(0, 12) ?? "absent" });
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}`;
const fmt = (rule: MetricRule, x: number) => (rule.metric === "success" ? `${x >= 0 ? "+" : ""}${pct(x)} points` : `${x >= 0 ? "+" : ""}${+x.toFixed(3)}`);
const interval = (e: Effect) => (Number.isFinite(e.lo) ? `${fmt(e.rule, e.lo)} to ${fmt(e.rule, e.hi)}` : "no interval yet");
const marginText = (r: MetricRule) => (r.metric === "success" ? `±${pct(r.margin)} points` : `±${r.margin}`);
const WORDS: Record<MetricVerdict, string> = { meaningfully_improved: "meaningfully improved", meaningfully_regressed: "meaningfully regressed", no_meaningful_change: "no meaningful change", inconclusive: "inconclusive" };

/** `alpha` overrides the suite's level, e.g. α/k when one release is gated on k suites (Bonferroni). */
export function compare(base: Evidence, cand: Evidence, opts: { alpha?: number } = {}): Comparison {
  const suite: Suite = cand.suite;
  const alpha = opts.alpha ?? suite.alpha;
  const level = `${+((1 - alpha) * 100).toFixed(1)}%`;
  const side = (e: Evidence) => ({ version: e.machine.version, manifest: e.machine.manifest, summary: e.summary, accounting: e.accounting });
  const invalidRate = (e: Evidence) => e.episodes.filter((x) => !valid(x)).length / Math.max(1, e.accounting.planned);
  const r: Comparison = {
    verdict: "inconclusive", reason: "", gate: { pass: false, reasons: [] }, guardrails: [], exploratory: [], newlyFailing: [], newlyPassing: [], dropped: [],
    paired: 0, invalidRate: { base: invalidRate(base), cand: invalidRate(cand) }, changes: artifactDiff(base.artifact, cand.artifact), alpha, base: side(base), cand: side(cand),
  };
  const done = (verdict: Verdict, reason: string, gateReasons: string[] = []) => Object.assign(r, { verdict, reason, gate: { pass: gateReasons.length === 0, reasons: gateReasons } });

  // ---- comparability
  if (base.identity.suite !== cand.identity.suite) return done("not_comparable", "The test changed (its task, scoring, decision rule or cases differ), so the results cannot be compared.", ["the test changed"]);
  if (base.identity.world !== cand.identity.world) return done("not_comparable", "The starting world changed, so the results cannot be compared.", ["the starting world changed"]);
  if (base.driver !== cand.driver) return done("not_comparable", `The two ran on different drivers (${base.driver} and ${cand.driver}).`, ["different drivers"]);
  const byBase = new Map(base.episodes.map((e) => [e.seed, e]));
  const shared = cand.episodes.filter((e) => byBase.has(e.seed)).map((e) => [byBase.get(e.seed)!, e] as [EpisodeResult, EpisodeResult]);
  const mismatched = shared.filter(([x, y]) => x.worldHash !== y.worldHash).map(([x]) => x.seed);
  if (mismatched.length) return done("not_comparable", `${mismatched.length} worlds with the same seed did not start in the same state (seeds ${mismatched.slice(0, 5).join(", ")}${mismatched.length > 5 ? "…" : ""}), so they are not the same worlds.`, ["initial states differ"]);
  if (!shared.length) return done("not_comparable", "The two share no worlds.", ["no shared worlds"]);

  for (const [x, y] of shared) if (!valid(x) || !valid(y)) r.dropped.push({ seed: x.seed, reason: !valid(x) ? `baseline ${x.status}` : `candidate ${y.status}` });
  const pairs = shared.filter(([x, y]) => valid(x) && valid(y));
  r.paired = pairs.length;
  r.newlyFailing = pairs.filter(([x, y]) => passed(x) && !passed(y)).map(([x]) => x.seed);
  r.newlyPassing = pairs.filter(([x, y]) => !passed(x) && passed(y)).map(([x]) => x.seed);
  if (r.invalidRate.base > suite.maxInvalidRate || r.invalidRate.cand > suite.maxInvalidRate)
    return done("invalid_evaluation", `Too many worlds did not run properly (baseline ${pct(r.invalidRate.base)}%, candidate ${pct(r.invalidRate.cand)}%, limit ${pct(suite.maxInvalidRate)}%). Fix the infrastructure and run again.`, ["evaluation invalid"]);

  // ---- reproduction: the same brain, body and world
  const sameArtifact = base.identity.brain === cand.identity.brain && base.identity.body === cand.identity.body;
  if (sameArtifact) {
    const statuses = shared.every(([x, y]) => x.status === y.status);
    const exactPossible = base.driver === "sim2d" || (base.environment.platform === cand.environment.platform && base.environment.kernel === cand.environment.kernel);
    if (exactPossible) return shared.every(([x, y]) => x.fingerprint === y.fingerprint && x.status === y.status)
      ? done("exact_reproduction", `All ${shared.length} worlds reproduced exactly.`)
      : done("did_not_reproduce", `Same brain, body and worlds, but ${shared.filter(([x, y]) => x.fingerprint !== y.fingerprint || x.status !== y.status).length} of ${shared.length} worlds produced a different result: the run is not deterministic or a record was altered.`, ["did not reproduce"]);
    const drift = Object.entries(suite.tolerance).filter(([m, tol]) => pairs.some(([x, y]) => Math.abs((metricValue(x, m) ?? 0) - (metricValue(y, m) ?? 0)) > tol)).map(([m]) => m);
    return statuses && !drift.length
      ? done("equivalent_reproduction", `All ${shared.length} outcomes agree on ${cand.environment.platform} (${cand.environment.kernel})${Object.keys(suite.tolerance).length ? ", with every metric within tolerance" : ""}; physics is only bit-exact on the same platform.`)
      : done("did_not_reproduce", statuses ? `Outcomes agree but ${drift.join(", ")} moved beyond tolerance on ${cand.environment.platform}.` : `On ${cand.environment.platform}, ${shared.filter(([x, y]) => x.status !== y.status).length} worlds ended differently.`, ["did not reproduce"]);
  }

  // ---- a change
  const seed = seedOf(base, cand);
  r.primary = effect(suite.primary, pairs, alpha, seed);
  r.guardrails = suite.guardrails.map((g) => effect(g, pairs, alpha, seed + 1));
  const decided = new Set([suite.primary.metric, ...suite.guardrails.map((g) => g.metric)]);
  const metrics = [...new Set(pairs.flatMap(([x]) => Object.keys(x.scorecard)))].filter((m) => !decided.has(m) && typeof pairs[0][0].scorecard[m] !== "boolean");
  r.exploratory = ["score", ...metrics].filter((m) => !decided.has(m)).map((m) => effect({ metric: m, direction: "higher", margin: Infinity }, pairs, alpha, seed + 2)).filter((e) => e.pairs > 0);
  if (suite.primary.metric === "success") {
    const discordant = (r.newlyFailing.length + r.newlyPassing.length) / Math.max(1, pairs.length);
    const p = power(Math.sqrt(Math.max(discordant, 1 / Math.max(1, pairs.length))), pairs.length, suite.primary.margin, alpha);
    r.power = { metric: "success", ...p, margin: suite.primary.margin };
  } else if (Number.isFinite(r.primary.lo)) {
    const d = pairs.map(([x, y]) => (metricValue(y, suite.primary.metric) ?? 0) - (metricValue(x, suite.primary.metric) ?? 0));
    const m = d.reduce((s, v) => s + v, 0) / d.length, sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, d.length - 1));
    r.power = { metric: suite.primary.metric, ...power(sd, pairs.length, suite.primary.margin, alpha), margin: suite.primary.margin };
  }

  const P = r.primary;
  const gate: string[] = [];
  if (!P.nonInferior) gate.push(`${suite.primary.metric} may be meaningfully worse: the interval reaches ${fmt(P.rule, P.lo)} against a margin of ${marginText(P.rule)}`);
  for (const g of r.guardrails) if (!g.nonInferior) gate.push(`guardrail ${g.rule.metric} may be meaningfully worse (${interval(g)}, margin ${marginText(g.rule)})`);
  if (suite.pass && cand.summary.successRate < suite.pass.successRate) gate.push(`success ${pct(cand.summary.successRate)}% is below the acceptance threshold of ${pct(suite.pass.successRate)}%`);
  const size = P.detected && P.verdict === "no_meaningful_change" ? " A change smaller than the margin was detected." : "";
  return done(P.verdict, `${suite.primary.metric === "success" ? "Success" : suite.primary.metric} ${fmt(P.rule, P.estimate)} (${level} interval ${interval(P)}) across ${pairs.length} paired worlds, against a margin of ${marginText(P.rule)}: ${WORDS[P.verdict]}.${size}${P.note ? ` ${P.note}.` : ""}`, gate);
}
