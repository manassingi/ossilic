/** AT7.1–7.3: a baseline only moves on purpose, and every move is recorded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../src/main.ts", import.meta.url).pathname;
const ossilic = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, OSSILIC_AUTHOR: "tester", GITHUB_ACTIONS: "" } });

test("AT7.1 AT7.2 a regression cannot become the baseline unless someone records why", () => {
  const dir = mkdtempSync(join(tmpdir(), "ossilic-gov-"));
  try {
    cpSync(new URL("../../../examples/rover", import.meta.url).pathname, dir, { recursive: true });
    rmSync(join(dir, "suites"), { recursive: true, force: true }); rmSync(join(dir, "evidence"), { recursive: true, force: true });
    assert.equal(ossilic(dir, "suite", "machine.json", "--task", "navigate", "--target", "sim", "--episodes", "60").status, 0);
    assert.equal(ossilic(dir, "test", "machine.json", "--update").status, 0);
    const first = readFileSync(join(dir, "evidence/navigate.json"), "utf8");
    assert.equal(JSON.parse(first).approval.by, "tester");

    const m = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8"));
    m.version = "1.0.1"; m.brain.nodes.find((n: any) => n.id === "goto").params.cruise = 0.2;
    writeFileSync(join(dir, "machine.json"), JSON.stringify(m));
    const refused = ossilic(dir, "test", "machine.json", "--update");
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /Baseline NOT updated/);
    assert.equal(readFileSync(join(dir, "evidence/navigate.json"), "utf8"), first, "the baseline is untouched");

    const accepted = ossilic(dir, "test", "machine.json", "--update", "--accept-regression", "slower on purpose for a safety demo");
    assert.equal(accepted.status, 0, accepted.stdout);
    const now = JSON.parse(readFileSync(join(dir, "evidence/navigate.json"), "utf8"));
    assert.equal(now.approval.reason, "slower on purpose for a safety demo");
    assert.match(now.approval.replaces, /^[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AT7.3 the GitHub Action never writes a baseline", () => {
  assert.doesNotMatch(readFileSync(new URL("../../../action.yml", import.meta.url), "utf8"), /--update/);
});
