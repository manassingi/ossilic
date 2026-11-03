import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRun, verifyRun } from "@ossilic/runtime";
import { openMachine } from "../src/index.ts";

const rover = openMachine(new URL("../../../examples/rover/machine.json", import.meta.url).pathname);

test("the reference rover reaches its goal in simulation without collisions", async () => {
  const machine = await rover.create();
  const rec = await recordRun(machine, rover.target, { seconds: 60 });
  assert.equal(rec.scorecard.collisions, 0);
  assert.equal(rec.scorecard["goto.reached"], true, `final pose ${JSON.stringify(rec.trajectory.poses.at(-1))}`);
  assert.ok(machine.done && rec.duration < 60);
  assert.equal(rec.license, "Apache-2.0");
});

test("a run record reproduces exactly, and a tampered one is caught", async () => {
  const rec = await recordRun(await rover.create(), rover.target, { seconds: 60 });
  assert.deepEqual(await verifyRun(rec, await rover.create(), rover.target), { ok: true, diffs: [] });
  const tampered = { ...rec, scorecard: { ...rec.scorecard, collisions: 0, distance: 1 } };
  const r = await verifyRun(tampered, await rover.create(), rover.target);
  assert.equal(r.ok, false);
  assert.match(r.diffs.join("\n"), /distance 1 → /);
});
