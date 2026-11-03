/**
 * @ossilic/preview — pure renderers for the things people look at before they
 * run a machine: the brain as an SVG graph, a Run Record's trajectory as an
 * SVG map. No DOM, so the Hub renders them on the server and Desktop can
 * render thumbnails.
 */
import { parsePortRef, type MachineManifest, type RunRecord } from "@ossilic/spec";
import { resolveParams, type Ports, type SkillRegistry } from "@ossilic/runtime";

export interface LaidOutNode { id: string; skill: string; x: number; y: number; w: number; h: number; inputs: Array<[string, string]>; outputs: Array<[string, string]> }
export interface BrainLayout { nodes: LaidOutNode[]; edges: Array<{ from: string; to: string; type: string }>; width: number; height: number }

const W = 180, HEAD = 34, ROW = 18, PAD = 8, GAP_X = 70, GAP_Y = 30, MARGIN = 24;
export const TYPE_COLORS: Record<string, string> = { number: "#7cc56b", bool: "#e86aa0", vec2: "#c9a227", vector: "#3fb8a8", pose: "#9b7bff", twist: "#ffb020", scan: "#3fb0ff", imu: "#5a8cff", any: "#8b9aab" };

function ports(m: MachineManifest, skill: string, params: Record<string, unknown> | undefined, registry: SkillRegistry): Ports {
  if (!registry.has(skill)) return { inputs: {}, outputs: {} };
  const spec = registry.get(skill);
  try { return spec.ports?.(resolveParams(spec, params), m) ?? { inputs: spec.inputs, outputs: spec.outputs }; } catch { return { inputs: spec.inputs, outputs: spec.outputs }; }
}

/** Saved positions win; the rest flow left to right by dependency depth. Same rule as Ossilic Desktop. */
export function layoutBrain(m: MachineManifest, registry: SkillRegistry): BrainLayout {
  const nodes: LaidOutNode[] = m.brain.nodes.map((n) => {
    const p = ports(m, n.skill, n.params, registry);
    const inputs = Object.entries(p.inputs).map(([k, v]) => [k, v.type] as [string, string]);
    const outputs = Object.entries(p.outputs).map(([k, v]) => [k, v] as [string, string]);
    return { id: n.id, skill: n.skill, x: 0, y: 0, w: W, h: HEAD + Math.max(inputs.length, outputs.length, 1) * ROW + PAD, inputs, outputs };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const delayed = new Set(m.brain.nodes.filter((n) => registry.has(n.skill) && registry.get(n.skill).delayed).map((n) => n.id));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const preds = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of m.brain.edges) { const a = parsePortRef(e.from)!.node, b = parsePortRef(e.to)!.node; if (byId.has(a) && byId.has(b) && !delayed.has(b)) preds.get(b)!.push(a); }
  for (let i = 0; i < nodes.length; i++) for (const n of nodes) depth.set(n.id, Math.max(0, ...preds.get(n.id)!.map((p) => depth.get(p)! + 1)));
  const columns = new Map<number, number>();
  for (const n of nodes) {
    const saved = m.brain.layout?.[n.id];
    if (saved) { n.x = saved.x; n.y = saved.y; continue; }
    const d = depth.get(n.id)!; const y = columns.get(d) ?? 0;
    n.x = d * (W + GAP_X); n.y = y; columns.set(d, y + n.h + GAP_Y);
  }
  const minX = Math.min(0, ...nodes.map((n) => n.x)), minY = Math.min(0, ...nodes.map((n) => n.y));
  for (const n of nodes) { n.x += MARGIN - minX; n.y += MARGIN - minY; }
  const edges = m.brain.edges.flatMap((e) => {
    const a = byId.get(parsePortRef(e.from)!.node); const port = parsePortRef(e.from)!.port;
    const type = a?.outputs.find(([k]) => k === port)?.[1] ?? "any";
    return [{ from: e.from, to: e.to, type }];
  });
  return { nodes, edges, width: Math.max(...nodes.map((n) => n.x + n.w), 0) + MARGIN, height: Math.max(...nodes.map((n) => n.y + n.h), 0) + MARGIN };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** An SVG of the brain. Surfaces follow the host page's theme tokens when inlined, with light fallbacks when standalone. */
export function brainSvg(m: MachineManifest, registry: SkillRegistry): string {
  const L = layoutBrain(m, registry);
  const panel = "var(--surface, #ffffff)", head = "var(--surface-2, #eef2f6)", line = "var(--rule, #c8d0d8)", fg = "var(--fg, #16212b)", muted = "var(--muted, #5b6977)";
  const pos = (ref: string, side: "in" | "out") => {
    const p = parsePortRef(ref)!; const n = L.nodes.find((x) => x.id === p.node); if (!n) return null;
    const list = side === "in" ? n.inputs : n.outputs; const i = list.findIndex(([k]) => k === p.port); if (i < 0) return null;
    return { x: n.x + (side === "in" ? 0 : n.w), y: n.y + HEAD + 9 + i * ROW };
  };
  const parts: string[] = [];
  for (const e of L.edges) {
    const a = pos(e.from, "out"), b = pos(e.to, "in"); if (!a || !b) continue;
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    parts.push(`<path d="M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}" fill="none" stroke="${TYPE_COLORS[e.type] ?? TYPE_COLORS.any}" stroke-width="2"/>`);
  }
  for (const n of L.nodes) {
    parts.push(`<g transform="translate(${n.x} ${n.y})"><rect width="${n.w}" height="${n.h}" rx="6" fill="${panel}" stroke="${line}"/><rect width="${n.w}" height="${HEAD}" rx="6" fill="${head}"/>`,
      `<text x="10" y="14" font-size="12" font-weight="600" fill="${fg}">${esc(n.id)}</text><text x="10" y="27" font-size="10" fill="${muted}">${esc(n.skill)}</text>`);
    n.inputs.forEach(([k, t], i) => { const y = HEAD + 9 + i * ROW; parts.push(`<circle cx="0" cy="${y}" r="4.5" fill="${TYPE_COLORS[t] ?? TYPE_COLORS.any}"/><text x="10" y="${y + 4}" font-size="10.5" fill="${fg}">${esc(k)}</text>`); });
    n.outputs.forEach(([k, t], i) => { const y = HEAD + 9 + i * ROW; parts.push(`<circle cx="${n.w}" cy="${y}" r="4.5" fill="${TYPE_COLORS[t] ?? TYPE_COLORS.any}"/><text x="${n.w - 10}" y="${y + 4}" font-size="10.5" text-anchor="end" fill="${fg}">${esc(k)}${m.brain.done === `${n.id}.${k}` ? " ✓" : ""}</text>`); });
    parts.push("</g>");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${parts.join("")}</svg>`;
}

/** A top-down map of a Run Record's trajectory with the target's obstacles, when the target is a sim2d arena. */
export function trajectorySvg(record: RunRecord, target: { config?: Record<string, unknown> } | undefined, opts: { size?: number } = {}): string {
  const cfg = (target?.config ?? {}) as { bounds?: { w: number; h: number }; obstacles?: Array<{ x: number; y: number; r: number }> };
  const poses = record.trajectory.poses;
  const xs = poses.map((p) => p[0]), ys = poses.map((p) => p[1]);
  const w = cfg.bounds?.w ?? Math.max(1, ...xs) + 1, h = cfg.bounds?.h ?? Math.max(1, ...ys) + 1;
  const minX = cfg.bounds ? 0 : Math.min(0, ...xs) - 0.5, minY = cfg.bounds ? 0 : Math.min(0, ...ys) - 0.5;
  const size = opts.size ?? 240, s = size / Math.max(w, h);
  const X = (x: number) => (x - minX) * s, Y = (y: number) => size - (y - minY) * s;
  const obstacles = (cfg.obstacles ?? []).map((o) => `<circle cx="${X(o.x)}" cy="${Y(o.y)}" r="${o.r * s}" fill="var(--rule, #c8d0d8)"/>`).join("");
  const path = poses.length ? `<polyline points="${poses.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="#f26b2a" stroke-width="2" stroke-linejoin="round"/>` : "";
  const last = poses.at(-1);
  const dot = last ? `<circle cx="${X(last[0])}" cy="${Y(last[1])}" r="4" fill="#f26b2a"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="var(--surface-2, #f2f4f6)"/>${obstacles}${path}${dot}</svg>`;
}
