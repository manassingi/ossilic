import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPid, navGoto, sensorRead, logicDelay, createDefaultRegistry } from "../src/index.ts";
import { resolveParams, type TickContext } from "@ossilic/runtime";

const ctx = (dt: number): TickContext => ({ t: 0, dt, driver: null as any });

test("pid converges a first-order plant to its setpoint", () => {
  const pid = controlPid.create(resolveParams(controlPid, { kp: 2, ki: 1, kd: 0.05 }));
  let x = 0;
  for (let i = 0; i < 400; i++) x += (((pid.tick({ setpoint: 1, measured: x }, ctx(0.02)) as any).output as number) - x) * 0.06;
  assert.ok(Math.abs(x - 1) < 0.02, `x=${x}`);
});

test("goto turns toward the goal and reports reached", () => {
  const g = navGoto.create(resolveParams(navGoto, { x: 1, y: 1 }));
  const out = g.tick({ pose: { x: 0, y: 0, theta: 0 } }, ctx(0.05)) as any;
  assert.ok(out.twist.w > 0 && out.reached === false);
  assert.equal((g.tick({ pose: { x: 0.95, y: 1.0, theta: 0 } }, ctx(0.05)) as any).reached, true);
});

test("sensor.read types its output from the body, and rejects unknown sensors", () => {
  const body = { sensors: [{ id: "lidar", type: "lidar2d" }, { id: "odom", type: "odometry" }] } as any;
  assert.equal(sensorRead.ports!({ sensor: "odom" }, { body } as any).outputs.value, "pose");
  assert.throws(() => sensorRead.ports!({ sensor: "gps" }, { body } as any), /no sensor "gps"/);
});

test("logic.delay validates its type param", () => {
  assert.equal(logicDelay.ports!({ type: "twist" }, {} as any).outputs.value, "twist");
  assert.throws(() => logicDelay.ports!({ type: "tensor" }, {} as any), /type must be one of/);
});

test("default registry has the standard library", () => {
  const names = createDefaultRegistry().list().map((s) => s.name);
  for (const n of ["sensor.read", "actuator.write", "nav.goto", "nav.obstacle_avoid", "control.pid", "logic.delay"]) assert.ok(names.includes(n), n);
});
