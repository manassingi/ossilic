import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Machine } from "@ossilic/runtime";
import { createDefaultRegistry, mlpForward, parsePolicy } from "@ossilic/skills";
import { Sim2DDriver } from "@ossilic/sim";
import { TASKS, TEMPLATES, characterize, evaluate, fit, materialize, optimize, type CreateMachine } from "../src/index.ts";

const registry = createDefaultRegistry();
const rover = JSON.parse(readFileSync(new URL("../../../examples/rover/machine.json", import.meta.url), "utf8"));
const sim = rover.deploy.targets.find((t: any) => t.name === "sim");
const create: CreateMachine = (m, target, assets) => Machine.create(m, new Sim2DDriver(target.config ?? {}), registry, async (p) => { if (p in assets) return assets[p]; throw new Error(`no asset ${p}`); });

test("the optimizer climbs a smooth objective", async () => {
  const r = await optimize({ dim: 3, init: [0.1, 0.9, 0.1], budget: 120, seed: 3, evaluate: async (x) => -x.reduce((a, v) => a + (v - 0.6) ** 2, 0) });
  assert.ok(r.bestScore > -0.01, `best ${r.bestScore}`);
  assert.ok(r.history.every((h, i, a) => i === 0 || h >= a[i - 1]), "history is monotone");
});

test("characterize measures what the body can do", async () => {
  const p = await characterize(rover, sim, create);
  assert.equal(p.kind, "wheeled");
  assert.ok(p.maxLinearSpeed! > 0.5 && p.maxLinearSpeed! < 1.0, `speed ${p.maxLinearSpeed}`); // 14 rad/s × 0.05 m = 0.7 m/s
  assert.ok(p.maxTurnRate! > 1, `turn ${p.maxTurnRate}`);
});

test("evaluate reports a success rate over randomized worlds", async () => {
  const r = await evaluate({ manifest: rover, target: sim, task: TASKS.navigate, episodes: 4, create });
  assert.equal(r.episodes, 4);
  assert.ok(r.successRate >= 0.5, `success ${r.successRate}`);
  assert.equal(typeof r.mean["goto.reached"], "number");
});

test("a parametric fit never ends worse than it started", async () => {
  const tpl = TEMPLATES.find((t) => t.name === "navigate.goto-avoid")!;
  const r = await fit({ manifest: rover, target: sim, task: TASKS.navigate, template: tpl, registry, create, budget: 10, episodes: 1, evalEpisodes: 2 });
  assert.ok(r.report.after.successRate >= r.report.before.successRate - 1e-9);
  assert.equal(Object.keys(r.report.best.params).length, 7);
});

test("a policy template produces a loadable brain that runs", async () => {
  const tpl = TEMPLATES.find((t) => t.name === "navigate.policy")!;
  const prepared = tpl.prepare(rover, registry);
  const { manifest, assets } = materialize(prepared, new Array(prepared.dim).fill(0.5));
  const policy = parsePolicy(assets["brains/navigate.mlp.json"]);
  assert.equal(policy.inputs, 27);
  assert.deepEqual(mlpForward(policy, new Array(27).fill(0)), [0, 0]);
  const m = await create(manifest, sim, assets);
  await m.run(1);
  assert.ok(m.ticks > 0);
  m.dispose();
});

test("imitation: the network learns a teacher's reactions before evolution refines them", async () => {
  const { collectNavigationDemos, trainMlp } = await import("../src/clone.ts");
  const demos = await collectNavigationDemos(rover, sim, create, { episodes: 1, seconds: 5, goal: { x: 5, y: 5 }, maxSpeed: 0.6, maxTurn: 2 });
  assert.ok(demos.length >= 90 && demos[0].obs.length === 27 && demos[0].act.length === 2);
  const w = trainMlp({ inputs: 27, hidden: [16], outputs: 2 }, demos, { epochs: 15 });
  const policy = parsePolicy(JSON.stringify({ ossilic: "1", kind: "mlp", inputs: 27, hidden: [16], outputs: 2, weights: w }));
  const mse = (ws: number[]) => demos.reduce((a, d) => { const y = mlpForward({ ...policy, weights: ws }, d.obs); return a + ((y[0] - d.act[0]) ** 2 + (y[1] - d.act[1]) ** 2) / 2; }, 0) / demos.length;
  assert.ok(mse(w) < 0.5 * mse(new Array(w.length).fill(0)), `trained mse ${mse(w)} vs zero-net ${mse(new Array(w.length).fill(0))}`);
});
