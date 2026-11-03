/**
 * Pure edit operations on a manifest. Every editor (Desktop, CLI, Hub) goes
 * through these, so the rules live in one place and are testable without a UI.
 * Each returns a new manifest; the input is never mutated.
 */
import { parsePortRef, type ComponentDef, type DeployTarget, type MachineManifest, type NodeDef } from "./index.ts";

const ID = /^[a-z][a-z0-9_]*$/;
const clone = <T>(v: T): T => structuredClone(v);

/** A unique lowercase id derived from `base`: avoid, avoid_2, avoid_3 … */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const root = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+|_+$/g, "") || "node";
  if (!set.has(root)) return root;
  for (let i = 2; ; i++) if (!set.has(`${root}_${i}`)) return `${root}_${i}`;
}

export function addNode(m: MachineManifest, skill: string, params?: Record<string, unknown>, id?: string): { manifest: MachineManifest; id: string } {
  const out = clone(m);
  const nodeId = id ?? uniqueId(skill.split(".").pop()!, m.brain.nodes.map((n) => n.id));
  if (!ID.test(nodeId)) throw new Error(`invalid node id "${nodeId}"`);
  if (m.brain.nodes.some((n) => n.id === nodeId)) throw new Error(`node "${nodeId}" already exists`);
  const node: NodeDef = { id: nodeId, skill };
  if (params && Object.keys(params).length) node.params = params;
  out.brain.nodes.push(node);
  return { manifest: out, id: nodeId };
}

/** Removes the node and every edge touching it, and clears `done` if it pointed there. */
export function removeNode(m: MachineManifest, id: string): MachineManifest {
  const out = clone(m);
  out.brain.nodes = out.brain.nodes.filter((n) => n.id !== id);
  out.brain.edges = out.brain.edges.filter((e) => parsePortRef(e.from)!.node !== id && parsePortRef(e.to)!.node !== id);
  if (out.brain.done && parsePortRef(out.brain.done)!.node === id) delete out.brain.done;
  if (out.brain.layout) { delete out.brain.layout[id]; if (!Object.keys(out.brain.layout).length) delete out.brain.layout; }
  return out;
}

export function renameNode(m: MachineManifest, id: string, next: string): MachineManifest {
  if (!ID.test(next)) throw new Error(`invalid node id "${next}"`);
  if (next !== id && m.brain.nodes.some((n) => n.id === next)) throw new Error(`node "${next}" already exists`);
  const out = clone(m);
  const re = (ref: string) => { const p = parsePortRef(ref)!; return p.node === id ? `${next}.${p.port}` : ref; };
  for (const n of out.brain.nodes) if (n.id === id) n.id = next;
  out.brain.edges = out.brain.edges.map((e) => ({ from: re(e.from), to: re(e.to) }));
  if (out.brain.done) out.brain.done = re(out.brain.done);
  if (out.brain.layout?.[id]) { out.brain.layout[next] = out.brain.layout[id]; delete out.brain.layout[id]; }
  return out;
}

export function setParams(m: MachineManifest, id: string, params: Record<string, unknown>): MachineManifest {
  const out = clone(m);
  const n = out.brain.nodes.find((n) => n.id === id);
  if (!n) throw new Error(`no node "${id}"`);
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  Object.keys(clean).length ? (n.params = clean) : delete n.params;
  return out;
}

/** Connects `from` → `to`, replacing any edge already feeding that input (an input has one source). */
export function connect(m: MachineManifest, from: string, to: string): MachineManifest {
  if (!parsePortRef(from) || !parsePortRef(to)) throw new Error("ports are written node.port");
  const out = clone(m);
  out.brain.edges = [...out.brain.edges.filter((e) => e.to !== to), { from, to }];
  return out;
}

export function disconnect(m: MachineManifest, to: string): MachineManifest {
  const out = clone(m);
  out.brain.edges = out.brain.edges.filter((e) => e.to !== to);
  return out;
}

export function setLayout(m: MachineManifest, id: string, pos: { x: number; y: number }): MachineManifest {
  const out = clone(m);
  out.brain.layout = { ...out.brain.layout, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } };
  return out;
}

export function setDone(m: MachineManifest, port: string | undefined): MachineManifest {
  const out = clone(m);
  port ? (out.brain.done = port) : delete out.brain.done;
  return out;
}

export function setComponent(m: MachineManifest, kind: "sensors" | "actuators", def: ComponentDef): MachineManifest {
  if (!ID.test(def.id)) throw new Error(`invalid ${kind.slice(0, -1)} id "${def.id}"`);
  const out = clone(m);
  const list = out.body[kind];
  const i = list.findIndex((c) => c.id === def.id);
  i >= 0 ? (list[i] = def) : list.push(def);
  return out;
}

export function removeComponent(m: MachineManifest, kind: "sensors" | "actuators", id: string): MachineManifest {
  const out = clone(m);
  out.body[kind] = out.body[kind].filter((c) => c.id !== id);
  return out;
}

export function setBody(m: MachineManifest, patch: Partial<Pick<MachineManifest["body"], "base" | "model">>): MachineManifest {
  const out = clone(m);
  if (patch.base) out.body.base = patch.base;
  if ("model" in patch) patch.model ? (out.body.model = patch.model) : delete out.body.model;
  return out;
}

export function setTarget(m: MachineManifest, target: DeployTarget): MachineManifest {
  const out = clone(m);
  const i = out.deploy.targets.findIndex((t) => t.name === target.name);
  i >= 0 ? (out.deploy.targets[i] = target) : out.deploy.targets.push(target);
  return out;
}

export function removeTarget(m: MachineManifest, name: string): MachineManifest {
  if (m.deploy.targets.length <= 1) throw new Error("a machine needs at least one deploy target");
  const out = clone(m);
  out.deploy.targets = out.deploy.targets.filter((t) => t.name !== name);
  return out;
}

export function setMeta(m: MachineManifest, patch: Partial<Pick<MachineManifest, "name" | "version" | "description" | "license" | "authors">>): MachineManifest {
  const out = clone(m);
  for (const [k, v] of Object.entries(patch)) v === undefined || v === "" || (Array.isArray(v) && !v.length) ? delete (out as any)[k] : ((out as any)[k] = v);
  return out;
}

/** A minimal valid machine to start from. */
export function newManifest(name: string): MachineManifest {
  return {
    ossilic: "1", name, version: "1.0.0", license: "Apache-2.0",
    body: { base: { type: "differential_drive", wheelBase: 0.3, wheelRadius: 0.05, maxWheelSpeed: 12 }, sensors: [], actuators: [] },
    brain: { tickHz: 20, nodes: [], edges: [] },
    deploy: { targets: [{ name: "sim", driver: "sim2d", config: { bounds: { w: 5, h: 5 }, start: { x: 0.5, y: 0.5, theta: 0 }, obstacles: [], seed: 1 } }] },
  };
}
