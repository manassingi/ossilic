#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordRun, verifyRun } from "@ossilic/runtime";
import { createDefaultRegistry } from "@ossilic/skills";
import { ENGINE_VERSION, validateManifest, validateRunRecord } from "@ossilic/spec";
import { openMachine } from "./index.ts";
import { buildPackage, hubConfigPath, readHubConfig } from "./package.ts";
import { evidenceCommands } from "./evidence.ts";
import { TASKS, TEMPLATES, adapt, characterize, evaluate, fit } from "@ossilic/adapt";
import type { Progress } from "@ossilic/adapt";

const USAGE = `ossilic ${ENGINE_VERSION} — build intelligent physical products

  ossilic init <dir>                         scaffold a new machine
  ossilic validate <machine.json>            check the manifest and compile the brain
  ossilic run <machine.json> [--target t] [--seconds n] [--trace] [--record run.json]
  ossilic verify <machine.json> <run.json>   re-run a record and prove it reproduces
  ossilic inspect <machine.json>             print the compiled brain
  ossilic skills                             list installed skills
  ossilic characterize <machine.json> [--target t]            measure the body: a Body Profile
  ossilic evaluate <machine.json> --task navigate|walk [--episodes 10]   success rate over randomized worlds
  ossilic fit <machine.json> --task t [--template x] [--budget 120] [--apply]   tune a brain template in simulation
  ossilic adapt <machine.json> --task t [--budget 120] [--apply]   characterize → match → fit → evaluate
  ossilic suite <machine.json> --task t [--target t] [--episodes n] [--margin 0.1] [--guardrail metric:lower:2] [--pass 0.9]
                                             define a test and its decision rule: paired, seeded worlds
  ossilic test <machine.json> [--suite s | --all] [--update [--accept-regression "why"]] [--report out.md]
                                             run the suite, compare with the baseline, apply the release check
  ossilic compare <baseline.json> <candidate.json> [--report out.md]   paired comparison of two evidence files
  ossilic reproduce <hub listing url> [--dir d]   re-run a published machine's evidence here and report it
  ossilic pack <machine.json>                write a .ossilic package next to the manifest
  ossilic login <hub-url> <token>            remember a Hub and your publish token
  ossilic publish <machine.json> [--hub url] publish the machine and its run records to the Hub
`;

const flag = (args: string[], name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`missing ${what}`); return v; };

const progress = (): ((p: Progress) => void) => {
  let line = "";
  return (p) => {
    const next = p.phase === "fit" && p.budget ? `fit ${p.evaluated}/${p.budget} · best ${p.best?.toFixed(1)} · gen ${p.generation}` : p.phase === "evaluate" ? `evaluate ${p.evaluated}/${p.budget}` : p.message ?? p.phase;
    if (next !== line) { line = next; process.stderr.write(`\r${line.padEnd(60)}`); }
  };
};
const endProgress = () => process.stderr.write("\r" + "".padEnd(60) + "\r");

function printEval(label: string, e: { successRate: number; scores: number[]; mean: Record<string, number | boolean>; episodes: number }) {
  const meanScore = e.scores.reduce((a, v) => a + v, 0) / e.scores.length;
  console.log(`${label.padEnd(8)} success ${(e.successRate * 100).toFixed(0)}% over ${e.episodes} worlds · mean score ${meanScore.toFixed(1)} · ${Object.entries(e.mean).map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : v}`).join(" ")}`);
}

/** Write a fit result back: new params and brain files in place, version bumped, report next to the runs. */
function applyFit(path: string, dir: string, r: { manifest: any; assets: Record<string, string>; report: any }) {
  const [a, b, c] = String(r.manifest.version).split(/[.-]/).map(Number);
  const manifest = { ...r.manifest, version: `${a}.${b}.${(c || 0) + 1}` };
  for (const [file, text] of Object.entries(r.assets)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text + "\n"); }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`applied → ${path} (now ${manifest.version})${Object.keys(r.assets).length ? ` + ${Object.keys(r.assets).join(", ")}` : ""}`);
}

const commands: Record<string, (args: string[]) => Promise<number> | number> = {
  ...evidenceCommands,
  async characterize(args) {
    const o = openMachine(need(args[0], "manifest path"), flag(args, "target"));
    const p = await characterize(o.manifest, o.target, (m, t, a) => o.createFor(m, t, a));
    console.log(JSON.stringify(p, null, 2));
    return 0;
  },
  async evaluate(args) {
    const o = openMachine(need(args[0], "manifest path"), flag(args, "target"));
    const task = TASKS[need(flag(args, "task"), "--task")];
    if (!task) throw new Error(`unknown task; one of ${Object.keys(TASKS).join(", ")}`);
    const e = await evaluate({ manifest: o.manifest, target: o.target, task, episodes: Number(flag(args, "episodes") ?? 10), create: (m, t, a) => o.createFor(m, t, a), onProgress: progress() });
    endProgress(); printEval(task.name, e);
    return e.successRate >= 0.9 ? 0 : 2;
  },
  async fit(args) {
    const path = need(args[0], "manifest path");
    const o = openMachine(path, flag(args, "target"));
    const task = TASKS[need(flag(args, "task"), "--task")];
    if (!task) throw new Error(`unknown task; one of ${Object.keys(TASKS).join(", ")}`);
    const name = flag(args, "template");
    const template = name ? TEMPLATES.find((t) => t.name === name) : TEMPLATES.find((t) => t.task === task.name);
    if (!template) throw new Error(`unknown template; one of ${TEMPLATES.map((t) => t.name).join(", ")}`);
    const r = await fit({ manifest: o.manifest, target: o.target, task, template, registry: createDefaultRegistry(), create: (m, t, a) => o.createFor(m, t, a), budget: Number(flag(args, "budget") ?? 120), onProgress: progress() });
    endProgress();
    console.log(`fit ${template.name} on ${o.target.name}: ${r.report.evaluated} candidates in ${r.report.seconds}s · best score ${r.report.best.score}`);
    printEval("before", r.report.before); printEval("after", r.report.after);
    if (r.report.kept === "initial") console.log("kept the starting brain: no candidate beat it on the evaluation worlds");
    else if (Object.keys(r.report.best.params).length) console.log(`params ${Object.entries(r.report.best.params).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    mkdirSync(join(o.dir, "runs"), { recursive: true });
    writeFileSync(join(o.dir, "runs", `fit-${task.name}.json`), JSON.stringify(r.report, null, 2) + "\n");
    console.log(`report → runs/fit-${task.name}.json`);
    if (args.includes("--apply")) applyFit(path, o.dir, r);
    return 0;
  },
  async adapt(args) {
    const path = need(args[0], "manifest path");
    const o = openMachine(path, flag(args, "target"));
    const r = await adapt({ manifest: o.manifest, target: o.target, task: need(flag(args, "task"), "--task"), template: flag(args, "template"), registry: createDefaultRegistry(), create: (m, t, a) => o.createFor(m, t, a), budget: Number(flag(args, "budget") ?? 120), onProgress: progress() });
    endProgress();
    console.log(`body: ${r.profile.kind}, ${r.profile.dof} dof${r.profile.maxLinearSpeed ? `, ${r.profile.maxLinearSpeed} m/s, ${r.profile.maxTurnRate} rad/s` : ""}`);
    console.log(`template ${r.report.template}: ${r.report.evaluated} candidates in ${r.report.seconds}s · best score ${r.report.best.score}`);
    printEval("before", r.report.before); printEval("after", r.report.after);
    mkdirSync(join(o.dir, "runs"), { recursive: true });
    writeFileSync(join(o.dir, "runs", `fit-${r.report.task}.json`), JSON.stringify(r.report, null, 2) + "\n");
    if (args.includes("--apply")) applyFit(path, o.dir, r);
    return 0;
  },
  pack(args) {
    const path = need(args[0], "manifest path");
    const pkg = buildPackage(path);
    const out = join(dirname(path), `${pkg.manifest.name}.ossilic.json`);
    writeFileSync(out, JSON.stringify(pkg) + "\n");
    console.log(`packed ${pkg.manifest.name}@${pkg.manifest.version}: ${Object.keys(pkg.files).length} files, ${pkg.runs.length} run records → ${out}`);
    return 0;
  },
  login(args) {
    const hub = need(args[0], "hub url").replace(/\/$/, ""), token = need(args[1], "token");
    mkdirSync(dirname(hubConfigPath()), { recursive: true });
    writeFileSync(hubConfigPath(), JSON.stringify({ hub, token }, null, 2) + "\n", { mode: 0o600 });
    console.log(`logged in to ${hub}`);
    return 0;
  },
  async publish(args) {
    const cfg = readHubConfig();
    const hub = (flag(args, "hub") ?? cfg?.hub)?.replace(/\/$/, "");
    if (!hub || !cfg?.token) throw new Error("run `ossilic login <hub-url> <token>` first (get a token from the Hub's account page)");
    const pkg = buildPackage(need(args[0], "manifest path"));
    const res = await fetch(`${hub}/api/publish`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(pkg) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${hub} replied ${res.status}: ${body.error ?? "unknown error"}${body.issues ? "\n" + body.issues.map((i: any) => `  ${i.path}: ${i.message}`).join("\n") : ""}`);
    console.log(`published ${pkg.manifest.name}@${pkg.manifest.version} → ${hub}${body.url}`);
    for (const r of body.runs ?? []) console.log(`  run ${r.target}: ${r.stale ? "stale: recorded for another version ✗" : r.verified === true ? "verified by the Hub ✓" : r.verified === false ? "did NOT reproduce ✗" : "attested by author"}`);
    const said: Record<string, string> = { verified: "re-run by the Hub and reproduced ✓", attested: "attested by author (physics)", failed: "did NOT reproduce on the Hub ✗", stale: "stale: recorded for another version or test ✗" };
    for (const e of body.evidence ?? []) console.log(`  evidence ${e.suite}: ${said[e.status] ?? e.status}`);
    return 0;
  },
  init(args) {
    const dir = need(args[0], "directory");
    const file = join(dir, "machine.json");
    if (existsSync(file)) throw new Error(`${file} already exists`);
    mkdirSync(dir, { recursive: true });
    const name = dir.split("/").filter(Boolean).pop()!.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    writeFileSync(file, JSON.stringify(template(name), null, 2) + "\n");
    console.log(`Created ${file}\nNext: ossilic run ${file}`);
    return 0;
  },
  async validate(args) {
    const path = need(args[0], "manifest path");
    const r = validateManifest(JSON.parse(readFileSync(path, "utf8")));
    if (!r.ok) { console.error("✗ invalid manifest"); for (const i of r.issues) console.error(`  ${i.path}: ${i.message}`); return 1; }
    const m = await openMachine(path).create();
    m.dispose();
    console.log(`✓ ${m.manifest.name}@${m.manifest.version}: ${m.graph.order.length} nodes, ${m.graph.edges.length} edges, order ${m.graph.order.map((n) => n.id).join(" → ")}`);
    return 0;
  },
  async run(args) {
    const { manifest, target, create } = openMachine(need(args[0], "manifest path"), flag(args, "target"));
    const machine = await create();
    const trace = args.includes("--trace");
    const original = machine.tick.bind(machine);
    if (trace) machine.tick = async () => { const r = await original(); const p = r.snapshot.pose as any; if (p) console.log(`t=${r.t.toFixed(2)} x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} θ=${p.theta.toFixed(2)}`); return r; };
    const record = await recordRun(machine, target, { seconds: Number(flag(args, "seconds") ?? 20) });
    machine.dispose();
    console.log(`${manifest.name}@${manifest.version} on ${target.name} (${target.driver})  ${record.duration}s, ${record.ticks} ticks${machine.done ? ", done" : ""}`);
    for (const [k, v] of Object.entries(record.scorecard)) console.log(`  ${k.padEnd(16)} ${typeof v === "number" ? +v.toFixed(3) : v}`);
    const out = flag(args, "record");
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(record, null, 2) + "\n"); console.log(`recorded → ${out}`); }
    return 0;
  },
  async verify(args) {
    const r = validateRunRecord(JSON.parse(readFileSync(need(args[1], "run record path"), "utf8")));
    if (!r.ok) { console.error("✗ invalid run record"); for (const i of r.issues) console.error(`  ${i.path}: ${i.message}`); return 1; }
    const { target, create } = openMachine(need(args[0], "manifest path"), r.value!.target);
    const machine = await create();
    const { ok, diffs } = await verifyRun(r.value!, machine, target);
    machine.dispose();
    console.log(ok ? `✓ reproduces exactly (${r.value!.ticks} ticks, hash ${r.value!.machine.hash.slice(0, 12)})` : `✗ does not reproduce:\n` + diffs.map((d) => "  " + d).join("\n"));
    return ok ? 0 : 2;
  },
  async inspect(args) {
    const { graph } = await openMachine(need(args[0], "manifest path")).create();
    console.log(`order: ${graph.order.map((n) => `${n.id}${n.spec.delayed ? "⏱" : ""}`).join(" → ")}`);
    for (const e of graph.edges) console.log(`  ${e.fromNode}.${e.fromPort} → ${e.toNode}.${e.toPort}`);
    return 0;
  },
  skills() {
    for (const s of createDefaultRegistry().list()) {
      const ins = Object.entries(s.inputs).map(([k, v]) => `${k}:${v.type}${v.required === false ? "?" : ""}`).join(", ");
      const outs = Object.entries(s.outputs).map(([k, v]) => `${k}:${v}`).join(", ");
      console.log(`${s.name.padEnd(20)} ${s.category.padEnd(9)} (${ins}) → (${outs})\n${"".padEnd(30)} ${s.description}`);
    }
    return 0;
  },
};

function template(name: string) {
  return {
    ossilic: "1", name, version: "1.0.0", description: "Describe what this machine does.", license: "Apache-2.0", authors: [],
    body: {
      base: { type: "differential_drive", wheelBase: 0.3, wheelRadius: 0.05, maxWheelSpeed: 12 },
      sensors: [{ id: "lidar", type: "lidar2d", rays: 16, fov: 3.14159, range: 3 }, { id: "odom", type: "odometry" }],
      actuators: [{ id: "wheels", type: "differential_drive" }],
    },
    brain: {
      tickHz: 20,
      nodes: [
        { id: "lidar", skill: "sensor.read", params: { sensor: "lidar" } },
        { id: "avoid", skill: "nav.obstacle_avoid", params: { stopDist: 0.5, cruise: 0.4 } },
        { id: "wheels", skill: "actuator.write", params: { actuator: "wheels" } },
      ],
      edges: [{ from: "lidar.value", to: "avoid.scan" }, { from: "avoid.twist", to: "wheels.command" }],
    },
    deploy: { targets: [{ name: "sim", driver: "sim2d", config: { bounds: { w: 5, h: 5 }, start: { x: 0.5, y: 0.5, theta: 0.7 }, obstacles: [{ x: 2.5, y: 2.5, r: 0.5 }], seed: 1 } }] },
  };
}

const [cmd = "", ...rest] = process.argv.slice(2);
try {
  process.exitCode = commands[cmd] ? await commands[cmd](rest) : (console.log(USAGE), cmd ? 1 : 0);
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
}
