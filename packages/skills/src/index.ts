/**
 * @ossilic/skills — the standard library.
 *
 * Third-party skills follow the same SkillSpec contract and install into a
 * registry exactly the same way.
 */
import { ACTUATOR_TYPES, PORT_TYPES, SENSOR_TYPES, type PortType, type Pose, type Scan, type Twist } from "@ossilic/spec";
import { dmath, SkillRegistry, type SkillSpec } from "@ossilic/runtime";
import { actTwist, brainPolicy, navObserve } from "./policy.ts";

export * from "./policy.ts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (a: number) => dmath.atan2(dmath.sin(a), dmath.cos(a));

export const sensorRead: SkillSpec = {
  name: "sensor.read", version: "1.0.0", category: "io",
  description: "Reads one body sensor each tick. The output type follows the sensor's type.",
  inputs: {}, outputs: { value: "any" },
  params: { sensor: { type: "string", description: "Sensor id from body.sensors" } },
  ports: (p, m) => {
    const s = m.body.sensors.find((s) => s.id === p.sensor);
    if (!s) throw new Error(`no sensor "${p.sensor}" in body (has: ${m.body.sensors.map((s) => s.id).join(", ")})`);
    return { inputs: {}, outputs: { value: SENSOR_TYPES[s.type] } };
  },
  create: (p) => ({ tick: (_i, ctx) => ({ value: ctx.driver.readSensor(p.sensor as string) }) }),
};

export const actuatorWrite: SkillSpec = {
  name: "actuator.write", version: "1.0.0", category: "io",
  description: "Writes a command to one body actuator each tick. The input type follows the actuator's type.",
  inputs: { command: { type: "any" } }, outputs: {},
  params: { actuator: { type: "string", description: "Actuator id from body.actuators" } },
  ports: (p, m) => {
    const a = m.body.actuators.find((a) => a.id === p.actuator);
    if (!a) throw new Error(`no actuator "${p.actuator}" in body (has: ${m.body.actuators.map((a) => a.id).join(", ")})`);
    return { inputs: { command: { type: ACTUATOR_TYPES[a.type] } }, outputs: {} };
  },
  create: (p) => ({ tick: (i, ctx) => { ctx.driver.writeActuator(p.actuator as string, i.command); return {}; } }),
};

export const navGoto: SkillSpec = {
  name: "nav.goto", version: "1.0.0", category: "planning",
  description: "Drives toward a goal point from the current pose. Emits a twist and a `reached` flag.",
  inputs: { pose: { type: "pose" } }, outputs: { twist: "twist", reached: "bool", distance: "number" },
  metrics: ["reached", "distance"],
  params: {
    x: { type: "number" }, y: { type: "number" },
    tolerance: { type: "number", default: 0.15 },
    cruise: { type: "number", default: 0.6, description: "max linear speed, m/s", range: [0.2, 1.2] },
    turnGain: { type: "number", default: 2.0, range: [0.5, 5] },
  },
  create: (p) => ({
    tick: (i) => {
      const pose = i.pose as Pose;
      const dx = (p.x as number) - pose.x, dy = (p.y as number) - pose.y, dist = dmath.hypot(dx, dy);
      if (dist < (p.tolerance as number)) return { twist: { v: 0, w: 0 }, reached: true, distance: dist };
      const err = wrap(dmath.atan2(dy, dx) - pose.theta);
      const v = (p.cruise as number) * Math.max(0, dmath.cos(err)) * Math.min(1, dist / 0.5); // slow when facing away or close
      return { twist: { v, w: clamp((p.turnGain as number) * err, -2.5, 2.5) }, reached: false, distance: dist };
    },
  }),
};

export const navObstacleAvoid: SkillSpec = {
  name: "nav.obstacle_avoid", version: "1.0.0", category: "control",
  description: "Reactive avoidance from a planar scan. Passes `desired` through when the corridor ahead is clear; otherwise turns toward free space and commits to it briefly.",
  inputs: { scan: { type: "scan" }, desired: { type: "twist", required: false } },
  outputs: { twist: "twist", blocked: "bool", nearest: "number" },
  params: {
    stopDist: { type: "number", default: 0.5, description: "forward distance that triggers avoidance, m", range: [0.3, 1.2] },
    width: { type: "number", default: 0.32, description: "half-width of the corridor the body needs, m", range: [0.2, 0.5] },
    cruise: { type: "number", default: 0.5, range: [0.2, 1.0] },
    turnRate: { type: "number", default: 1.8, range: [0.8, 3.5] },
    commitTime: { type: "number", default: 0.7, description: "seconds to keep the escape heading after the corridor clears", range: [0.2, 1.5] },
  },
  create: (p) => {
    const stop = p.stopDist as number, width = p.width as number, cruise = p.cruise as number;
    let turnDir = 1, commitUntil = -1;
    return {
      tick: (i, ctx) => {
        const scan = i.scan as Scan;
        let nearest = scan.maxRange, left = 0, right = 0;
        scan.angles.forEach((a, k) => {
          const r = scan.ranges[k], fwd = r * dmath.cos(a);
          if (fwd > 0 && Math.abs(r * dmath.sin(a)) < width && fwd < nearest) nearest = fwd; // inside the swept corridor
          a > 0 ? (left += r) : a < 0 && (right += r);
        });
        const blocked = nearest < stop, freeSide = left >= right ? 1 : -1;
        if (blocked) {
          if (ctx.t > commitUntil) turnDir = freeSide;
          commitUntil = ctx.t + (p.commitTime as number);
          return { twist: { v: nearest < stop * 0.6 ? 0 : cruise * 0.3, w: (p.turnRate as number) * turnDir }, blocked, nearest };
        }
        if (ctx.t <= commitUntil) return { twist: { v: cruise * 0.7, w: 0.4 * turnDir }, blocked, nearest }; // keep the escape heading
        const d = (i.desired as Twist | undefined) ?? { v: cruise, w: 0 };
        const proximity = clamp((2 * stop - nearest) / stop, 0, 1); // bias toward open space when something is near
        return { twist: { v: d.v * (1 - 0.5 * proximity), w: d.w + 0.8 * proximity * freeSide }, blocked, nearest };
      },
    };
  },
};

export const controlPid: SkillSpec = {
  name: "control.pid", version: "1.0.0", category: "control",
  description: "Discrete PID with anti-windup: drives `measured` toward `setpoint`.",
  inputs: { setpoint: { type: "number" }, measured: { type: "number" } }, outputs: { output: "number", error: "number" },
  params: { kp: { type: "number", default: 1 }, ki: { type: "number", default: 0 }, kd: { type: "number", default: 0 }, min: { type: "number", default: -1e9 }, max: { type: "number", default: 1e9 } },
  create: (p) => {
    let integral = 0, prev: number | null = null;
    return {
      tick: (i, ctx) => {
        const err = (i.setpoint as number) - (i.measured as number);
        integral += err * ctx.dt;
        const raw = (p.kp as number) * err + (p.ki as number) * integral + (p.kd as number) * (prev === null ? 0 : (err - prev) / ctx.dt);
        prev = err;
        const output = clamp(raw, p.min as number, p.max as number);
        if (output !== raw) integral -= err * ctx.dt;
        return { output, error: err };
      },
    };
  },
};

export const mathGain: SkillSpec = {
  name: "math.gain", version: "1.0.0", category: "math",
  description: "value × k + offset.",
  inputs: { value: { type: "number" } }, outputs: { value: "number" },
  params: { k: { type: "number", default: 1 }, offset: { type: "number", default: 0 } },
  create: (p) => ({ tick: (i) => ({ value: (i.value as number) * (p.k as number) + (p.offset as number) }) }),
};

export const mathConstant: SkillSpec = {
  name: "math.constant", version: "1.0.0", category: "math",
  description: "Emits a constant number.",
  inputs: {}, outputs: { value: "number" },
  params: { value: { type: "number" } },
  create: (p) => ({ tick: () => ({ value: p.value as number }) }),
};

export const logicSwitch: SkillSpec = {
  name: "logic.switch", version: "1.0.0", category: "logic",
  description: "Emits `a` when `select` is true, otherwise `b`.",
  inputs: { select: { type: "bool" }, a: { type: "any" }, b: { type: "any" } }, outputs: { value: "any" },
  create: () => ({ tick: (i) => ({ value: i.select ? i.a : i.b }) }),
};

export const logicDelay: SkillSpec = {
  name: "logic.delay", version: "1.0.0", category: "logic",
  description: "Emits the value from the previous tick. Closes feedback loops; makes latency explicit.",
  delayed: true,
  inputs: { value: { type: "any" } }, outputs: { value: "any" },
  params: { type: { type: "string", default: "any", description: "port type carried, e.g. number or twist" } },
  ports: (p) => {
    if (!PORT_TYPES.includes(p.type as PortType)) throw new Error(`type must be one of: ${PORT_TYPES.join(", ")}`);
    return { inputs: { value: { type: p.type as PortType } }, outputs: { value: p.type as PortType } };
  },
  create: () => ({ tick: (i) => ({ value: i.value ?? null }) }),
};

export const gaitTrot: SkillSpec = {
  name: "gait.trot", version: "1.0.0", category: "control",
  description: "Open-loop trot for a quadruped with hip and knee pitch joints: diagonal legs swing together. Emits eight joint targets (fl, fr, rl, rr × hip, knee).",
  inputs: { speed: { type: "number", required: false, description: "0..1 scales stride; default 1" } }, outputs: { targets: "vector", phase: "number" },
  params: {
    frequency: { type: "number", default: 1.5, description: "strides per second", range: [1.0, 3.0] },
    hipAmp: { type: "number", default: 0.3, range: [0.1, 0.6] }, kneeAmp: { type: "number", default: 0.6, range: [0.2, 1.2] },
    hipOffset: { type: "number", default: 0.5, range: [0.2, 0.9] }, kneeOffset: { type: "number", default: -1.1, range: [-1.7, -0.6] },
  },
  create: (p) => {
    const legPhase = [0, Math.PI, Math.PI, 0]; // fl, fr, rl, rr: diagonal pairs in phase
    return {
      tick: (i, ctx) => {
        const s = (i.speed as number | undefined) ?? 1, phase = 2 * Math.PI * (p.frequency as number) * ctx.t;
        // hip swings sinusoidally; the knee flexes only while the hip moves forward (swing), so the foot clears the ground
        const targets = legPhase.flatMap((off) => [
          (p.hipOffset as number) + s * (p.hipAmp as number) * dmath.sin(phase + off),
          (p.kneeOffset as number) - s * (p.kneeAmp as number) * Math.max(0, -dmath.cos(phase + off)),
        ]);
        return { targets, phase: (phase % (2 * Math.PI)) / (2 * Math.PI) };
      },
    };
  },
};

export const BUILTIN_SKILLS: SkillSpec[] = [sensorRead, actuatorWrite, navGoto, navObstacleAvoid, navObserve, brainPolicy, actTwist, gaitTrot, controlPid, mathGain, mathConstant, logicSwitch, logicDelay];

export function createDefaultRegistry(): SkillRegistry {
  const r = new SkillRegistry();
  for (const s of BUILTIN_SKILLS) r.register(s);
  return r;
}
