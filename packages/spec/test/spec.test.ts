import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, manifestHash, canonicalJson } from "../src/index.ts";

const good = {
  ossilic: "1", name: "bot", version: "1.0.0", license: "Apache-2.0", authors: ["Ossilic"],
  body: { base: { type: "differential_drive" }, sensors: [{ id: "lidar", type: "lidar2d" }], actuators: [{ id: "wheels", type: "differential_drive" }] },
  brain: { tickHz: 20, nodes: [{ id: "a", skill: "sensor.read" }, { id: "b", skill: "actuator.write" }], edges: [{ from: "a.value", to: "b.command" }], done: "a.value" },
  deploy: { targets: [{ name: "sim", driver: "sim2d" }] },
};

test("accepts a well-formed manifest", () => {
  const r = validateManifest(good);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("reports precise paths for problems", () => {
  const bad = structuredClone(good) as any;
  bad.brain.edges.push({ from: "zzz.out", to: "b.in" });
  bad.body.sensors.push({ id: "lidar", type: "thermal" });
  bad.version = "one";
  bad.brain.done = "nope.x";
  const paths = validateManifest(bad).issues.map((i) => i.path);
  for (const p of ["brain.edges[1].from", "body.sensors[1].id", "body.sensors[1].type", "version", "brain.done"]) assert.ok(paths.includes(p), p);
});

test("rejects non-objects", () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
});

test("hash is independent of key order", async () => {
  const reordered = JSON.parse(JSON.stringify({ deploy: good.deploy, brain: good.brain, body: good.body, version: good.version, name: good.name, ossilic: "1", license: "Apache-2.0", authors: ["Ossilic"] }));
  assert.equal(canonicalJson(reordered), canonicalJson(good));
  assert.equal(await manifestHash(reordered as any), await manifestHash(good as any));
  assert.match(await manifestHash(good as any), /^[0-9a-f]{64}$/);
});
