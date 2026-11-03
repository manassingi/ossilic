import type { MachineManifest, PortType } from "@ossilic/spec";
import type { Driver } from "./driver.ts";

export interface ParamSpec {
  type: "number" | "string" | "boolean";
  default?: unknown;
  description?: string;
  /** For numbers: the sensible range an optimizer may search. */
  range?: [number, number];
}
export interface InputSpec { type: PortType; required?: boolean; description?: string }
export interface Ports { inputs: Record<string, InputSpec>; outputs: Record<string, PortType> }

export interface TickContext {
  /** Simulated or wall time since start, seconds. */
  t: number;
  dt: number;
  driver: Driver;
}

export interface SkillInstance {
  tick(inputs: Record<string, unknown>, ctx: TickContext): Record<string, unknown>;
  dispose?(): void;
}

/** Files a skill needs, read relative to the manifest before the machine starts. */
export interface CreateContext { assets: Record<string, string> }

/**
 * A Skill is the unit of reuse: a versioned, typed block of behavior
 * (perception, planning, control, I/O) that is published, discovered and
 * composed in a brain graph. Third-party skills follow this same contract.
 */
export interface SkillSpec extends Ports {
  name: string;
  version: string;
  description: string;
  category: "io" | "perception" | "planning" | "control" | "math" | "logic";
  params?: Record<string, ParamSpec>;
  /** Output ports that count as scorecard metrics. */
  metrics?: string[];
  /** Reads its inputs from the previous tick, which lets it close feedback loops. */
  delayed?: boolean;
  /** Specialize ports from params and the body (e.g. a sensor's type). */
  ports?(params: Record<string, unknown>, manifest: MachineManifest): Ports;
  /** Paths (relative to the manifest) this node needs loaded, e.g. a policy file. */
  assets?(params: Record<string, unknown>): string[];
  create(params: Record<string, unknown>, ctx: CreateContext): SkillInstance;
}

export function resolveParams(spec: SkillSpec, given: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = spec.params ?? {};
  for (const key of Object.keys(given)) if (!(key in schema)) throw new Error(`unknown param "${key}"`);
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(schema)) {
    const v = given[key] ?? p.default;
    if (v === undefined) throw new Error(`missing required param "${key}"`);
    if (typeof v !== p.type) throw new Error(`param "${key}" must be ${p.type}, got ${typeof v}`);
    out[key] = v;
  }
  return out;
}
