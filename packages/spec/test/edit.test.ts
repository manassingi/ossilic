import { test } from "node:test";
import assert from "node:assert/strict";
import { addNode, connect, disconnect, newManifest, removeNode, renameNode, setDone, setParams, uniqueId, validateManifest } from "../src/index.ts";

test("building a rover brain through edit ops yields a valid manifest and never mutates inputs", () => {
  const m0 = newManifest("bot");
  const a = addNode(m0, "sensor.read", { sensor: "lidar" });
  const b = addNode(a.manifest, "nav.obstacle_avoid");
  const c = addNode(b.manifest, "actuator.write", { actuator: "wheels" });
  let m = connect(c.manifest, `${a.id}.value`, `${b.id}.scan`);
  m = connect(m, `${b.id}.twist`, `${c.id}.command`);
  m = setDone(m, `${b.id}.blocked`);
  assert.deepEqual([a.id, b.id, c.id], ["read", "obstacle_avoid", "write"]);
  assert.equal(m.brain.edges.length, 2);
  assert.equal(validateManifest(m).ok, true);
  assert.equal(m0.brain.nodes.length, 0);
});

test("connect replaces the existing source of an input; disconnect clears it", () => {
  let m = addNode(addNode(addNode(newManifest("b"), "math.constant").manifest, "math.constant").manifest, "math.gain").manifest;
  m = connect(m, "constant.value", "gain.value");
  m = connect(m, "constant_2.value", "gain.value");
  assert.deepEqual(m.brain.edges, [{ from: "constant_2.value", to: "gain.value" }]);
  assert.equal(disconnect(m, "gain.value").brain.edges.length, 0);
});

test("rename rewrites edges and done; remove drops touching edges and done", () => {
  let m = addNode(addNode(newManifest("b"), "math.constant").manifest, "math.gain").manifest;
  m = setDone(connect(m, "constant.value", "gain.value"), "gain.value");
  const r = renameNode(m, "gain", "amp");
  assert.deepEqual(r.brain.edges, [{ from: "constant.value", to: "amp.value" }]);
  assert.equal(r.brain.done, "amp.value");
  const d = removeNode(r, "amp");
  assert.equal(d.brain.edges.length, 0);
  assert.equal(d.brain.done, undefined);
  assert.throws(() => renameNode(m, "gain", "constant"), /already exists/);
});

test("setParams drops empty values; uniqueId sanitizes", () => {
  const m = addNode(newManifest("b"), "math.gain").manifest;
  assert.equal(setParams(m, "gain", { k: 2, offset: "" }).brain.nodes[0].params?.offset, undefined);
  assert.equal(setParams(m, "gain", {}).brain.nodes[0].params, undefined);
  assert.equal(uniqueId("Obstacle Avoid!", ["obstacle_avoid"]), "obstacle_avoid_2");
  assert.equal(uniqueId("9x", []), "x");
});
