/**
 * Evidence, schema 2: whether one exact brain version works, under one exact test.
 *
 * A Suite fixes the test and its decision rule before anything is compared.
 * Evidence is a brain run through a suite: every planned world accounted for,
 * each with the world it really started in, its status and a fingerprint.
 * See docs/I1-SPEC.md for the requirements and docs/STATISTICS.md for the methods.
 */
import { Check, type Scorecard, type ValidationResult } from "./index.ts";

/** A metric and what counts as a change worth acting on. `success` is the pass rate; `score` is the task's score. */
export interface MetricRule { metric: string; direction: "higher" | "lower"; margin: number }

export interface Suite {
  ossilic: "1";
  kind: "suite";
  schema: 2;
  name: string;
  version: string;
  description?: string;
  /** A task Ossilic knows how to score: navigate, walk. */
  task: string;
  /** The deploy target the worlds start from. */
  target: string;
  /** Paired worlds: world i of every version uses seed `seed + i`. */
  episodes: number;
  seed: number;
  /** Perturb each world from its seed: start heading, obstacles, sensor noise, friction, mass. */
  randomize: boolean;
  /** Where the cases come from. */
  cases: { kind: "seeded-public"; generator: string };
  /** Decides the verdict. Declared before any comparison. */
  primary: MetricRule;
  /** Each can block a release on its own; none can pass one. */
  guardrails: MetricRule[];
  /** Two-sided level of every interval: 0.05 gives 95% intervals. */
  alpha: number;
  /** Above this share of invalid or infrastructure-failed worlds, the evaluation is invalid. */
  maxInvalidRate: number;
  /** Absolute tolerance per metric for an equivalent reproduction on another platform. */
  tolerance: Record<string, number>;
  /** Acceptance threshold for the success rate. */
  pass?: { successRate: number };
}

export const EPISODE_STATUSES = ["success", "failure", "timeout", "safety_stop", "policy_error", "infra_error", "invalid"] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];
/** Statuses that say nothing about the policy: kept and counted, never analysed as its outcome. */
export const NOT_POLICY: readonly EpisodeStatus[] = ["infra_error", "invalid"];

export interface EpisodeResult {
  seed: number;
  status: EpisodeStatus;
  ticks: number;
  /** The world this episode actually started in, and its hash: episodes pair only when these match. */
  world: Record<string, unknown>;
  worldHash: string;
  /** null when the episode did not run (infrastructure error, invalid world). */
  score: number | null;
  scorecard: Scorecard;
  /** SHA-256 of the trajectory and scorecard: an exact reproduction must match it. */
  fingerprint: string | null;
  error?: string;
}

/** What was tested, in enough detail to say what changed between two versions. */
export interface ArtifactSummary {
  tickHz: number;
  nodes: Record<string, { skill: string; params: Record<string, unknown> }>;
  edges: string[];
  body: Record<string, unknown>;
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface Evidence {
  ossilic: "1";
  kind: "evidence";
  schema: 2;
  machine: { name: string; version: string; manifest: string };
  /** Four separate hashes: the brain with its policy files, the body with its model file, the starting world, the suite. */
  identity: { brain: string; body: string; world: string; suite: string };
  /** The full test and decision rule, so evidence stands alone; identity.suite is its hash. */
  suite: Suite;
  artifact: ArtifactSummary;
  driver: string;
  environment: { engine: string; evaluator: string; scoring: string; driver: string; kernel: string; runtime: string; platform: string };
  executedBy: { mode: "local" | "ci"; ci?: { provider: string; repository: string; commit: string; workflow: string; runUrl: string } };
  createdBy?: string;
  cases: { kind: string; generator: string };
  accounting: { planned: number; completed: number; byStatus: Record<EpisodeStatus, number> };
  episodes: EpisodeResult[];
  /** Over the worlds that say something about the policy (not infra_error or invalid). */
  summary: { n: number; successes: number; successRate: number; ci95: [number, number]; meanScore: number | null };
  createdAt: string;
  /** Present on an accepted baseline. */
  approval?: { by: string; at: string; reason?: string; replaces?: string };
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const HEX = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRule = (r: unknown) => isObj(r) && typeof r.metric === "string" && (r.direction === "higher" || r.direction === "lower") && typeof r.margin === "number" && r.margin > 0;

/** Evidence written before schema 2: kept and shown, never compared, because it has no initial states. */
export const isLegacyEvidence = (v: unknown): boolean => isObj(v) && v.kind === "evidence" && v.schema === undefined;

export function validateSuite(input: unknown): ValidationResult<Suite> {
  const c = new Check();
  if (!isObj(input)) { c.fail("", "suite must be an object"); return c.result(input); }
  if (input.ossilic !== "1") c.fail("ossilic", 'expected "1"');
  if (input.kind !== "suite") c.fail("kind", 'expected "suite"');
  if (input.schema !== 2) c.fail("schema", "expected 2; recreate the suite with `ossilic suite --force`");
  c.id(input.name, "name");
  c.str(input.version, "version", SEMVER, "semver, e.g. 1.0.0");
  c.str(input.task, "task");
  c.str(input.target, "target");
  if (!Number.isInteger(input.episodes) || input.episodes < 1 || input.episodes > 100_000) c.fail("episodes", "must be a whole number from 1 to 100000");
  if (!Number.isInteger(input.seed)) c.fail("seed", "must be a whole number");
  if (typeof input.randomize !== "boolean") c.fail("randomize", "must be true or false");
  if (!isObj(input.cases) || input.cases.kind !== "seeded-public" || typeof input.cases.generator !== "string") c.fail("cases", 'must be { kind: "seeded-public", generator }');
  if (!isRule(input.primary)) c.fail("primary", "must be { metric, direction: higher|lower, margin > 0 }");
  if (!Array.isArray(input.guardrails) || !input.guardrails.every(isRule)) c.fail("guardrails", "must be a list of { metric, direction, margin > 0 }");
  if (typeof input.alpha !== "number" || !(input.alpha > 0 && input.alpha < 0.5)) c.fail("alpha", "must be a number in (0, 0.5)");
  if (typeof input.maxInvalidRate !== "number" || input.maxInvalidRate < 0 || input.maxInvalidRate >= 1) c.fail("maxInvalidRate", "must be in [0, 1)");
  if (!isObj(input.tolerance) || !Object.values(input.tolerance).every((v) => typeof v === "number" && v >= 0)) c.fail("tolerance", "must map metrics to non-negative numbers");
  if (input.pass !== undefined && !(isObj(input.pass) && typeof input.pass.successRate === "number" && input.pass.successRate >= 0 && input.pass.successRate <= 1)) c.fail("pass", "must be { successRate: 0..1 }");
  return c.result<Suite>(input);
}

export function validateEvidence(input: unknown): ValidationResult<Evidence> {
  const c = new Check();
  if (!isObj(input)) { c.fail("", "evidence must be an object"); return c.result(input); }
  if (input.ossilic !== "1") c.fail("ossilic", 'expected "1"');
  if (input.kind !== "evidence") c.fail("kind", 'expected "evidence"');
  if (input.schema !== 2) c.fail("schema", isLegacyEvidence(input) ? "legacy evidence (schema 1) has no initial states; re-record it with `ossilic test --update`" : "expected 2");
  if (!isObj(input.machine) || typeof input.machine.name !== "string" || typeof input.machine.version !== "string" || !HEX.test(input.machine.manifest ?? "")) c.fail("machine", "required { name, version, manifest }");
  if (!isObj(input.identity) || !["brain", "body", "world", "suite"].every((k) => HEX.test(input.identity[k] ?? ""))) c.fail("identity", "required { brain, body, world, suite } hashes");
  if (!validateSuite(input.suite).ok) c.fail("suite", "required: the full suite this evidence was produced under");
  if (!isObj(input.artifact) || !isObj(input.artifact.nodes) || !isObj(input.artifact.files)) c.fail("artifact", "required artifact summary");
  if (!isObj(input.environment) || !["engine", "evaluator", "scoring", "driver", "kernel", "runtime", "platform"].every((k) => typeof input.environment[k] === "string")) c.fail("environment", "required { engine, evaluator, scoring, driver, kernel, runtime, platform }");
  if (!isObj(input.executedBy) || (input.executedBy.mode !== "local" && input.executedBy.mode !== "ci")) c.fail("executedBy", 'required { mode: "local" | "ci" }');
  if (!isObj(input.cases) || typeof input.cases.kind !== "string" || typeof input.cases.generator !== "string") c.fail("cases", "required { kind, generator }");
  for (const k of ["driver", "createdAt"]) c.str(input[k], k);
  if (!Array.isArray(input.episodes) || input.episodes.length === 0) c.fail("episodes", "required non-empty array");
  else input.episodes.forEach((e: unknown, i: number) => {
    const ok = isObj(e) && Number.isInteger(e.seed) && (EPISODE_STATUSES as readonly string[]).includes(e.status) && Number.isInteger(e.ticks) && isObj(e.world) && HEX.test(e.worldHash ?? "")
      && (e.score === null || typeof e.score === "number") && isObj(e.scorecard) && (e.fingerprint === null || HEX.test(e.fingerprint ?? ""));
    if (!ok) c.fail(`episodes[${i}]`, "must be { seed, status, ticks, world, worldHash, score, scorecard, fingerprint }");
  });
  const seeds = Array.isArray(input.episodes) ? input.episodes.map((e: any) => e?.seed) : [];
  if (new Set(seeds).size !== seeds.length) c.fail("episodes", "seeds must be unique");
  const a = input.accounting;
  if (!isObj(a) || !Number.isInteger(a.planned) || !isObj(a.byStatus)) c.fail("accounting", "required { planned, completed, byStatus }");
  else {
    const total = EPISODE_STATUSES.reduce((s, k) => s + (Number(a.byStatus[k]) || 0), 0);
    if (total !== a.planned || (Array.isArray(input.episodes) && input.episodes.length !== a.planned)) c.fail("accounting", `every planned world must have exactly one status (${total} statuses, ${a.planned} planned)`);
  }
  if (!isObj(input.summary) || typeof input.summary.successRate !== "number") c.fail("summary", "required summary");
  return c.result<Evidence>(input);
}
