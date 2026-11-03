import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim2DDriver } from "../src/index.ts";

const manifest = {
  ossilic: "1", name: "t", version: "1.0.0",
  body: { base: { type: "differential_drive", wheelBase: 0.3, wheelRadius: 0.05, maxWheelSpeed: 10 }, sensors: [{ id: "lidar", type: "lidar2d", rays: 3, fov: Math.PI / 2, range: 5 }, { id: "odom", type: "odometry" }], actuators: [{ id: "wheels", type: "differential_drive" }] },
  brain: { tickHz: 10, nodes: [{ id: "a", skill: "x.y" }], edges: [] },
  deploy: { targets: [{ name: "sim", driver: "sim2d" }] },
} as any;

test("lidar sees walls and obstacles at the right distance", () => {
  const d = new Sim2DDriver({ bounds: { w: 10, h: 10 }, start: { x: 1, y: 5, theta: 0 }, obstacles: [{ x: 4, y: 5, r: 0.5 }] });
  d.init(manifest);
  const s = d.readSensor("lidar") as { angles: number[]; ranges: number[] };
  assert.equal(s.angles.length, 3);
  assert.ok(Math.abs(s.ranges[1] - 2.5) < 1e-9, `center ray ${s.ranges[1]}`);
  assert.ok(Math.abs(s.ranges[0] - 5) < 1e-9 && Math.abs(s.ranges[2] - 5) < 1e-9, "side rays capped at range");
});

test("motor limits clamp commanded speed and motion integrates", () => {
  const d = new Sim2DDriver({ bounds: { w: 10, h: 10 }, start: { x: 1, y: 1, theta: 0 } });
  d.init(manifest);
  d.writeActuator("wheels", { v: 100, w: 0 }); // far beyond 10 rad/s * 0.05 m = 0.5 m/s
  d.step(1);
  assert.ok(Math.abs(d.pose.x - 1.5) < 1e-9, `x=${d.pose.x}`);
  assert.equal(d.collisions, 0);
});

test("walls stop the robot and count collisions", () => {
  const d = new Sim2DDriver({ bounds: { w: 2, h: 2 }, start: { x: 1.7, y: 1, theta: 0 } });
  d.init(manifest);
  d.writeActuator("wheels", { v: 0.5, w: 0 });
  for (let i = 0; i < 10; i++) d.step(0.1);
  assert.ok(d.collisions > 0);
  assert.ok(d.pose.x <= 2 - d.cfg.robotRadius);
});
