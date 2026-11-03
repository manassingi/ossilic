import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { recordRun } from "@ossilic/runtime";
import { openMachine } from "@ossilic/cli";
import { findPython } from "../src/index.ts";

const python = findPython(new URL("../../../", import.meta.url).pathname);
const hasMujoco = spawnSync(python, ["-c", "import mujoco"]).status === 0;
const physics = { skip: hasMujoco ? false : `mujoco is not installed for ${python}; run: ${python} -m pip install mujoco` };

const example = (name: string, target: string) => openMachine(new URL(`../../../examples/${name}/machine.json`, import.meta.url).pathname, target);

test("the same rover brain reaches its goal on real physics", physics, async () => {
  const rover = example("rover", "physics");
  const machine = await rover.create();
  const rec = await recordRun(machine, rover.target, { seconds: 90 });
  machine.dispose();
  assert.equal(rec.scorecard.collisions, 0, JSON.stringify(rec.scorecard));
  assert.equal(rec.scorecard["goto.reached"], true, `final pose ${JSON.stringify(rec.trajectory.poses.at(-1))}`);
});

test("the quadruped trots forward and stays upright", physics, async () => {
  const quad = example("quadruped", "physics");
  const machine = await quad.create();
  const rec = await recordRun(machine, quad.target, { seconds: 10 });
  machine.dispose();
  assert.equal(rec.scorecard.upright, true, JSON.stringify(rec.scorecard));
  assert.ok((rec.scorecard.distance as number) > 3.0, `distance ${rec.scorecard.distance}`);
});

test("the host reports body errors as readable messages", physics, async () => {
  const quad = example("quadruped", "physics");
  const broken = { ...quad.manifest, body: { ...quad.manifest.body, actuators: [{ id: "legs", type: "joint_position", actuators: ["nope"] }] } };
  const { createMujocoDriver } = await import("../src/index.ts");
  const d = createMujocoDriver({}, new URL("../../../examples/quadruped/", import.meta.url).pathname);
  await assert.rejects(d.init(broken as any), /mujoco host: .*nope/);
  d.dispose();
});

test("AT1.1 the physics host's sensor noise is the engine's, value for value", physics, async () => {
  const { noise, keyOf } = await import("@ossilic/runtime");
  const host = new URL("../host/ossilic_mujoco.py", import.meta.url).pathname;
  const cases = [[1000, 1, "lidar", 0], [1000, 17, "lidar", 23], [4242, 300, "front", 5], [7, 0, "a", 0]] as const;
  const py = spawnSync(python, ["-c", `import importlib.util as u, json; s = u.spec_from_file_location("h", ${JSON.stringify(host)}); h = u.module_from_spec(s); s.loader.exec_module(h); print(json.dumps([h.noise(a, b, h.key_of(c), d) for a, b, c, d in ${JSON.stringify(cases)}]))`], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), cases.map(([a, b, c, d]) => noise(a, b, keyOf(c), d)));
});

test("AT1.2 physics evidence reproduces exactly on the same platform", physics, async () => {
  const { readFile } = await import("node:fs/promises");
  const { compare, defaultSuite, runSuite } = await import("@ossilic/evidence");
  const quad = example("quadruped", "physics");
  const suite = { ...defaultSuite(quad.manifest, "walk", "physics"), episodes: 2 };
  const go = () => runSuite({ manifest: quad.manifest, suite, create: (m, t, a) => quad.createFor(m, t, a), read: (p) => readFile(`${quad.dir}/${p}`), platform: "same" });
  const a = await go(), b = await go();
  assert.match(a.environment.kernel, /^mujoco \d/);
  assert.equal(compare(a, b).verdict, "exact_reproduction");
});
