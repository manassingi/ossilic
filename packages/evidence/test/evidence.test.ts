/** Acceptance tests for docs/I1-SPEC.md. Each test names the requirement it proves. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Machine } from "@ossilic/runtime";
import { createDefaultRegistry } from "@ossilic/skills";
import { Sim2DDriver } from "@ossilic/sim";
import { digest, EPISODE_STATUSES, setParams, validateEvidence, validateSuite, type Evidence, type EpisodeResult, type Suite } from "@ossilic/spec";
import { artifactDiff, compare, decide, defaultSuite, executedBy, markdownReport, newcombePaired, pairedBootstrap, rng, runSuite } from "../src/index.ts";

const root = new URL("../../../examples/", import.meta.url);
const load = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const reader = (dir: string) => (rel: string) => readFile(new URL(`${dir}/${rel}`, root));
const registry = createDefaultRegistry();
const sim = (dir: string) => async (m: any, t: any) => Machine.create(m, new Sim2DDriver(t.config ?? {}), registry, async (p) => (await reader(dir)(p)).toString("utf8"));
const rover = load("rover/machine.json");
const suiteOf = (episodes: number, patch: Partial<Suite> = {}): Suite => ({ ...defaultSuite(rover, "navigate", "sim"), episodes, ...patch });
const run = (manifest: any, suite: Suite, dir = "rover", create = sim(dir)) => runSuite({ manifest, suite, create, read: reader(dir), platform: "test" });

// ---------- §1 pairing ----------

test("AT1.1 lidar noise does not depend on how often it is read", () => {
  const cfg = { start: { x: 1, y: 1, theta: 0.3 }, obstacles: [{ x: 3, y: 3, r: 0.4 }], lidarNoise: 0.03, seed: 5 };
  const m = { body: { base: { type: "differential_drive" }, sensors: [{ id: "lidar", type: "lidar2d", rays: 9, fov: 3, range: 4 }], actuators: [{ id: "w", type: "differential_drive" }] } } as any;
  const once = new Sim2DDriver(cfg), twice = new Sim2DDriver(cfg);
  once.init(m); twice.init(m);
  for (let t = 0; t < 40; t++) {
    const a = once.readSensor("lidar"), b = twice.readSensor("lidar"), b2 = twice.readSensor("lidar");
    assert.deepEqual(a, b, `tick ${t}`); assert.deepEqual(b, b2, `second read, tick ${t}`);
    for (const d of [once, twice]) { d.writeActuator("w", { v: 0.3, w: 0.2 }); d.step(0.05); }
  }
});

test("AT1.2 AT5.1 AT3.4 the same brain on the same suite reproduces exactly, with every world accounted for", async () => {
  const s = suiteOf(12);
  const a = await run(rover, s), b = await run(rover, s);
  for (const e of [a, b]) {
    assert.ok(validateEvidence(e).ok, JSON.stringify(validateEvidence(e).issues));
    assert.equal(EPISODE_STATUSES.reduce((n, k) => n + e.accounting.byStatus[k], 0), e.accounting.planned);
  }
  assert.equal(compare(a, b).verdict, "exact_reproduction");
});

test("AT1.3 worlds pair only when they started in the same state", async () => {
  const s = suiteOf(6);
  const a = await run(rover, s), b = structuredClone(a);
  b.machine.version = "1.0.1"; b.identity.brain = "f".repeat(64);
  b.episodes[2].worldHash = "0".repeat(64);
  const c = compare(a, b);
  assert.equal(c.verdict, "not_comparable"); assert.match(c.reason, /did not start in the same state/);
});

test("AT1.4 a different world generation yields different world hashes", async () => {
  const r = await run(rover, suiteOf(3)), n = await run(rover, suiteOf(3, { randomize: false }));
  assert.notEqual(r.episodes[0].worldHash, n.episodes[0].worldHash);
  assert.equal(compare(r, n).verdict, "not_comparable");
});

// ---------- §2 identity ----------

test("AT2.1 AT8.2 changing only a policy's weights changes the brain, not the body, and is a change", async () => {
  const learned = load("rover-learned/machine.json"), s = { ...defaultSuite(learned, "navigate", "sim"), episodes: 4 };
  const base = await run(learned, s, "rover-learned");
  const file = learned.brain.nodes.find((n: any) => n.params?.file).params.file;
  const policy = JSON.parse(readFileSync(new URL(`rover-learned/${file}`, root), "utf8"));
  policy.weights = policy.weights.map((w: number, i: number) => (i % 7 === 0 ? w * 0.5 : w));
  const read = async (rel: string) => (rel === file ? JSON.stringify(policy) : reader("rover-learned")(rel));
  const cand = await runSuite({ manifest: learned, suite: s, read, platform: "test", create: async (m, t) => Machine.create(m, new Sim2DDriver(t.config ?? {}), registry, async (p) => (await read(p)).toString()) });
  assert.notEqual(cand.identity.brain, base.identity.brain);
  assert.equal(cand.identity.body, base.identity.body);
  assert.equal(cand.machine.manifest, base.machine.manifest, "the manifest alone cannot tell them apart");
  const c = compare(base, cand);
  assert.ok(!c.verdict.includes("reproduc"), c.verdict);
  assert.deepEqual(c.changes.map((x) => [x.kind, x.path]), [["file", file]], "reported by hash only");
});

test("AT2.2 changing the body changes its hash and the diff says so", async () => {
  const wide = structuredClone(rover); wide.body.base.wheelRadius = 0.06;
  const a = await run(rover, suiteOf(2)), b = await run(wide, suiteOf(2));
  assert.notEqual(a.identity.body, b.identity.body);
  assert.equal(a.identity.brain, b.identity.brain);
  assert.deepEqual(artifactDiff(a.artifact, b.artifact).map((x) => x.path), ["base.wheelRadius"]);
});

// ---------- §3 accounting ----------

const failingAt = (seeds: number[], kind: "driver" | "brain") => async (m: any, t: any) => {
  const driver = new Sim2DDriver(t.config ?? {});
  const machine = await Machine.create(m, driver, registry);
  if (seeds.includes(t.config.seed)) {
    if (kind === "driver") { const step = driver.step.bind(driver); let n = 0; driver.step = (dt) => { if (++n > 10) throw new Error("connection lost"); step(dt); }; }
    else { const tick = machine.tick.bind(machine); let n = 0; machine.tick = async () => { if (++n > 10) throw new Error("NaN in policy"); return tick(); }; }
  }
  return machine;
};

test("AT3.1 AT3.2 driver failures are infrastructure errors, brain failures are policy errors, and the suite finishes", async () => {
  const infra = await run(rover, suiteOf(8), "rover", failingAt([1003], "driver"));
  const ep = infra.episodes.find((e) => e.seed === 1003)!;
  assert.equal(ep.status, "infra_error"); assert.match(ep.error!, /connection lost/); assert.equal(infra.accounting.planned, 8);
  const brain = await run(rover, suiteOf(8), "rover", failingAt([1004], "brain"));
  assert.equal(brain.episodes.find((e) => e.seed === 1004)!.status, "policy_error");
  assert.equal(brain.summary.n, 8, "policy errors count as outcomes");
  const healthy = await run(rover, suiteOf(8));
  const c = compare(healthy, infra);
  assert.deepEqual(c.dropped, [{ seed: 1003, reason: "candidate infra_error" }], "the pair is dropped, listed, never counted against the policy");
});

test("AT3.3 too many infrastructure errors make the evaluation invalid and block the release", async () => {
  const base = await run(rover, suiteOf(10));
  const cand = await run({ ...rover, version: "1.0.1" }, suiteOf(10), "rover", failingAt([1001], "driver"));
  const c = compare(base, cand);
  assert.equal(c.verdict, "invalid_evaluation"); assert.equal(c.gate.pass, false);
});

// ---------- §4 statistics ----------

test("AT4.1 the paired success interval covers the true difference at least 93% of the time", () => {
  const r = rng(42);
  let worst = 1;
  for (const n of [20, 50, 100]) for (const pb of [0.5, 0.8, 0.95]) for (const delta of [-0.1, 0, 0.1]) for (const rho of [0, 0.5]) {
    const pc = pb + delta;
    if (pc <= 0 || pc >= 1) continue;
    const p11 = pb * pc + rho * Math.sqrt(pb * (1 - pb) * pc * (1 - pc)), p10 = pb - p11, p01 = pc - p11, p00 = 1 - p11 - p10 - p01;
    if (Math.min(p11, p10, p01, p00) < 0) continue;
    let hit = 0;
    for (let s = 0; s < 10_000; s++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let i = 0; i < n; i++) { const u = r(); if (u < p11) a++; else if (u < p11 + p10) b++; else if (u < p11 + p10 + p01) c++; else d++; }
      const ci = newcombePaired(a, b, c, d);
      if (ci.lo <= delta + 1e-12 && delta - 1e-12 <= ci.hi) hit++;
    }
    worst = Math.min(worst, hit / 10_000);
  }
  assert.ok(worst >= 0.93, `worst coverage ${worst}`);
});

test("AT4.2 the pair bootstrap covers the true mean difference at least 92% of the time from 30 pairs", () => {
  const r = rng(7);
  for (const n of [30, 50]) for (const dist of ["normal", "exponential"] as const) {
    let hit = 0; const S = 2000;
    for (let s = 0; s < S; s++) {
      const xs = Array.from({ length: n }, () => (dist === "normal" ? Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()) : -Math.log(r() || 1e-12) - 1));
      const ci = pairedBootstrap(xs, 0.05, 1000, s + 1);
      if (ci.lo <= 0 && 0 <= ci.hi) hit++;
    }
    assert.ok(hit / S >= 0.92, `n=${n} ${dist}: ${hit / S}`);
  }
});

test("AT4.3 AT4.5 verdicts use the margin, and the gate asks only whether the change is meaningfully worse", () => {
  assert.equal(decide(0.008, 0.022, 0.05), "no_meaningful_change", "real but smaller than the margin");
  assert.equal(decide(0.06, 0.2, 0.05), "meaningfully_improved");
  assert.equal(decide(-0.2, -0.06, 0.05), "meaningfully_regressed");
  assert.equal(decide(-0.03, 0.08, 0.05), "inconclusive");
  assert.equal(decide(-0.07, 0.02, 0.05), "inconclusive");
});

/** Synthetic paired evidence: `out` is each world's success, `metric` an extra scorecard value. */
function ev(brain: string, out: boolean[], suite: Suite, metric: (i: number) => number = () => 0): Evidence {
  const H = (c: string) => c.repeat(64);
  const episodes: EpisodeResult[] = out.map((ok, i) => ({ seed: 1000 + i, status: ok ? "success" : "failure", ticks: 10, world: {}, worldHash: H("9"), score: ok ? 100 : -5, scorecard: { collisions: metric(i) }, fingerprint: H(ok ? "a" : "b") }));
  const successes = out.filter(Boolean).length;
  const byStatus = Object.fromEntries(EPISODE_STATUSES.map((s) => [s, episodes.filter((e) => e.status === s).length])) as any;
  return {
    ossilic: "1", kind: "evidence", schema: 2, machine: { name: "m", version: brain === "1" ? "1.0.0" : "1.0.1", manifest: H(brain) },
    identity: { brain: H(brain), body: H("c"), world: H("d"), suite: H("e") }, suite, artifact: { tickHz: 20, nodes: {}, edges: [], body: {}, files: {} }, driver: "sim2d",
    environment: { engine: "t", evaluator: "t", scoring: "t", driver: "sim2d", kernel: "sim2d 2", runtime: "t", platform: "t" }, executedBy: { mode: "local" }, cases: suite.cases,
    accounting: { planned: out.length, completed: out.length, byStatus }, episodes, summary: { n: out.length, successes, successRate: successes / out.length, ci95: [0, 1], meanScore: 0 }, createdAt: "",
  };
}
const rep = (n: number, v: boolean) => Array<boolean>(n).fill(v);

test("AT4.5 two worlds lost in a hundred: safe at a 10-point margin, blocked at a 5-point margin", () => {
  for (const [margin, pass] of [[0.1, true], [0.05, false]] as const) {
    const s = suiteOf(100, { primary: { metric: "success", direction: "higher", margin } });
    const c = compare(ev("1", rep(100, true), s), ev("2", [...rep(2, false), ...rep(98, true)], s));
    assert.equal(c.gate.pass, pass, `margin ${margin}: ${c.reason}`);
  }
});

test("AT4.4 a guardrail regression blocks a release that improves the primary metric", () => {
  const s = suiteOf(100, { guardrails: [{ metric: "collisions", direction: "lower", margin: 0.5 }] });
  const c = compare(ev("1", [...rep(30, false), ...rep(70, true)], s), ev("2", rep(100, true), s, () => 3));
  assert.equal(c.verdict, "meaningfully_improved");
  assert.equal(c.gate.pass, false); assert.match(c.gate.reasons.join(), /guardrail collisions/);
});

test("AT4.6 gating on several suites widens each interval (Bonferroni)", () => {
  const s = suiteOf(100);
  const a = ev("1", [...rep(10, false), ...rep(90, true)], s), b = ev("2", [...rep(4, false), ...rep(96, true)], s);
  const one = compare(a, b).primary!, three = compare(a, b, { alpha: 0.05 / 3 }).primary!;
  assert.ok(three.lo < one.lo && three.hi > one.hi);
});

// ---------- §5 reproduction ----------

test("AT5.2 physics on another platform is an equivalent reproduction when every status agrees", () => {
  const s = suiteOf(20);
  const mk = (platform: string, flip = false) => {
    const e = ev("1", rep(20, true), s); e.driver = "mujoco"; e.environment.platform = platform;
    e.episodes = e.episodes.map((x, i) => ({ ...x, fingerprint: platform === "a" ? x.fingerprint : "7".repeat(64), status: flip && i === 0 ? "failure" : x.status }));
    return e;
  };
  assert.equal(compare(mk("a"), mk("b")).verdict, "equivalent_reproduction");
  assert.equal(compare(mk("a"), mk("b", true)).verdict, "did_not_reproduce");
});

test("AT5.3 a suite must say where its cases come from", () => {
  const { cases: _c, ...noCases } = suiteOf(10);
  assert.ok(!validateSuite(noCases).ok);
});

// ---------- §6 provenance ----------

test("AT6.1 a GitHub Actions run identifies itself; anywhere else the mode is local", () => {
  const keep = { ...process.env };
  delete process.env.GITHUB_ACTIONS; // this test may itself be running in Actions
  assert.deepEqual(executedBy(), { mode: "local" });
  Object.assign(process.env, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/robot", GITHUB_SHA: "abc1234", GITHUB_WORKFLOW_REF: "acme/robot/.github/workflows/ossilic.yml@refs/heads/main", GITHUB_RUN_ID: "42", GITHUB_SERVER_URL: "https://github.com" });
  try { assert.deepEqual(executedBy(), { mode: "ci", ci: { provider: "github-actions", repository: "acme/robot", commit: "abc1234", workflow: "acme/robot/.github/workflows/ossilic.yml@refs/heads/main", runUrl: "https://github.com/acme/robot/actions/runs/42" } }); }
  finally { for (const k of ["GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_WORKFLOW_REF", "GITHUB_RUN_ID", "GITHUB_SERVER_URL"]) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
});

// ---------- §8 §9 diffs and the report ----------

test("AT8.1 the artifact diff lists exactly the changed parameters", async () => {
  const goto = rover.brain.nodes.find((n: any) => n.id === "goto").params;
  const tuned = setParams({ ...rover, version: "1.0.1" }, "goto", { ...goto, cruise: 0.9 });
  const a = await run(rover, suiteOf(2)), b = await run(tuned, suiteOf(2));
  assert.deepEqual(artifactDiff(a.artifact, b.artifact), [{ kind: "param", path: "goto.cruise", from: goto.cruise, to: 0.9 }]);
});

test("AT9.1 every report leads with the decision and keeps its sections in order", async () => {
  const s = suiteOf(100);
  const cases: Array<[Evidence, Evidence]> = [
    [ev("1", rep(100, true), s), ev("2", [...rep(30, false), ...rep(70, true)], s)],
    [ev("1", [...rep(30, false), ...rep(70, true)], s), ev("2", rep(100, true), s)],
    [ev("1", [...rep(5, false), ...rep(95, true)], s), ev("2", [...rep(12, false), ...rep(88, true)], s)],
  ];
  const invalid = ev("2", rep(100, true), s); invalid.episodes = invalid.episodes.map((e, i) => (i < 10 ? { ...e, status: "infra_error" } : e));
  cases.push([ev("1", rep(100, true), s), invalid]);
  const expect = ["Meaningfully regressed", "Meaningfully improved", "Inconclusive", "Invalid evaluation"];
  cases.forEach(([a, b], i) => {
    const md = markdownReport(compare(a, b), a, b);
    assert.match(md, new RegExp(`\\*\\*Verdict: ${expect[i]}\\.\\*\\*`), md);
    const order = ["### Ossilic Release Check", "**Trust**", "**Which worlds changed**", "**Accounting**"].map((h) => md.indexOf(h));
    assert.ok(order.every((x, j) => x >= 0 && (j === 0 || x > order[j - 1])), `section order in report ${i}`);
  });
});

test("the real rover: a slowed brain is meaningfully worse and the release check blocks it", async () => {
  const goto = rover.brain.nodes.find((n: any) => n.id === "goto").params;
  const slow = setParams({ ...rover, version: "1.0.1" }, "goto", { ...goto, cruise: 0.2 });
  const s = suiteOf(60);
  const c = compare(await run(rover, s), await run(slow, s));
  assert.equal(c.gate.pass, false, c.reason);
  assert.equal(await digest(c.changes), await digest([{ kind: "param", path: "goto.cruise", from: goto.cruise, to: 0.2 }]));
});

// ---------- cross-platform determinism ----------
// Recorded on darwin-arm64. CI runs on linux-x64: any differing bit fails here, before it can
// turn a reproduction into "did not reproduce".

test("AT1.5 deterministic math gives the same bits on every platform", async () => {
  const { dmath } = await import("@ossilic/runtime");
  const bits = (x: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16).padStart(16, "0"); };
  const golden: Array<[keyof typeof dmath, number[], string]> = [
    ["sin", [0.7], "3fe49d6e694619b8"], ["sin", [-2.9], "bfce9fb8d64830e2"], ["cos", [1.3], "3fd11eb3682a4c5f"], ["cos", [47.1], "bfeffda995120bfd"],
    ["atan2", [0.31, -0.97], "4006a879ef160d19"], ["exp", [-3.3], "3fa2e259bb85be85"], ["log", [0.0371], "c00a5a652f99ea80"], ["tanh", [0.42], "3fd9674ee60feef4"],
  ];
  for (const [f, args, want] of golden) assert.equal(bits((dmath[f] as (...a: number[]) => number)(...args)), want, `${f}(${args})`);
});

test("AT1.6 the reference machines produce the same fingerprints on every platform", async () => {
  const golden: Record<string, string[]> = { rover: ["766b8d7b515be017", "ca052fbe8b334fec", "32fb476250f8be48"], "rover-learned": ["e845aa111f7f980a", "5bc23e188151cc6c", "155d96a0b9c7dd6a"] };
  for (const [dir, want] of Object.entries(golden)) {
    const m = load(`${dir}/machine.json`);
    const e = await run(m, { ...defaultSuite(m, "navigate", "sim"), episodes: 3 }, dir);
    assert.deepEqual(e.episodes.map((x) => x.fingerprint!.slice(0, 16)), want, dir);
  }
});
