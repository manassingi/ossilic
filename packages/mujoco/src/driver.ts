/**
 * @ossilic/mujoco — the physics driver (browser-safe part).
 *
 * MuJoCo runs in a host process that speaks the Ossilic Driver Host Protocol
 * (JSON lines). This driver is the client; the transport is pluggable: a Node
 * child process (see index.ts) or Ossilic Desktop's Rust core.
 */
import type { Driver } from "@ossilic/runtime";
import type { MachineManifest } from "@ossilic/spec";

export interface Transport {
  request(message: object): Promise<Record<string, any>>;
  close(): void;
}

export interface Geom { body: number; type: string; size: number[]; rgba: number[]; pos: number[]; quat: number[] }
export interface Scene { bodies: string[]; geoms: Geom[]; timestep: number }
/** Per body: x y z qw qx qy qz */
export type Frame = number[][];

export interface MujocoConfig { seed?: number; lidarNoise?: number }

export class MujocoDriver implements Driver {
  readonly name = "mujoco";
  scene?: Scene;
  frame?: Frame;
  /** Ask the host for body poses on every step (the Desktop viewport turns this on). */
  wantFrame = false;
  #transport: Transport;
  #sensors: Record<string, unknown> = {};
  #commands: Record<string, unknown> = {};
  #snapshot: Record<string, unknown> = {};
  #kernel = "mujoco";

  readonly config: MujocoConfig;
  readonly dir: string;

  /** `dir` is the manifest's directory; the host resolves body.model against it. */
  constructor(config: MujocoConfig, dir: string, transport: Transport) {
    this.config = config;
    this.dir = dir;
    this.#transport = transport;
  }

  async init(manifest: MachineManifest): Promise<void> {
    const r = await this.#call({ op: "init", manifest, config: this.config, dir: this.dir });
    this.#kernel = r.kernel ?? "mujoco";
    this.scene = r.scene;
    this.frame = r.frame;
    this.#sensors = r.sensors;
    this.#snapshot = r.snapshot;
  }

  info() { return { kernel: this.#kernel }; }

  readSensor(id: string): unknown {
    if (!(id in this.#sensors)) throw new Error(`mujoco: unknown sensor "${id}"`);
    return this.#sensors[id];
  }

  writeActuator(id: string, command: unknown): void { this.#commands[id] = command; }

  async step(dt: number): Promise<void> {
    const r = await this.#call({ op: "step", dt, commands: this.#commands, frame: this.wantFrame });
    this.#sensors = r.sensors;
    this.#snapshot = r.snapshot;
    if (r.frame) this.frame = r.frame;
  }

  snapshot(): Record<string, unknown> { return this.#snapshot; }

  dispose(): void { this.#transport.close(); }

  async #call(message: object): Promise<Record<string, any>> {
    const r = await this.#transport.request(message);
    if (!r.ok) throw new Error(`mujoco host: ${r.error}`);
    return r;
  }
}
