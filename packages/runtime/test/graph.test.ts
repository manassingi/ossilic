import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry, compileGraph, Machine, type SkillSpec, type Driver } from "../src/index.ts";

const src: SkillSpec = { name: "t.src", version: "1.0.0", description: "", category: "io", inputs: {}, outputs: { n: "number" }, create: () => ({ tick: () => ({ n: 1 }) }) };
const add: SkillSpec = { name: "t.add", version: "1.0.0", description: "", category: "math", inputs: { a: { type: "number" }, b: { type: "number", required: false } }, outputs: { n: "number" }, create: () => ({ tick: (i) => ({ n: (i.a as number) + ((i.b as number) ?? 0) }) }) };
const delay: SkillSpec = { name: "t.delay", version: "1.0.0", description: "", category: "logic", delayed: true, inputs: { v: { type: "number" } }, outputs: { v: "number" }, create: () => ({ tick: (i) => ({ v: (i.v as number) ?? 0 }) }) };
const sink: SkillSpec = { name: "t.sink", version: "1.0.0", description: "", category: "io", inputs: { tw: { type: "twist" } }, outputs: {}, create: () => ({ tick: () => ({}) }) };
const reg = new SkillRegistry().register(src).register(add).register(delay).register(sink);

const manifest = (brain: any) => ({ ossilic: "1", name: "t", version: "1.0.0", body: { base: { type: "x" }, sensors: [], actuators: [] }, brain: { tickHz: 10, edges: [], ...brain }, deploy: { targets: [{ name: "s", driver: "d" }] } }) as any;
const noopDriver: Driver = { name: "noop", init() {}, readSensor: () => null, writeActuator() {}, step() {}, snapshot: () => ({}) };

test("orders nodes topologically", () => {
  const g = compileGraph(manifest({ nodes: [{ id: "b", skill: "t.add" }, { id: "a", skill: "t.src" }], edges: [{ from: "a.n", to: "b.a" }] }), reg);
  assert.deepEqual(g.order.map((n) => n.id), ["a", "b"]);
});

test("collects all errors at once", () => {
  assert.throws(
    () => compileGraph(manifest({ nodes: [{ id: "a", skill: "t.src", params: { zzz: 1 } }, { id: "b", skill: "t.add" }, { id: "c", skill: "t.add" }, { id: "s", skill: "t.sink" }], edges: [{ from: "a.n", to: "s.tw" }, { from: "b.n", to: "c.a" }, { from: "c.n", to: "b.a" }, { from: "a.nope", to: "b.b" }], done: "b.n" }), reg),
    (err: Error) => ["type mismatch number → twist", 'no output "nope"', "cycle detected", 'unknown param "zzz"', "brain.done: b.n is number"].every((s) => err.message.includes(s)),
  );
});

test("a delayed node closes a feedback loop and reads the previous tick", async () => {
  // acc = src + delay(acc): a running counter 1, 2, 3 ...
  const m = await Machine.create(manifest({ nodes: [{ id: "acc", skill: "t.add" }, { id: "src", skill: "t.src" }, { id: "d", skill: "t.delay" }], edges: [{ from: "src.n", to: "acc.a" }, { from: "acc.n", to: "d.v" }, { from: "d.v", to: "acc.b" }] }), noopDriver, reg);
  assert.deepEqual(m.graph.order.map((n) => n.id), ["d", "src", "acc"]);
  const seen = [];
  for (let i = 0; i < 3; i++) seen.push((await m.tick()).values["acc.n"]);
  assert.deepEqual(seen, [1, 2, 3]);
  await m.run(0.5); // no callback: the loop must still tick
  assert.equal(m.ticks, 8);
});
