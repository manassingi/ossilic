/**
 * @ossilic/spec — the data contracts of the Ossilic platform.
 *
 * Everything else (engine, desktop, hub, cloud) is a view over these types.
 * A Machine Manifest describes an intelligent physical product; a Run Record
 * is reproducible evidence that it works. Both are plain JSON.
 */

export const SPEC_VERSION = "1";
export const ENGINE_VERSION = "1.0.0-alpha.1";

// ---------- physical types carried between skills ----------

export type PortType = "number" | "bool" | "vec2" | "vector" | "pose" | "twist" | "scan" | "imu" | "any";
export const PORT_TYPES: readonly PortType[] = ["number", "bool", "vec2", "vector", "pose", "twist", "scan", "imu", "any"];

export interface Vec2 { x: number; y: number }
export interface Pose { x: number; y: number; theta: number }
/** Velocity command: linear m/s, angular rad/s. */
export interface Twist { v: number; w: number }
/** Planar range scan; angles relative to heading, radians. */
export interface Scan { angles: number[]; ranges: number[]; maxRange: number }
/** Orientation (radians) and body-frame rates. */
export interface Imu { roll: number; pitch: number; yaw: number; gyro: [number, number, number]; acc: [number, number, number] }
/** A `vector` port carries number[] (joint targets, joint positions, embeddings). */

/** Canonical body component types and the port type each carries. */
export const SENSOR_TYPES: Readonly<Record<string, PortType>> = { lidar2d: "scan", odometry: "pose", imu: "imu", joint_state: "vector" };
export const ACTUATOR_TYPES: Readonly<Record<string, PortType>> = { differential_drive: "twist", joint_position: "vector" };

// ---------- machine manifest ----------

export interface ComponentDef { id: string; type: string; [key: string]: unknown }
export interface BodyDef {
  base: { type: string; [key: string]: unknown };
  /** Optional URDF/MJCF file for physics drivers, relative to the manifest. */
  model?: string;
  sensors: ComponentDef[];
  actuators: ComponentDef[];
}
export interface NodeDef { id: string; skill: string; params?: Record<string, unknown> }
/** `fromNode.port` → `toNode.port` */
export interface EdgeDef { from: string; to: string }
export interface BrainDef {
  tickHz: number;
  nodes: NodeDef[];
  edges: EdgeDef[];
  /** A bool port (`node.port`) that reports the task complete; a run stops when it is true. */
  done?: string;
  /** Editor positions per node id. Presentation only; ignored by the engine. */
  layout?: Record<string, { x: number; y: number }>;
}
export interface DeployTarget { name: string; driver: string; config?: Record<string, unknown> }

export interface MachineManifest {
  ossilic: typeof SPEC_VERSION;
  name: string;
  version: string;
  description?: string;
  license?: string;
  authors?: string[];
  lineage?: { forkedFrom: string };
  body: BodyDef;
  brain: BrainDef;
  deploy: { targets: DeployTarget[] };
}

// ---------- run record ----------

export type Scorecard = Record<string, number | boolean>;

export interface RunRecord {
  ossilic: typeof SPEC_VERSION;
  engine: string;
  machine: { name: string; version: string; hash: string };
  target: string;
  driver: string;
  seed: number | null;
  tickHz: number;
  ticks: number;
  /** Simulated seconds. */
  duration: number;
  startedAt: string;
  scorecard: Scorecard;
  trajectory: { every: number; poses: [number, number, number][] };
  license?: string;
  authors?: string[];
}

// ---------- validation ----------

export interface Issue { path: string; message: string }
export interface ValidationResult<T> { ok: boolean; issues: Issue[]; value?: T }

const ID = /^[a-z][a-z0-9_]*$/;
const SKILL = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PORT_REF = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parsePortRef(ref: string): { node: string; port: string } | null {
  const m = PORT_REF.exec(ref);
  return m ? { node: m[1], port: m[2] } : null;
}

/** @internal shared by the validators in this package */
export class Check {
  issues: Issue[] = [];
  fail(path: string, message: string) { this.issues.push({ path, message }); }
  str(v: unknown, path: string, re?: RegExp, what = "a string") { if (typeof v !== "string" || (re && !re.test(v))) this.fail(path, `must be ${what}`); }
  id(v: unknown, path: string) { this.str(v, path, ID, "a lowercase identifier (a-z, 0-9, _)"); }
  /** Validates a list of {id,...} objects with unique ids; calls `each` for extra checks. */
  idList(list: unknown, path: string, each: (item: Record<string, unknown>, p: string) => void) {
    if (!Array.isArray(list)) return this.fail(path, "must be an array");
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(item)) return this.fail(p, "must be an object");
      this.id(item.id, `${p}.id`);
      if (typeof item.id === "string") seen.has(item.id) ? this.fail(`${p}.id`, `duplicate id "${item.id}"`) : seen.add(item.id);
      each(item, p);
    });
  }
  result<T>(value: unknown): ValidationResult<T> {
    return this.issues.length ? { ok: false, issues: this.issues } : { ok: true, issues: [], value: value as T };
  }
}

/** Structural validation. Skill existence and port types are checked when the brain compiles. */
export function validateManifest(input: unknown): ValidationResult<MachineManifest> {
  const c = new Check();
  if (!isObj(input)) { c.fail("", "manifest must be an object"); return c.result(input); }

  if (input.ossilic !== SPEC_VERSION) c.fail("ossilic", `expected spec version "${SPEC_VERSION}"`);
  c.id(input.name, "name");
  c.str(input.version, "version", SEMVER, "semver, e.g. 1.0.0");
  if (input.description !== undefined) c.str(input.description, "description");
  if (input.license !== undefined) c.str(input.license, "license", undefined, "an SPDX license id, e.g. Apache-2.0");
  if (input.authors !== undefined && !(Array.isArray(input.authors) && input.authors.every((a) => typeof a === "string"))) c.fail("authors", "must be an array of strings");
  if (input.lineage !== undefined && !(isObj(input.lineage) && typeof input.lineage.forkedFrom === "string")) c.fail("lineage", "must be { forkedFrom: string }");

  const body = input.body;
  if (!isObj(body)) c.fail("body", "required object");
  else {
    if (!isObj(body.base) || typeof body.base.type !== "string") c.fail("body.base", "required object with a `type`");
    if (body.model !== undefined) c.str(body.model, "body.model");
    c.idList(body.sensors, "body.sensors", (s, p) => { if (typeof s.type !== "string" || !(s.type in SENSOR_TYPES)) c.fail(`${p}.type`, `must be one of: ${Object.keys(SENSOR_TYPES).join(", ")}`); });
    c.idList(body.actuators, "body.actuators", (a, p) => { if (typeof a.type !== "string" || !(a.type in ACTUATOR_TYPES)) c.fail(`${p}.type`, `must be one of: ${Object.keys(ACTUATOR_TYPES).join(", ")}`); });
  }

  const brain = input.brain;
  const nodeIds = new Set<string>();
  if (!isObj(brain)) c.fail("brain", "required object");
  else {
    if (typeof brain.tickHz !== "number" || !(brain.tickHz > 0 && brain.tickHz <= 1000)) c.fail("brain.tickHz", "must be a number in (0, 1000]");
    if (!Array.isArray(brain.nodes) || brain.nodes.length === 0) c.fail("brain.nodes", "required non-empty array");
    else c.idList(brain.nodes, "brain.nodes", (n, p) => {
      if (typeof n.id === "string") nodeIds.add(n.id);
      c.str(n.skill, `${p}.skill`, SKILL, "a namespaced skill name, e.g. nav.obstacle_avoid");
      if (n.params !== undefined && !isObj(n.params)) c.fail(`${p}.params`, "must be an object");
    });
    const ref = (v: unknown, path: string) => {
      const r = typeof v === "string" ? parsePortRef(v) : null;
      if (!r) c.fail(path, "must be `node.port`");
      else if (!nodeIds.has(r.node)) c.fail(path, `unknown node "${r.node}"`);
    };
    if (!Array.isArray(brain.edges)) c.fail("brain.edges", "required array");
    else brain.edges.forEach((e, i) => isObj(e) ? (ref(e.from, `brain.edges[${i}].from`), ref(e.to, `brain.edges[${i}].to`)) : c.fail(`brain.edges[${i}]`, "must be an object"));
    if (brain.done !== undefined) ref(brain.done, "brain.done");
    if (brain.layout !== undefined && !(isObj(brain.layout) && Object.values(brain.layout).every((v) => isObj(v) && typeof v.x === "number" && typeof v.y === "number"))) c.fail("brain.layout", "must map node ids to { x, y }");
  }

  const deploy = input.deploy;
  if (!isObj(deploy) || !Array.isArray(deploy.targets) || deploy.targets.length === 0) c.fail("deploy.targets", "required non-empty array");
  else {
    const names = new Set<string>();
    deploy.targets.forEach((t, i) => {
      const p = `deploy.targets[${i}]`;
      if (!isObj(t)) return c.fail(p, "must be an object");
      c.id(t.name, `${p}.name`);
      if (typeof t.name === "string") names.has(t.name) ? c.fail(`${p}.name`, `duplicate target "${t.name}"`) : names.add(t.name);
      c.str(t.driver, `${p}.driver`);
      if (t.config !== undefined && !isObj(t.config)) c.fail(`${p}.config`, "must be an object");
    });
  }
  return c.result<MachineManifest>(input);
}

export function validateRunRecord(input: unknown): ValidationResult<RunRecord> {
  const c = new Check();
  if (!isObj(input)) { c.fail("", "run record must be an object"); return c.result(input); }
  if (input.ossilic !== SPEC_VERSION) c.fail("ossilic", `expected spec version "${SPEC_VERSION}"`);
  c.str(input.engine, "engine");
  if (!isObj(input.machine) || typeof input.machine.hash !== "string") c.fail("machine", "required { name, version, hash }");
  for (const k of ["target", "driver", "startedAt"]) c.str(input[k], k);
  for (const k of ["tickHz", "ticks", "duration"]) if (typeof input[k] !== "number") c.fail(k, "must be a number");
  if (!isObj(input.scorecard)) c.fail("scorecard", "required object");
  if (!isObj(input.trajectory) || !Array.isArray(input.trajectory.poses)) c.fail("trajectory", "required { every, poses }");
  return c.result<RunRecord>(input);
}

export function assertManifest(input: unknown): MachineManifest {
  const r = validateManifest(input);
  if (!r.ok) throw new Error("Invalid machine manifest:\n" + r.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"));
  return r.value!;
}

// ---------- provenance ----------

/** JSON with sorted keys, so equal manifests hash equally regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** SHA-256 of a value's canonical JSON, hex. Works in Node and browsers. */
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of raw bytes or text, hex: file identity. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The identity of one exact machine version. */
export const manifestHash = (manifest: MachineManifest): Promise<string> => digest(manifest);

export * from "./edit.ts";
export * from "./package.ts";
export * from "./adapt.ts";
export * from "./evidence.ts";
