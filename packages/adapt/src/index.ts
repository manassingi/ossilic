/**
 * @ossilic/adapt — Characterize → Match → Fit → Evaluate.
 *
 * The caller supplies how to create a machine on a target (the CLI uses
 * installed drivers, Desktop uses its bridge), so the same pipeline runs
 * headless and in the app.
 */
import { recordRun, type Machine, type SkillRegistry } from "@ossilic/runtime";
import { addNode, connect, setComponent, type BodyProfile, type DeployTarget, type EvalReport, type FitReport, type MachineManifest, type RunRecord } from "@ossilic/spec";
import { optimize } from "./es.ts";
import { randomizeTarget } from "./randomize.ts";
import { TASKS, type Task } from "./tasks.ts";
import { initialVector, materialize, templatesFor, weightsToVector, TEMPLATES, type BrainTemplate, type Prepared } from "./templates.ts";
import { collectNavigationDemos, trainMlp } from "./clone.ts";

export * from "./tasks.ts";
export * from "./templates.ts";
export * from "./randomize.ts";
export * from "./es.ts";
export { Rng } from "./rng.ts";
export * from "./clone.ts";

/** Create a bound machine for a manifest on a target, with these in-memory assets taking precedence over files. */
export type CreateMachine = (manifest: MachineManifest, target: DeployTarget, assets: Record<string, string>) => Promise<Machine>;

export interface Progress { phase: "characterize" | "fit" | "evaluate"; evaluated?: number; budget?: number; best?: number; generation?: number; message?: string }

async function episode(create: CreateMachine, m: MachineManifest, target: DeployTarget, assets: Record<string, string>, seconds: number): Promise<RunRecord> {
  const machine = await create(m, target, assets);
  try { return await recordRun(machine, target, { seconds }); } finally { machine.dispose(); }
}

// ---------- Characterize ----------

export async function characterize(m: MachineManifest, target: DeployTarget, create: CreateMachine, extra: { joints?: string[]; mass?: number } = {}): Promise<BodyProfile> {
  const kind: BodyProfile["kind"] = m.body.base.type === "differential_drive" ? "wheeled" : m.body.base.type === "legged" ? "legged" : "unknown";
  const profile: BodyProfile = {
    ossilic: "1", machine: m.name, target: target.name, kind, dof: kind === "wheeled" ? 2 : extra.joints?.length ?? m.body.actuators.length, mass: extra.mass,
    sensors: m.body.sensors.map((s) => `${s.id}:${s.type}`), actuators: m.body.actuators.map((a) => `${a.id}:${a.type}`), joints: extra.joints, measuredAt: new Date().toISOString(),
  };
  if (kind === "wheeled") {
    // probe: drive flat out toward a far goal, then spin toward a goal behind; read what the body actually did
    const wheels = m.body.actuators.find((a) => a.type === "differential_drive")!.id;
    let probe: MachineManifest = { ...m, body: { ...m.body, sensors: m.body.sensors.some((s) => s.type === "odometry") ? m.body.sensors : [...m.body.sensors, { id: "odom", type: "odometry" }] }, brain: { tickHz: 50, nodes: [], edges: [] } };
    const odom = probe.body.sensors.find((s) => s.type === "odometry")!.id;
    const cfg = (target.config ?? {}) as { start?: { x: number; y: number; theta: number } };
    const start = cfg.start ?? { x: 0, y: 0, theta: 0 };
    const far = { x: start.x + 100 * Math.cos(start.theta), y: start.y + 100 * Math.sin(start.theta) };
    probe = addNode(probe, "sensor.read", { sensor: odom }, "odom").manifest;
    probe = addNode(probe, "nav.goto", { x: far.x, y: far.y, cruise: 50, turnGain: 0 }, "goto").manifest;
    probe = addNode(probe, "actuator.write", { actuator: wheels }, "wheels").manifest;
    probe = connect(connect(probe, "odom.value", "goto.pose"), "goto.twist", "wheels.command");
    const straight = await episode(create, probe, target, {}, 1.0);
    profile.maxLinearSpeed = +(((straight.scorecard.distance as number) ?? 0) / straight.duration).toFixed(3);
    const behind = { x: start.x - 100 * Math.cos(start.theta), y: start.y - 100 * Math.sin(start.theta) };
    probe.brain.nodes.find((n) => n.id === "goto")!.params = { x: behind.x, y: behind.y, cruise: 0.0001, turnGain: 50 };
    const spin = await episode(create, probe, target, {}, 0.5);
    const th0 = spin.trajectory.poses[0]?.[2] ?? 0, th1 = spin.trajectory.poses.at(-1)?.[2] ?? 0;
    profile.maxTurnRate = +(Math.abs(Math.atan2(Math.sin(th1 - th0), Math.cos(th1 - th0))) / spin.duration).toFixed(3);
  }
  return profile;
}

// ---------- Evaluate ----------

export interface EvaluateOptions { manifest: MachineManifest; target: DeployTarget; task: Task; episodes: number; seed?: number; assets?: Record<string, string>; create: CreateMachine; onProgress?(p: Progress): void }

export async function evaluate(o: EvaluateOptions): Promise<EvalReport> {
  const seeds = Array.from({ length: o.episodes }, (_, i) => (o.seed ?? 100) + i);
  const records: RunRecord[] = [];
  for (const s of seeds) {
    records.push(await episode(o.create, o.manifest, randomizeTarget(o.target, s), o.assets ?? {}, o.task.seconds));
    o.onProgress?.({ phase: "evaluate", evaluated: records.length, budget: seeds.length });
  }
  const keys = [...new Set(records.flatMap((r) => Object.keys(r.scorecard)))];
  const mean: Record<string, number> = Object.fromEntries(keys.map((k) => {
    const vs = records.map((r) => r.scorecard[k]).filter((v): v is number | boolean => v !== undefined);
    const value = typeof vs[0] === "boolean" ? vs.filter(Boolean).length / vs.length : vs.reduce<number>((a, v) => a + Number(v), 0) / vs.length;
    return [k, +value.toFixed(4)];
  }));
  const scores = records.map((r) => +o.task.score(r).toFixed(3));
  return { ossilic: "1", machine: o.manifest.name, version: o.manifest.version, target: o.target.name, task: o.task.name, episodes: seeds.length, successRate: records.filter((r) => o.task.success(r)).length / records.length, mean, scores, seeds };
}

// ---------- Fit ----------

export interface FitOptions {
  manifest: MachineManifest; target: DeployTarget; task: Task; template: BrainTemplate; registry: SkillRegistry; create: CreateMachine;
  budget: number; /** episodes per candidate, different worlds */ episodes?: number; seed?: number; evalEpisodes?: number; onProgress?(p: Progress): void;
}

export interface FitResult { manifest: MachineManifest; assets: Record<string, string>; report: FitReport }

export async function fit(o: FitOptions): Promise<FitResult> {
  const t0 = Date.now();
  const prepared: Prepared = o.template.prepare(o.manifest, o.registry);
  const perCandidate = o.episodes ?? (prepared.policy ? 4 : 3), seed = o.seed ?? 7;
  let init = initialVector(prepared, seed);
  if (prepared.policy && prepared.teacher) {
    // imitation first: the network learns the teacher's reactions, evolution then improves on them
    o.onProgress?.({ phase: "fit", message: "learning from the teacher brain" });
    const demos = await collectNavigationDemos(prepared.teacher, o.target, o.create, { episodes: 8, seconds: o.task.seconds, goal: prepared.policy.goal, maxSpeed: prepared.policy.maxSpeed, maxTurn: prepared.policy.maxTurn, seed });
    init = weightsToVector(trainMlp(prepared.policy, demos, { seed }));
  }
  const start = materialize(prepared, init);
  const before = await evaluate({ manifest: start.manifest, target: o.target, task: o.task, episodes: o.evalEpisodes ?? 6, seed: 500, assets: start.assets, create: o.create, onProgress: o.onProgress });
  const result = await optimize({
    dim: prepared.dim, init, budget: o.budget, seed, sigma: prepared.policy ? 0.03 : 0.2,
    evaluate: async (x, gen) => {
      const cand = materialize(prepared, x);
      let total = 0;
      for (let k = 0; k < perCandidate; k++) total += o.task.score(await episode(o.create, cand.manifest, randomizeTarget(o.target, 1000 + gen * 10 + k), cand.assets, o.task.seconds));
      return total / perCandidate;
    },
    onProgress: (p) => o.onProgress?.({ phase: "fit", ...p }),
  });
  // Re-rank the best few candidates on the evaluation worlds; a fit never returns something worse than it started with.
  const rank = (e: EvalReport) => e.successRate * 1000 + e.scores.reduce((a, v) => a + v, 0) / e.scores.length;
  let bestM = start, after = before;
  for (const c of result.top) {
    const cand = materialize(prepared, c.x);
    const e = await evaluate({ manifest: cand.manifest, target: o.target, task: o.task, episodes: o.evalEpisodes ?? 6, seed: 500, assets: cand.assets, create: o.create, onProgress: o.onProgress });
    if (rank(e) > rank(after)) { bestM = cand; after = e; }
  }
  const report: FitReport = {
    ossilic: "1", machine: o.manifest.name, target: o.target.name, task: o.task.name, template: o.template.name, budget: o.budget, evaluated: result.evaluated,
    best: { score: +result.bestScore.toFixed(3), params: bestM.params }, history: result.history.map((h) => +h.toFixed(3)), before, after, kept: bestM === start ? "initial" : "fitted",
    startedAt: new Date(t0).toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
  return { manifest: bestM.manifest, assets: bestM.assets, report };
}

// ---------- Adapt: the whole pipeline ----------

export interface AdaptOptions { manifest: MachineManifest; target: DeployTarget; task: string; template?: string; registry: SkillRegistry; create: CreateMachine; budget?: number; onProgress?(p: Progress): void; inspect?: { joints?: string[]; mass?: number } }

export async function adapt(o: AdaptOptions): Promise<FitResult & { profile: BodyProfile }> {
  const task = TASKS[o.task];
  if (!task) throw new Error(`unknown task "${o.task}". Tasks: ${Object.keys(TASKS).join(", ")}`);
  o.onProgress?.({ phase: "characterize" });
  const profile = await characterize(o.manifest, o.target, o.create, o.inspect);
  const candidates = o.template ? TEMPLATES.filter((t) => t.name === o.template) : templatesFor(task.name, profile.kind);
  if (!candidates.length) throw new Error(o.template ? `unknown template "${o.template}"` : `no ${task.name} template fits a ${profile.kind} body. Templates: ${TEMPLATES.map((t) => `${t.name} (${t.kind})`).join(", ")}`);
  const template = candidates[0];
  o.onProgress?.({ phase: "fit", message: `template ${template.name}` });
  const r = await fit({ manifest: o.manifest, target: o.target, task, template, registry: o.registry, create: o.create, budget: o.budget ?? 120, onProgress: o.onProgress });
  return { ...r, profile };
}

export { setComponent };
