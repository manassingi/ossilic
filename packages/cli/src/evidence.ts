/** `ossilic suite / test / compare / reproduce`: evidence on the command line and in CI. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { assertManifest, digest, isLegacyEvidence, validateEvidence, validatePackage, validateSuite, type Evidence, type MetricRule, type Suite } from "@ossilic/spec";
import { compare, defaultSuite, markdownReport, runSuite, summaryReport, VERDICT_WORDS } from "@ossilic/evidence";
import { openMachine } from "./index.ts";
import { readHubConfig } from "./package.ts";

const platform = () => `${process.platform}-${process.arch}`;
const flag = (args: string[], name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flags = (args: string[], name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`missing ${what}`); return v; };
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value, null, 2) + "\n"); };
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const issues = (r: { issues: Array<{ path: string; message: string }> }) => r.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");

function loadEvidence(path: string): Evidence {
  const r = validateEvidence(readJson(path));
  if (!r.ok) throw new Error(`${path} is not valid evidence:\n${issues(r)}`);
  return r.value!;
}

/** Who approves a baseline: --author, then OSSILIC_AUTHOR, then git, then the login name. */
function approver(args: string[]): string {
  const given = flag(args, "author") ?? process.env.OSSILIC_AUTHOR;
  if (given) return given;
  try { return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim() || userInfo().username; } catch { return userInfo().username; }
}

function suitePaths(dir: string, arg: string | undefined, all: boolean): string[] {
  const suitesDir = join(dir, "suites");
  const found = existsSync(suitesDir) ? readdirSync(suitesDir).filter((f) => f.endsWith(".json")).map((f) => join(suitesDir, f)) : [];
  if (arg) { const p = existsSync(arg) ? arg : join(suitesDir, `${arg}.json`); if (!existsSync(p)) throw new Error(`no suite at ${p}`); return [p]; }
  if (all ? found.length : found.length === 1) return found;
  throw new Error(found.length ? `this machine has ${found.length} suites; pick one with --suite, or gate on all of them with --all` : "this machine has no suite yet. Create one: ossilic suite <machine.json> --task navigate");
}

function loadSuite(path: string): Suite {
  const r = validateSuite(readJson(path));
  if (!r.ok) throw new Error(`${path} is not a valid suite:\n${issues(r)}`);
  return r.value!;
}

/** `metric:higher|lower:margin`, e.g. `collisions:lower:2`. */
function parseRule(spec: string): MetricRule {
  const [metric, direction, margin] = spec.split(":");
  if (!metric || (direction !== "higher" && direction !== "lower") || !(Number(margin) > 0)) throw new Error(`expected metric:higher|lower:margin, got "${spec}"`);
  return { metric, direction, margin: Number(margin) };
}

export const evidenceCommands: Record<string, (args: string[]) => Promise<number> | number> = {
  suite(args) {
    const path = need(args[0], "manifest path");
    const s = defaultSuite(assertManifest(readJson(path)), need(flag(args, "task"), "--task"), flag(args, "target"));
    if (flag(args, "episodes")) s.episodes = Number(flag(args, "episodes"));
    if (flag(args, "margin")) s.primary.margin = Number(flag(args, "margin"));
    if (flag(args, "primary")) s.primary = parseRule(flag(args, "primary")!);
    s.guardrails = flags(args, "guardrail").map(parseRule);
    if (flag(args, "pass")) s.pass = { successRate: Number(flag(args, "pass")) };
    const out = join(dirname(resolve(path)), "suites", `${s.name}.json`);
    if (existsSync(out) && !args.includes("--force")) throw new Error(`${out} exists; pass --force to replace it (this changes what earlier evidence compares against)`);
    const v = validateSuite(s);
    if (!v.ok) throw new Error(issues(v));
    write(out, s);
    console.log(`suite → ${relative(process.cwd(), out)}: ${s.episodes} paired ${s.randomize ? "randomized " : ""}worlds on ${s.target} · primary ${s.primary.metric} (margin ${s.primary.margin})${s.guardrails.length ? ` · guardrails ${s.guardrails.map((g) => g.metric).join(", ")}` : ""}\nNext: ossilic test ${path} --update   (records the baseline)`);
    return 0;
  },

  async test(args) {
    const path = need(args[0], "manifest path");
    const dir = dirname(resolve(path));
    const paths = suitePaths(dir, flag(args, "suite"), args.includes("--all"));
    const read = (rel: string) => readFile(join(dir, rel));
    let code = 0;
    const reports: string[] = [];
    for (const suitePath of paths) {
      const suite = loadSuite(suitePath);
      if (flag(args, "episodes")) suite.episodes = Number(flag(args, "episodes"));
      const o = openMachine(path, suite.target);
      const evidence = await runSuite({
        manifest: o.manifest, suite, create: (m, t, a) => o.createFor(m, t, a), read, platform: platform(), createdBy: flag(args, "author") ?? process.env.OSSILIC_AUTHOR,
        onProgress: (done, total) => { if (process.stderr.isTTY) process.stderr.write(`\r${suite.name}: world ${done}/${total}`.padEnd(40)); },
      });
      if (process.stderr.isTTY) process.stderr.write("\r".padEnd(41) + "\r");
      const baselinePath = join(dir, "evidence", `${suite.name}.json`);
      write(join(dir, "evidence", `${suite.name}.latest.json`), evidence);
      const reproduce = `ossilic test ${relative(process.cwd(), path)} --suite ${suite.name}`;
      const previous = existsSync(baselinePath) ? readJson(baselinePath) : null;
      let report: string, gatePass = true;
      if (!previous || isLegacyEvidence(previous)) {
        report = summaryReport(evidence) + (previous ? "\nThe baseline is legacy evidence (schema 1) and cannot be compared; accept a new one with --update.\n" : args.includes("--update") ? "" : `\nNo baseline yet. Accept this one: ${reproduce} --update\n`);
        gatePass = !suite.pass || evidence.summary.successRate >= suite.pass.successRate;
      } else {
        const base = loadEvidence(baselinePath);
        // one release gated on k suites: each interval at α/k, so the family stays at α (Bonferroni)
        const c = compare(base, evidence, { alpha: suite.alpha / paths.length });
        report = markdownReport(c, base, evidence, reproduce);
        gatePass = c.gate.pass;
      }
      if (args.includes("--update")) {
        const reason = flag(args, "accept-regression");
        if (!gatePass && !reason) { report += `\nBaseline NOT updated: this version fails the release check. To accept it anyway, record why: --accept-regression "<reason>"\n`; code = 1; }
        else {
          write(baselinePath, { ...evidence, approval: { by: approver(args), at: new Date().toISOString(), ...(reason && { reason }), ...(previous ? { replaces: await digest(previous) } : {}) } });
          report += `\nBaseline updated → ${relative(process.cwd(), baselinePath)}${reason ? ` (accepted despite the check: ${reason})` : ""}\n`;
        }
      } else if (!gatePass) code = 1;
      reports.push(report);
    }
    const all = reports.join("\n---\n\n");
    console.log(all);
    const out = flag(args, "report");
    if (out) write(out, all);
    return code;
  },

  /** Download a published machine, re-run its evidence here, and tell the Hub what you got. */
  async reproduce(args) {
    const url = new URL(need(args[0], "a listing URL, e.g. https://hub.example.com/p/alice/rover"));
    if (!/^\/p\/[^/]+\/[^/]+\/?$/.test(url.pathname)) throw new Error("expected a listing URL ending in /p/<handle>/<name>");
    const cfg = readHubConfig();
    const auth: Record<string, string> = cfg && new URL(cfg.hub).origin === url.origin ? { authorization: `Bearer ${cfg.token}` } : {};
    const res = await fetch(`${url.origin}${url.pathname.replace(/\/$/, "")}/package`, { headers: auth });
    if (!res.ok) throw new Error(`the Hub answered ${res.status}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
    const v = validatePackage(await res.json());
    if (!v.ok) throw new Error(`the Hub sent an invalid package:\n${issues(v)}`);
    const pkg = v.value!;
    if (!pkg.evidence?.length) { console.log(`${pkg.manifest.name}@${pkg.manifest.version} has no published evidence to reproduce.`); return 0; }
    const dir = flag(args, "dir") ?? mkdtempSync(join(tmpdir(), `ossilic-${pkg.manifest.name}-`));
    for (const [file, b64] of Object.entries(pkg.files)) write(join(dir, file), Buffer.from(b64, "base64"));
    write(join(dir, "machine.json"), pkg.manifest);
    let code = 0;
    for (const original of pkg.evidence) {
      const o = openMachine(join(dir, "machine.json"), original.suite.target);
      const mine = await runSuite({ manifest: o.manifest, suite: { ...original.suite, episodes: original.accounting.planned }, create: (m, t, a) => o.createFor(m, t, a), read: (rel) => readFile(join(dir, rel)), platform: platform(), createdBy: flag(args, "author") ?? process.env.OSSILIC_AUTHOR });
      const c = compare(original, mine);
      console.log(`${original.suite.name}: ${VERDICT_WORDS[c.verdict]} — ${c.reason}`);
      if (c.verdict === "did_not_reproduce" || c.verdict === "not_comparable") code = 1;
      if (!auth.authorization) { console.log("  (not sent: run `ossilic login` for this Hub to add your reproduction)"); continue; }
      const sent = await fetch(`${url.origin}/api/reproduce`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(mine) });
      const body = await sent.json().catch(() => ({}));
      console.log(sent.ok ? `  recorded on the Hub: ${body.reproductions} independent reproduction${body.reproductions === 1 ? "" : "s"}` : `  not recorded: ${body.error ?? sent.status}`);
    }
    console.log(`files kept in ${dir}`);
    return code;
  },

  compare(args) {
    const base = loadEvidence(need(args[0], "baseline evidence"));
    const cand = loadEvidence(need(args[1], "candidate evidence"));
    const c = compare(base, cand, { alpha: flag(args, "alpha") ? Number(flag(args, "alpha")) : undefined });
    const report = markdownReport(c, base, cand);
    console.log(report);
    const out = flag(args, "report");
    if (out) write(out, report);
    return c.gate.pass ? 0 : 1;
  },
};
