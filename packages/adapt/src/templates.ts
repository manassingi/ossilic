/**
 * Brain templates: starting brains for a task and body class, with the knobs
 * an optimizer may turn. A template installs its graph into a manifest (when
 * the manifest does not already carry one) and exposes a parameter vector.
 */
import { addNode, connect, parsePortRef, setParams, type MachineManifest, type MlpPolicy } from "@ossilic/spec";
import { mlpParamCount, navObsSize } from "@ossilic/skills";
import type { SkillRegistry } from "@ossilic/runtime";

export interface Knob { node: string; key: string; lo: number; hi: number; init: number }

export interface Prepared {
  manifest: MachineManifest;
  /** Parametric knobs, in order. */
  knobs: Knob[];
  /** For policy templates: the file and shape the weights go into. */
  policy?: { node: string; file: string; inputs: number; hidden: number[]; outputs: number; goal: { x: number; y: number }; maxSpeed: number; maxTurn: number };
  /** A hand-written brain for the same task that the policy can learn from first. */
  teacher?: MachineManifest;
  dim: number;
}

export interface BrainTemplate {
  name: string;
  task: string;
  kind: "wheeled" | "legged";
  description: string;
  prepare(m: MachineManifest, registry: SkillRegistry): Prepared;
}

const findNode = (m: MachineManifest, skill: string) => m.brain.nodes.find((n) => n.skill === skill);
const sensorOf = (m: MachineManifest, type: string) => m.body.sensors.find((s) => s.type === type)?.id;
const actuatorOf = (m: MachineManifest, type: string) => m.body.actuators.find((a) => a.type === type)?.id;

/** Knobs for every numeric param with a range on the named node (current value or default as init). */
function knobsFor(m: MachineManifest, nodeId: string, registry: SkillRegistry): Knob[] {
  const node = m.brain.nodes.find((n) => n.id === nodeId)!;
  const spec = registry.get(node.skill);
  return Object.entries(spec.params ?? {}).filter(([, p]) => p.type === "number" && p.range).map(([key, p]) => {
    const cur = node.params?.[key];
    return { node: nodeId, key, lo: p.range![0], hi: p.range![1], init: typeof cur === "number" ? cur : (p.default as number) };
  });
}

/** The goal a navigation template steers to: from an existing goto/observe node. */
function goal(m: MachineManifest): { x: number; y: number } {
  const n = findNode(m, "nav.goto") ?? findNode(m, "nav.observe");
  if (!n || typeof n.params?.x !== "number" || typeof n.params?.y !== "number") throw new Error("navigation templates need a goal: add a nav.goto node with x and y");
  return { x: n.params.x, y: n.params.y };
}

function ensureIO(m: MachineManifest, kind: "wheeled" | "legged") {
  const lidar = sensorOf(m, "lidar2d"), odom = sensorOf(m, "odometry"), wheels = actuatorOf(m, "differential_drive"), legs = actuatorOf(m, "joint_position");
  if (kind === "wheeled" && !(lidar && odom && wheels)) throw new Error("a wheeled body needs a lidar2d sensor, an odometry sensor and a differential_drive actuator");
  if (kind === "legged" && !legs) throw new Error("a legged body needs a joint_position actuator");
  return { lidar: lidar!, odom: odom!, wheels: wheels!, legs: legs! };
}

export const TEMPLATES: BrainTemplate[] = [
  {
    name: "navigate.goto-avoid", task: "navigate", kind: "wheeled",
    description: "Goal seeking with reactive obstacle avoidance; tunes speeds, gains and the avoidance corridor.",
    prepare(m0, registry) {
      let m = m0;
      const io = ensureIO(m, "wheeled");
      if (!findNode(m, "nav.goto") || !findNode(m, "nav.obstacle_avoid")) {
        const g = goal(m);
        m = { ...m, brain: { ...m.brain, nodes: [], edges: [], done: undefined } };
        const lidar = addNode(m, "sensor.read", { sensor: io.lidar }, "lidar"); m = lidar.manifest;
        const odom = addNode(m, "sensor.read", { sensor: io.odom }, "odom"); m = odom.manifest;
        m = addNode(m, "nav.goto", { x: g.x, y: g.y }, "goto").manifest;
        m = addNode(m, "nav.obstacle_avoid", {}, "avoid").manifest;
        m = addNode(m, "actuator.write", { actuator: io.wheels }, "wheels").manifest;
        m = connect(connect(connect(connect(m, "lidar.value", "avoid.scan"), "odom.value", "goto.pose"), "goto.twist", "avoid.desired"), "avoid.twist", "wheels.command");
        m = { ...m, brain: { ...m.brain, done: "goto.reached" } };
      }
      const knobs = [...knobsFor(m, findNode(m, "nav.goto")!.id, registry), ...knobsFor(m, findNode(m, "nav.obstacle_avoid")!.id, registry)];
      return { manifest: m, knobs, dim: knobs.length };
    },
  },
  {
    name: "navigate.policy", task: "navigate", kind: "wheeled",
    description: "A small neural policy from lidar and goal bearing to velocity, trained from scratch in simulation.",
    prepare(m0, registry) {
      let m = m0;
      const io = ensureIO(m, "wheeled");
      const g = goal(m);
      const rays = Number(m.body.sensors.find((s) => s.id === io.lidar)?.rays ?? 16);
      const file = "brains/navigate.mlp.json";
      if (!findNode(m, "brain.policy")) {
        m = { ...m, brain: { ...m.brain, nodes: [], edges: [], done: undefined } };
        m = addNode(m, "sensor.read", { sensor: io.lidar }, "lidar").manifest;
        m = addNode(m, "sensor.read", { sensor: io.odom }, "odom").manifest;
        m = addNode(m, "nav.observe", { x: g.x, y: g.y }, "observe").manifest;
        m = addNode(m, "brain.policy", { file }, "policy").manifest;
        m = addNode(m, "act.twist", {}, "act").manifest;
        m = addNode(m, "actuator.write", { actuator: io.wheels }, "wheels").manifest;
        for (const [a, b] of [["lidar.value", "observe.scan"], ["odom.value", "observe.pose"], ["observe.obs", "policy.obs"], ["policy.action", "act.action"], ["act.twist", "wheels.command"]]) m = connect(m, a, b);
        m = { ...m, brain: { ...m.brain, done: "observe.reached" } };
      }
      const node = findNode(m, "brain.policy")!;
      const act = findNode(m, "act.twist");
      const inputs = navObsSize(rays), hidden = [16], outputs = 2;
      const teacher = findNode(m0, "nav.goto") && findNode(m0, "nav.obstacle_avoid") ? m0 : TEMPLATES.find((t) => t.name === "navigate.goto-avoid")!.prepare(m0, registry).manifest;
      return { manifest: m, knobs: [], teacher, dim: mlpParamCount(inputs, hidden, outputs),
        policy: { node: node.id, file: String(node.params?.file ?? file), inputs, hidden, outputs, goal: g, maxSpeed: Number(act?.params?.maxSpeed ?? 0.6), maxTurn: Number(act?.params?.maxTurn ?? 2.0) } };
    },
  },
  {
    name: "walk.trot", task: "walk", kind: "legged",
    description: "Open-loop trot; tunes stride frequency, amplitudes and stance offsets for this body.",
    prepare(m0, registry) {
      let m = m0;
      const io = ensureIO(m, "legged");
      if (!findNode(m, "gait.trot")) {
        m = { ...m, brain: { ...m.brain, nodes: [], edges: [], done: undefined } };
        m = addNode(m, "gait.trot", {}, "gait").manifest;
        m = addNode(m, "actuator.write", { actuator: io.legs }, "legs").manifest;
        m = connect(m, "gait.targets", "legs.command");
      }
      const knobs = knobsFor(m, findNode(m, "gait.trot")!.id, registry);
      return { manifest: m, knobs, dim: knobs.length };
    },
  },
];

export function templatesFor(task: string, kind: string): BrainTemplate[] { return TEMPLATES.filter((t) => t.task === task && t.kind === kind); }

/** Apply a unit-box vector to a prepared template: knob values into params, or weights into a policy file. */
export const WEIGHT_SCALE = 3;

export function materialize(p: Prepared, x: number[], weightScale = WEIGHT_SCALE): { manifest: MachineManifest; assets: Record<string, string>; params: Record<string, number> } {
  let m = p.manifest;
  const params: Record<string, number> = {};
  p.knobs.forEach((k, i) => {
    const v = +(k.lo + (k.hi - k.lo) * x[i]).toFixed(4);
    params[`${k.node}.${k.key}`] = v;
    const node = m.brain.nodes.find((n) => n.id === k.node)!;
    m = setParams(m, k.node, { ...node.params, [k.key]: v });
  });
  const assets: Record<string, string> = {};
  if (p.policy) {
    const policy: MlpPolicy = { ossilic: "1", kind: "mlp", inputs: p.policy.inputs, hidden: p.policy.hidden, outputs: p.policy.outputs, weights: x.map((v) => +((v * 2 - 1) * weightScale).toFixed(5)) };
    assets[p.policy.file] = JSON.stringify(policy);
  }
  return { manifest: m, assets, params };
}

export function initialVector(p: Prepared, seed = 1): number[] {
  if (p.policy) { let s = seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; return Array.from({ length: p.dim }, () => 0.5 + (r() - 0.5) * 0.2); }
  return p.knobs.map((k) => Math.min(1, Math.max(0, (k.init - k.lo) / (k.hi - k.lo))));
}

/** Weights → unit box, clipped to the range materialize can express. */
export const weightsToVector = (w: number[], weightScale = WEIGHT_SCALE) => w.map((v) => Math.min(1, Math.max(0, (v / weightScale + 1) / 2)));

export { parsePortRef };
