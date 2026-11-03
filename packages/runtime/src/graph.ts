import { parsePortRef, type MachineManifest } from "@ossilic/spec";
import type { SkillRegistry } from "./registry.ts";
import { resolveParams, type Ports, type SkillSpec } from "./skill.ts";

export interface CompiledEdge { fromNode: string; fromPort: string; toNode: string; toPort: string }
export interface CompiledNode { id: string; spec: SkillSpec; params: Record<string, unknown>; ports: Ports }
export interface CompiledGraph { order: CompiledNode[]; edges: CompiledEdge[]; inputsOf: Map<string, CompiledEdge[]> }

const compatible = (from: string, to: string) => from === to || from === "any" || to === "any";

/**
 * Compile a brain into an execution order. Checks skills, params, ports,
 * port types, required inputs, the done signal and cycles; reports every
 * error at once. Delayed nodes read the previous tick, so their incoming
 * edges do not constrain the order: that is how feedback loops are closed.
 */
export function compileGraph(manifest: MachineManifest, registry: SkillRegistry): CompiledGraph {
  const { brain } = manifest;
  const errors: string[] = [];
  const nodes = new Map<string, CompiledNode>();

  for (const n of brain.nodes) {
    if (!registry.has(n.skill)) { errors.push(`node "${n.id}": unknown skill "${n.skill}"`); continue; }
    const spec = registry.get(n.skill);
    let params = {}, ports: Ports = { inputs: spec.inputs, outputs: spec.outputs };
    try { params = resolveParams(spec, n.params); ports = spec.ports?.(params, manifest) ?? ports; }
    catch (err) { errors.push(`node "${n.id}" (${n.skill}): ${(err as Error).message}`); }
    nodes.set(n.id, { id: n.id, spec, params, ports });
  }

  const edges: CompiledEdge[] = [];
  const inputsOf = new Map<string, CompiledEdge[]>();
  const connected = new Set<string>();
  for (const e of brain.edges) {
    const from = parsePortRef(e.from)!, to = parsePortRef(e.to)!;
    const a = nodes.get(from.node), b = nodes.get(to.node);
    if (!a || !b) continue;
    const outT = a.ports.outputs[from.port], inS = b.ports.inputs[to.port];
    if (!outT) errors.push(`edge ${e.from} → ${e.to}: ${a.spec.name} has no output "${from.port}" (has: ${Object.keys(a.ports.outputs).join(", ")})`);
    if (!inS) errors.push(`edge ${e.from} → ${e.to}: ${b.spec.name} has no input "${to.port}" (has: ${Object.keys(b.ports.inputs).join(", ")})`);
    if (outT && inS && !compatible(outT, inS.type)) errors.push(`edge ${e.from} → ${e.to}: type mismatch ${outT} → ${inS.type}`);
    if (connected.has(e.to)) errors.push(`input ${e.to} is connected more than once`);
    connected.add(e.to);
    const edge = { fromNode: from.node, fromPort: from.port, toNode: to.node, toPort: to.port };
    edges.push(edge);
    inputsOf.set(to.node, [...(inputsOf.get(to.node) ?? []), edge]);
  }

  for (const n of nodes.values())
    for (const [port, spec] of Object.entries(n.ports.inputs))
      if (spec.required !== false && !connected.has(`${n.id}.${port}`)) errors.push(`node "${n.id}": required input "${port}" is not connected`);

  if (brain.done) {
    const d = parsePortRef(brain.done)!;
    const t = nodes.get(d.node)?.ports.outputs[d.port];
    if (t && t !== "bool") errors.push(`brain.done: ${brain.done} is ${t}, must be bool`);
    else if (nodes.has(d.node) && !t) errors.push(`brain.done: no output "${d.port}" on node "${d.node}"`);
  }

  // Kahn's algorithm; delayed nodes impose no ordering on their producers.
  const indeg = new Map([...nodes.keys()].map((id) => [id, 0]));
  const out = new Map([...nodes.keys()].map((id) => [id, [] as string[]]));
  for (const e of edges) if (!nodes.get(e.toNode)!.spec.delayed) { indeg.set(e.toNode, indeg.get(e.toNode)! + 1); out.get(e.fromNode)!.push(e.toNode); }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: CompiledNode[] = [];
  for (let id = queue.shift(); id; id = queue.shift()) {
    order.push(nodes.get(id)!);
    for (const next of out.get(id)!) if (indeg.set(next, indeg.get(next)! - 1).get(next) === 0) queue.push(next);
  }
  if (order.length !== nodes.size) errors.push(`cycle detected among nodes: ${[...nodes.keys()].filter((id) => !order.some((n) => n.id === id)).join(", ")} (close feedback loops with logic.delay)`);

  if (errors.length) throw new Error("Brain graph failed to compile:\n" + errors.map((e) => "  - " + e).join("\n"));
  return { order, edges, inputsOf };
}
