import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePackage } from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../../../examples/rover/machine.json", import.meta.url), "utf8"));
const run = JSON.parse(readFileSync(new URL("../../../examples/rover/runs/sim.json", import.meta.url), "utf8"));

test("a package needs its model file and valid runs", () => {
  const ok = validatePackage({ ossilic: "1", manifest, files: { "rover.xml": "PG11am9jbz4=" }, runs: [run] });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  const missing = validatePackage({ ossilic: "1", manifest, files: {}, runs: [{ nope: 1 }] });
  const paths = missing.issues.map((i) => i.path);
  assert.ok(paths.includes("files") && paths.includes("runs[0].ossilic"));
  assert.equal(validatePackage({ ossilic: "1", manifest, files: { "../etc/passwd": "x" }, runs: [] }).ok, false);
});
