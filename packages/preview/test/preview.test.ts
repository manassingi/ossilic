import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDefaultRegistry } from "@ossilic/skills";
import { brainSvg, layoutBrain, trajectorySvg } from "../src/index.ts";

const rover = JSON.parse(readFileSync(new URL("../../../examples/rover/machine.json", import.meta.url), "utf8"));
const run = JSON.parse(readFileSync(new URL("../../../examples/rover/runs/sim.json", import.meta.url), "utf8"));

test("brain layout places dependents to the right of their sources", () => {
  const L = layoutBrain(rover, createDefaultRegistry());
  const x = (id: string) => L.nodes.find((n) => n.id === id)!.x;
  assert.ok(x("lidar") < x("avoid") && x("goto") < x("avoid") && x("avoid") < x("wheels"));
  assert.equal(L.edges.find((e) => e.from === "lidar.value")!.type, "scan");
});

test("svgs are well-formed and typed", () => {
  const svg = brainSvg(rover, createDefaultRegistry());
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.ok(svg.includes("#3fb0ff"), "scan wire color present");
  const traj = trajectorySvg(run, rover.deploy.targets[0]);
  assert.ok(traj.includes("<polyline") && traj.includes("<circle"));
});
