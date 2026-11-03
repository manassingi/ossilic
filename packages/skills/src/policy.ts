/**
 * The MLP policy format and the skills that wrap a learned brain:
 * observe → policy → act. Pure arithmetic, no runtime dependency, so a
 * fitted brain runs in Node, in Desktop and on an edge board alike.
 */
import type { MlpPolicy, Pose, Scan, Twist } from "@ossilic/spec";
import { dmath, type SkillSpec } from "@ossilic/runtime";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (a: number) => dmath.atan2(dmath.sin(a), dmath.cos(a));

export function mlpParamCount(inputs: number, hidden: number[], outputs: number): number {
  let n = 0, prev = inputs;
  for (const h of [...hidden, outputs]) { n += prev * h + h; prev = h; }
  return n;
}

/** Dense tanh network; the last layer is tanh too, so actions land in [-1, 1]. */
export function mlpForward(p: MlpPolicy, obs: number[]): number[] {
  if (obs.length !== p.inputs) throw new Error(`policy expects ${p.inputs} inputs, got ${obs.length}`);
  let x = p.obsScale ? obs.map((v, i) => v * (p.obsScale![i] ?? 1)) : obs;
  let k = 0;
  for (const size of [...p.hidden, p.outputs]) {
    const y = new Array<number>(size).fill(0);
    for (let i = 0; i < x.length; i++) for (let j = 0; j < size; j++) y[j] += x[i] * p.weights[k + i * size + j];
    k += x.length * size;
    for (let j = 0; j < size; j++) y[j] = dmath.tanh(y[j] + p.weights[k + j]);
    k += size;
    x = y;
  }
  return x;
}

export function parsePolicy(text: string): MlpPolicy {
  const p = JSON.parse(text) as MlpPolicy;
  if (p.kind !== "mlp" || !Array.isArray(p.weights)) throw new Error("not a ossilic mlp policy");
  const need = mlpParamCount(p.inputs, p.hidden, p.outputs);
  if (p.weights.length !== need) throw new Error(`policy has ${p.weights.length} weights, shape needs ${need}`);
  return p;
}

export const brainPolicy: SkillSpec = {
  name: "brain.policy", version: "1.0.0", category: "planning",
  description: "Runs a learned policy (ossilic mlp file) on an observation vector and emits an action vector in [-1, 1].",
  inputs: { obs: { type: "vector" } }, outputs: { action: "vector" },
  params: { file: { type: "string", description: "policy file relative to the manifest, e.g. brains/navigate.mlp.json" } },
  assets: (p) => [p.file as string],
  create: (p, ctx) => {
    const policy = parsePolicy(ctx.assets[p.file as string]);
    return { tick: (i) => ({ action: mlpForward(policy, i.obs as number[]) }) };
  },
};

/** Observation count for nav.observe given a lidar's ray count. */
export const navObsSize = (rays: number) => rays + 3;

export const navObserve: SkillSpec = {
  name: "nav.observe", version: "1.0.0", category: "perception",
  description: "Packs a scan and the pose into one observation vector for a navigation policy: normalized ranges, goal bearing (sin, cos) and goal distance. Also reports distance and `reached`.",
  inputs: { scan: { type: "scan" }, pose: { type: "pose" } }, outputs: { obs: "vector", distance: "number", reached: "bool" },
  metrics: ["reached", "distance"],
  params: { x: { type: "number" }, y: { type: "number" }, tolerance: { type: "number", default: 0.15 } },
  create: (p) => ({
    tick: (i) => {
      const scan = i.scan as Scan, pose = i.pose as Pose;
      const dx = (p.x as number) - pose.x, dy = (p.y as number) - pose.y, dist = dmath.hypot(dx, dy);
      const bearing = wrap(dmath.atan2(dy, dx) - pose.theta);
      return { obs: [...scan.ranges.map((r) => r / scan.maxRange), dmath.sin(bearing), dmath.cos(bearing), Math.min(1, dist / 5)], distance: dist, reached: dist < (p.tolerance as number) };
    },
  }),
};

export const actTwist: SkillSpec = {
  name: "act.twist", version: "1.0.0", category: "control",
  description: "Turns a two-element action in [-1, 1] into a velocity command: forward speed from the first (never reverse), turn rate from the second.",
  inputs: { action: { type: "vector" } }, outputs: { twist: "twist" },
  params: { maxSpeed: { type: "number", default: 0.6, range: [0.1, 1.5] }, maxTurn: { type: "number", default: 2.0, range: [0.5, 4] } },
  create: (p) => ({ tick: (i) => { const a = i.action as number[]; return { twist: { v: (p.maxSpeed as number) * clamp(a[0] ?? 0, 0, 1), w: (p.maxTurn as number) * clamp(a[1] ?? 0, -1, 1) } as Twist }; } }),
};
