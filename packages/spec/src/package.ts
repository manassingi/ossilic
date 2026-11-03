/**
 * The `.ossilic` package: what travels between Desktop, the CLI and the Hub.
 * A manifest, the files it references (models, meshes) and the Run Records
 * that prove it works. Files are base64 so the whole package is one JSON
 * document; a zip container can replace this later without changing callers.
 */
import { validateManifest, validateRunRecord, type Issue, type MachineManifest, type RunRecord, type ValidationResult } from "./index.ts";
import { validateEvidence, validateSuite, type Evidence, type Suite } from "./evidence.ts";

export interface OssilicPackage {
  ossilic: "1";
  manifest: MachineManifest;
  /** path relative to the manifest → base64 contents */
  files: Record<string, string>;
  runs: RunRecord[];
  /** The tests this machine is held to, and its evidence under each. */
  suites?: Suite[];
  evidence?: Evidence[];
}

/** Files a package must carry: the body model and every file a brain node loads. */
export function referencedFiles(m: MachineManifest): string[] {
  return [...new Set([m.body.model, ...m.brain.nodes.map((n) => n.params?.file)].filter((f): f is string => typeof f === "string"))];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/;

export function validatePackage(input: unknown): ValidationResult<OssilicPackage> {
  const issues: Issue[] = [];
  if (!isObj(input)) return { ok: false, issues: [{ path: "", message: "package must be an object" }] };
  if (input.ossilic !== "1") issues.push({ path: "ossilic", message: 'expected "1"' });
  const m = validateManifest(input.manifest);
  issues.push(...m.issues.map((i) => ({ path: `manifest.${i.path}`, message: i.message })));
  if (!isObj(input.files)) issues.push({ path: "files", message: "required object of path → base64" });
  else for (const [p, v] of Object.entries(input.files)) {
    if (!SAFE_PATH.test(p)) issues.push({ path: `files.${p}`, message: "paths are relative, without .." });
    if (typeof v !== "string") issues.push({ path: `files.${p}`, message: "must be base64 text" });
  }
  if (m.ok && m.value!.body.model && !(isObj(input.files) && m.value!.body.model in input.files)) issues.push({ path: "files", message: `body.model "${m.value!.body.model}" is not included` });
  if (!Array.isArray(input.runs)) issues.push({ path: "runs", message: "required array" });
  else input.runs.forEach((r, i) => issues.push(...validateRunRecord(r).issues.map((x) => ({ path: `runs[${i}].${x.path}`, message: x.message }))));
  const suites = input.suites ?? [], evidence = input.evidence ?? [];
  if (!Array.isArray(suites) || !Array.isArray(evidence)) issues.push({ path: "evidence", message: "suites and evidence must be arrays" });
  else {
    suites.forEach((s, i) => issues.push(...validateSuite(s).issues.map((x) => ({ path: `suites[${i}].${x.path}`, message: x.message }))));
    evidence.forEach((e, i) => {
      issues.push(...validateEvidence(e).issues.map((x) => ({ path: `evidence[${i}].${x.path}`, message: x.message })));
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, issues, value: input as unknown as OssilicPackage };
}
