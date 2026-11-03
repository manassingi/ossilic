import { DriverError, InvalidWorldError, recordRun, type Machine } from "@ossilic/runtime";
import { randomizeTarget, TASKS, type CreateMachine } from "@ossilic/adapt";
import {
  digest, ENGINE_VERSION, EPISODE_STATUSES, manifestHash, NOT_POLICY, referencedFiles, sha256Hex,
  type ArtifactSummary, type EpisodeResult, type EpisodeStatus, type Evidence, type MachineManifest, type Suite,
} from "@ossilic/spec";
import { wilson } from "./stats.ts";

export const EVALUATOR = "ossilic-evidence 2";
const GENERATOR = "ossilic-randomize 1";

/** Reads a file next to the manifest: the CLI reads the disk, the Hub reads the package. */
export type ReadFile = (relativePath: string) => Promise<Uint8Array | string>;

/** The suite's identity: everything that decides what "the same test" means, except how many worlds are run. */
export async function suiteHash(suite: Suite, manifest: MachineManifest): Promise<string> {
  const target = manifest.deploy.targets.find((t) => t.name === suite.target);
  if (!target) throw new Error(`suite "${suite.name}" starts from target "${suite.target}", which ${manifest.name} does not have. Targets: ${manifest.deploy.targets.map((t) => t.name).join(", ")}`);
  const task = TASKS[suite.task];
  if (!task) throw new Error(`suite "${suite.name}" uses unknown task "${suite.task}". Tasks: ${Object.keys(TASKS).join(", ")}`);
  const { name: _n, version: _v, description: _d, episodes: _e, ...rule } = suite;
  return digest({ ...rule, scoring: `${task.name}@${task.version}`, driver: target.driver });
}

/** R2.1: brain (graph and policy files), body (body and model file), world (starting target), suite. */
export async function identify(manifest: MachineManifest, suite: Suite, read: ReadFile): Promise<{ identity: Evidence["identity"]; artifact: ArtifactSummary }> {
  const files: ArtifactSummary["files"] = {};
  for (const f of referencedFiles(manifest)) {
    const data = await read(f);
    files[f] = { sha256: await sha256Hex(data), bytes: typeof data === "string" ? new TextEncoder().encode(data).length : data.length };
  }
  const brainFiles = Object.fromEntries(manifest.brain.nodes.map((n) => n.params?.file).filter((f): f is string => typeof f === "string").map((f) => [f, files[f].sha256]));
  const { layout: _layout, ...brain } = manifest.brain; // editor positions do not change behaviour
  const target = manifest.deploy.targets.find((t) => t.name === suite.target)!;
  const identity = {
    brain: await digest({ brain, files: brainFiles }),
    body: await digest({ body: manifest.body, model: manifest.body.model ? files[manifest.body.model]?.sha256 ?? null : null }),
    world: await digest({ driver: target.driver, config: target.config ?? {} }),
    suite: await suiteHash(suite, manifest),
  };
  const artifact: ArtifactSummary = {
    tickHz: manifest.brain.tickHz,
    nodes: Object.fromEntries(manifest.brain.nodes.map((n) => [n.id, { skill: n.skill, params: n.params ?? {} }])),
    edges: manifest.brain.edges.map((e) => `${e.from} → ${e.to}`).sort(),
    body: flatten(manifest.body as unknown as Record<string, unknown>),
    files,
  };
  return { identity, artifact };
}

function flatten(o: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) && v.every((x) => typeof x === "object" && x && "id" in x)) for (const x of v as Array<Record<string, unknown>>) Object.assign(out, flatten(x, `${key}[${x.id}]`));
    else if (typeof v === "object" && v !== null && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);

/** R6.1: who executed it. In GitHub Actions the run is identified; anywhere else it is local. */
export function executedBy(): Evidence["executedBy"] {
  if (env("GITHUB_ACTIONS") !== "true") return { mode: "local" };
  const repo = env("GITHUB_REPOSITORY") ?? "", server = env("GITHUB_SERVER_URL") ?? "https://github.com";
  return { mode: "ci", ci: { provider: "github-actions", repository: repo, commit: env("GITHUB_SHA") ?? "", workflow: env("GITHUB_WORKFLOW_REF") ?? env("GITHUB_WORKFLOW") ?? "", runUrl: `${server}/${repo}/actions/runs/${env("GITHUB_RUN_ID") ?? ""}` } };
}

export interface RunSuiteOptions {
  manifest: MachineManifest;
  suite: Suite;
  create: CreateMachine;
  read: ReadFile;
  /** e.g. "darwin-arm64": physics fingerprints are exact only on the same platform. */
  platform: string;
  runtime?: string;
  createdBy?: string;
  onProgress?(done: number, total: number): void;
}

/** Run every planned world on a fresh machine. Nothing is dropped: each world ends with exactly one status. */
export async function runSuite(o: RunSuiteOptions): Promise<Evidence> {
  const { identity, artifact } = await identify(o.manifest, o.suite, o.read);
  const target = o.manifest.deploy.targets.find((t) => t.name === o.suite.target)!;
  const task = TASKS[o.suite.task];
  const episodes: EpisodeResult[] = [];
  let kernel = target.driver;
  for (let i = 0; i < o.suite.episodes; i++) {
    const seed = o.suite.seed + i;
    const world = o.suite.randomize ? randomizeTarget(target, seed) : { ...target, config: { ...target.config, seed } };
    const base = { seed, world: world.config ?? {}, worldHash: await digest(world.config ?? {}) };
    let machine: Machine | undefined;
    try {
      try { machine = await o.create(o.manifest, world, {}); } catch (e) {
        if (e instanceof InvalidWorldError || e instanceof DriverError) throw e;
        throw new Error(`the machine does not build: ${(e as Error).message}`); // a broken brain is not a world-level outcome
      }
      kernel = machine.driver.info?.().kernel ?? kernel;
      const rec = await recordRun(machine, world, { seconds: task.seconds });
      const status: EpisodeStatus = task.success(rec) ? "success" : o.manifest.brain.done && !machine.done ? "timeout" : "failure";
      episodes.push({ ...base, status, ticks: rec.ticks, score: +task.score(rec).toFixed(3), scorecard: rec.scorecard, fingerprint: await digest({ ticks: rec.ticks, scorecard: rec.scorecard, poses: rec.trajectory.poses }) });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("the machine does not build")) throw e;
      const status: EpisodeStatus = e instanceof InvalidWorldError ? "invalid" : e instanceof DriverError ? "infra_error" : "policy_error";
      const ticks = machine?.ticks ?? 0, scorecard = status === "policy_error" && machine ? machine.scorecard() : {};
      episodes.push({ ...base, status, ticks, score: null, scorecard, fingerprint: status === "policy_error" ? await digest({ status, ticks, scorecard }) : null, error: (e as Error).message });
    } finally { machine?.dispose(); }
    o.onProgress?.(i + 1, o.suite.episodes);
  }
  const byStatus = Object.fromEntries(EPISODE_STATUSES.map((s) => [s, episodes.filter((e) => e.status === s).length])) as Record<EpisodeStatus, number>;
  const valid = episodes.filter((e) => !NOT_POLICY.includes(e.status));
  const successes = valid.filter((e) => e.status === "success").length, n = valid.length;
  const scored = valid.filter((e) => e.score !== null);
  return {
    ossilic: "1", kind: "evidence", schema: 2,
    machine: { name: o.manifest.name, version: o.manifest.version, manifest: await manifestHash(o.manifest) },
    identity, suite: o.suite, artifact, driver: target.driver,
    environment: { engine: ENGINE_VERSION, evaluator: EVALUATOR, scoring: `${task.name}@${task.version}`, driver: target.driver, kernel, runtime: o.runtime ?? (typeof process !== "undefined" ? `node ${process.versions.node}` : "browser"), platform: o.platform },
    executedBy: executedBy(), ...(o.createdBy && { createdBy: o.createdBy }),
    cases: o.suite.cases,
    accounting: { planned: o.suite.episodes, completed: episodes.filter((e) => e.status !== "infra_error" && e.status !== "invalid").length, byStatus },
    episodes,
    summary: { n, successes, successRate: n ? +(successes / n).toFixed(4) : 0, ci95: wilson(successes, n).map((x) => +x.toFixed(4)) as [number, number], meanScore: scored.length ? +(scored.reduce((s, e) => s + e.score!, 0) / scored.length).toFixed(3) : null },
    createdAt: new Date().toISOString(),
  };
}

/** A suite to start from. 200 kinematic worlds or 50 physics worlds: enough to resolve a 10-point margin in most cases. */
export function defaultSuite(manifest: MachineManifest, taskName: string, targetName?: string): Suite {
  const task = TASKS[taskName];
  if (!task) throw new Error(`unknown task "${taskName}". Tasks: ${Object.keys(TASKS).join(", ")}`);
  const target = targetName ? manifest.deploy.targets.find((t) => t.name === targetName) : manifest.deploy.targets.find((t) => t.driver === "sim2d" || t.driver === "mujoco");
  if (!target) throw new Error(targetName ? `no target "${targetName}"` : "no simulation target (sim2d or mujoco) to test on");
  return {
    ossilic: "1", kind: "suite", schema: 2, name: task.name, version: "1.0.0", description: `${task.name} on ${target.name}, randomized worlds`,
    task: task.name, target: target.name, episodes: target.driver === "sim2d" ? 200 : 50, seed: 1000, randomize: true,
    cases: { kind: "seeded-public", generator: GENERATOR },
    primary: { metric: "success", direction: "higher", margin: 0.1 },
    guardrails: [], alpha: 0.05, maxInvalidRate: 0.05, tolerance: {},
  };
}
