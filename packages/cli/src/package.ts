import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertManifest, referencedFiles, validateEvidence, validateRunRecord, validateSuite, type Evidence, type OssilicPackage, type RunRecord, type Suite } from "@ossilic/spec";

/** Every valid JSON document in a folder; `skip` filters file names (e.g. local, unaccepted evidence). */
function readAll<T>(dir: string, validate: (v: unknown) => { ok: boolean; value?: T }, skip = (_f: string) => false): T[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !skip(f)).map((f) => validate(JSON.parse(readFileSync(join(dir, f), "utf8")))).filter((r) => r.ok).map((r) => r.value!) : [];
}

/** Build a .ossilic package from a machine directory: manifest, referenced files, runs/, suites/ and accepted evidence/ (never *.latest.json). */
export function buildPackage(manifestPath: string): OssilicPackage {
  const dir = dirname(resolve(manifestPath));
  const manifest = assertManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const files: Record<string, string> = {};
  for (const rel of referencedFiles(manifest)) {
    const p = join(dir, rel);
    if (!existsSync(p)) throw new Error(`the manifest references ${rel}, which does not exist`);
    files[rel] = readFileSync(p).toString("base64");
  }
  const runs = readAll<RunRecord>(join(dir, "runs"), validateRunRecord, (f) => f.startsWith("fit-"));
  const suites = readAll<Suite>(join(dir, "suites"), validateSuite);
  const evidence = readAll<Evidence>(join(dir, "evidence"), validateEvidence, (f) => f.endsWith(".latest.json")).filter((e) => suites.some((s) => s.name === e.suite.name));
  return { ossilic: "1", manifest, files, runs, ...(suites.length && { suites }), ...(evidence.length && { evidence }) };
}

export interface HubConfig { hub: string; token: string }
const CONFIG = join(homedir(), ".ossilic", "config.json");

export function readHubConfig(): HubConfig | null {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return null; }
}
export function hubConfigPath(): string { return CONFIG; }
