/** Adapt: the data that flows from a body to a fitted brain. */
import type { Scorecard } from "./index.ts";

/** What Characterize measures about a machine. The Hub matches brain templates against this. */
export interface BodyProfile {
  ossilic: "1";
  machine: string;
  target: string;
  kind: "wheeled" | "legged" | "unknown";
  /** Degrees of freedom the brain can command. */
  dof: number;
  mass?: number;
  /** Measured on the target by commanding full speed for a second. */
  maxLinearSpeed?: number;
  maxTurnRate?: number;
  sensors: string[];
  actuators: string[];
  joints?: string[];
  measuredAt: string;
}

/** A tiny neural policy: dense layers with tanh, flattened weights. Runs anywhere; no runtime dependency. */
export interface MlpPolicy {
  ossilic: "1";
  kind: "mlp";
  inputs: number;
  hidden: number[];
  outputs: number;
  /** Layer by layer: W (in×out, row-major) then b, for every layer. */
  weights: number[];
  /** Normalization applied to observations before the network. */
  obsScale?: number[];
}

export interface EvalReport {
  ossilic: "1";
  machine: string;
  version: string;
  target: string;
  task: string;
  episodes: number;
  /** Fraction of episodes that met the task's success test. */
  successRate: number;
  /** Mean of each scorecard metric across episodes. */
  mean: Scorecard;
  /** Per-episode score from the task objective. */
  scores: number[];
  seeds: number[];
}

export interface FitReport {
  ossilic: "1";
  machine: string;
  target: string;
  task: string;
  template: string;
  budget: number;
  evaluated: number;
  /** Best objective seen and the parameters that produced it. */
  best: { score: number; params: Record<string, number> };
  /** Best score after each generation, for charts. */
  history: number[];
  before: EvalReport;
  after: EvalReport;
  /** "initial" when no candidate beat the starting brain on the evaluation worlds. */
  kept: "initial" | "fitted";
  startedAt: string;
  seconds: number;
}
