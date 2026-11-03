import type { MachineManifest } from "@ossilic/spec";

/**
 * Hardware Abstraction Layer.
 *
 * A Driver binds a manifest's body to a world: a simulator, a dev board, a
 * ROS 2 bridge. Skills never touch hardware; they read sensors and write
 * actuators through the driver, so one brain runs wherever a driver exists.
 * Physical limits (motor saturation, sensor noise) live here, so the brain
 * feels them in simulation.
 */
export interface Driver {
  readonly name: string;
  /** Bind the body. Throw if it cannot be bound. */
  init(manifest: MachineManifest): void | Promise<void>;
  readSensor(id: string): unknown;
  writeActuator(id: string, command: unknown): void;
  /** Advance the world (sim) or flush commands and poll (hardware). May be async (out-of-process hosts). */
  step(dt: number): void | Promise<void>;
  /** Observable state. Numeric and boolean fields become scorecard metrics; `pose` is recorded as the trajectory. */
  snapshot(): Record<string, unknown>;
  dispose?(): void;
  info?(): DriverInfo;
}

/** Optional: what the driver runs on, recorded with evidence (e.g. `{ kernel: "mujoco 3.17.0" }`). */
export interface DriverInfo { kernel: string }

/** The world's preconditions failed (it starts inside an obstacle): neither the brain's fault nor the evaluator's. */
export class InvalidWorldError extends Error {}

/** The world itself failed (simulator, physics host, connection), as opposed to the brain. */
export class DriverError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.original = original;
  }
}

/** Tag anything a driver throws, so evaluators can tell infrastructure failures from policy failures. */
export const asDriverError = (e: unknown): Error => (e instanceof InvalidWorldError || e instanceof DriverError ? e : new DriverError(e));

const mix = (h: number, k: number) => {
  h = Math.imul(h ^ k, 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
};
/** A stable 32-bit key for a component id (FNV-1a). */
export function keyOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
/**
 * Counter-based noise in [0, 1): a pure function of where the value is (seed, tick, sensor, element),
 * never of how often anything was read. Two brains facing the same seed face the same world.
 * The MuJoCo host implements the same function in Python.
 */
export function noise(seed: number, ...keys: number[]): number {
  let h = mix(0x9e3779b9, seed | 0);
  for (const k of keys) h = mix(h, k | 0);
  return h / 4294967296;
}
