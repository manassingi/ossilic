/**
 * Warm start by imitation: run a teacher brain, record what it saw and did,
 * and fit the policy network to it with plain gradient descent. Evolution then
 * refines a brain that already knows the task instead of a random one.
 */
import type { MachineManifest, DeployTarget, Pose, Scan, Twist } from "@ossilic/spec";
import { mlpParamCount } from "@ossilic/skills";
import { randomizeTarget } from "./randomize.ts";
import { Rng } from "./rng.ts";
import type { CreateMachine } from "./index.ts";

export interface Demo { obs: number[]; act: number[] }

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Collect (observation, action) pairs from a goto + avoid teacher on randomized worlds. Mirrors nav.observe and act.twist exactly. */
export async function collectNavigationDemos(teacher: MachineManifest, target: DeployTarget, create: CreateMachine, opts: { episodes: number; seconds: number; goal: { x: number; y: number }; maxSpeed: number; maxTurn: number; seed?: number }): Promise<Demo[]> {
  const lidar = teacher.brain.nodes.find((n) => n.skill === "sensor.read" && teacher.body.sensors.find((s) => s.id === n.params?.sensor)?.type === "lidar2d")!.id;
  const odom = teacher.brain.nodes.find((n) => n.skill === "sensor.read" && teacher.body.sensors.find((s) => s.id === n.params?.sensor)?.type === "odometry")!.id;
  const out = teacher.brain.nodes.find((n) => n.skill === "nav.obstacle_avoid")?.id ?? teacher.brain.nodes.find((n) => n.skill === "nav.goto")!.id;
  const demos: Demo[] = [];
  for (let e = 0; e < opts.episodes; e++) {
    const m = await create(teacher, randomizeTarget(target, (opts.seed ?? 3000) + e), {});
    try {
      await m.run(opts.seconds, (rec) => {
        const scan = rec.values[`${lidar}.value`] as Scan, pose = rec.values[`${odom}.value`] as Pose, tw = rec.values[`${out}.twist`] as Twist;
        if (!scan || !pose || !tw) return;
        const dx = opts.goal.x - pose.x, dy = opts.goal.y - pose.y, dist = Math.hypot(dx, dy), b = wrap(Math.atan2(dy, dx) - pose.theta);
        demos.push({ obs: [...scan.ranges.map((r) => r / scan.maxRange), Math.sin(b), Math.cos(b), Math.min(1, dist / 5)], act: [clamp(tw.v / opts.maxSpeed, 0, 1), clamp(tw.w / opts.maxTurn, -1, 1)] });
      });
    } finally { m.dispose(); }
  }
  return demos;
}

/** Fit tanh-MLP weights to demos with Adam on mean squared error. Returns flat weights in the layout brain.policy reads. */
export function trainMlp(shape: { inputs: number; hidden: number[]; outputs: number }, demos: Demo[], opts: { epochs?: number; lr?: number; seed?: number } = {}): number[] {
  const sizes = [shape.inputs, ...shape.hidden, shape.outputs];
  const n = mlpParamCount(shape.inputs, shape.hidden, shape.outputs);
  const rng = new Rng(opts.seed ?? 11);
  const w = new Float64Array(n), m = new Float64Array(n), v = new Float64Array(n), g = new Float64Array(n);
  let k = 0;
  for (let l = 0; l < sizes.length - 1; l++) { const scale = Math.sqrt(1 / sizes[l]); for (let i = 0; i < sizes[l] * sizes[l + 1]; i++) w[k++] = rng.gaussian() * scale; k += sizes[l + 1]; }
  const lr = opts.lr ?? 0.003, b1 = 0.9, b2 = 0.999, batch = 64;
  let step = 0;
  for (let epoch = 0; epoch < (opts.epochs ?? 40); epoch++) {
    const order = demos.map((_, i) => i).sort(() => rng.next() - 0.5);
    for (let s = 0; s < order.length; s += batch) {
      g.fill(0);
      for (const idx of order.slice(s, s + batch)) {
        const { obs, act } = demos[idx];
        // forward with cached activations
        const acts: number[][] = [obs]; let off = 0; const offsets: number[] = [];
        for (let l = 0; l < sizes.length - 1; l++) {
          offsets.push(off);
          const x = acts[l], y = new Array<number>(sizes[l + 1]).fill(0);
          for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) y[j] += x[i] * w[off + i * y.length + j];
          off += x.length * y.length;
          for (let j = 0; j < y.length; j++) y[j] = Math.tanh(y[j] + w[off + j]);
          off += y.length;
          acts.push(y);
        }
        // backward
        let delta = acts[acts.length - 1].map((y, j) => (2 * (y - act[j]) / act.length) * (1 - y * y));
        for (let l = sizes.length - 2; l >= 0; l--) {
          const x = acts[l], o = offsets[l], outN = sizes[l + 1];
          const prev = new Array<number>(x.length).fill(0);
          for (let i = 0; i < x.length; i++) for (let j = 0; j < outN; j++) { g[o + i * outN + j] += x[i] * delta[j]; prev[i] += w[o + i * outN + j] * delta[j]; }
          for (let j = 0; j < outN; j++) g[o + x.length * outN + j] += delta[j];
          delta = prev.map((p, i) => p * (1 - x[i] * x[i]));
        }
      }
      step++;
      for (let i = 0; i < n; i++) {
        const gi = g[i] / Math.min(batch, order.length - s);
        m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        w[i] -= lr * (m[i] / (1 - b1 ** step)) / (Math.sqrt(v[i] / (1 - b2 ** step)) + 1e-8);
      }
    }
  }
  return Array.from(w);
}
