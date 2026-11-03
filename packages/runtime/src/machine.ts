import type { MachineManifest, Scorecard } from "@ossilic/spec";
import { asDriverError, type Driver } from "./driver.ts";
import { compileGraph, type CompiledGraph } from "./graph.ts";
import type { SkillRegistry } from "./registry.ts";
import type { SkillInstance, TickContext } from "./skill.ts";

/** Where a machine's files come from: the manifest directory on disk, the bridge in Desktop, the package on the Hub. */
export type AssetSource = (path: string) => Promise<string>;

export interface TickRecord { t: number; values: Record<string, unknown>; snapshot: Record<string, unknown> }

/**
 * A Machine is a manifest bound to a driver and compiled into an executable
 * brain. It is deterministic: the same driver state yields the same outputs,
 * which is what makes replay, verification and sim-to-real comparison possible.
 */
export class Machine {
  readonly manifest: MachineManifest;
  readonly driver: Driver;
  readonly graph: CompiledGraph;
  readonly dt: number;
  /** What skills see: the driver, with every failure tagged as the world's, not the brain's. */
  #io: Driver;
  #instances = new Map<string, SkillInstance>();
  #prev: Record<string, unknown> = {};
  #last?: TickRecord;
  #ticks = 0;

  private constructor(manifest: MachineManifest, driver: Driver, registry: SkillRegistry, assets: Record<string, string>) {
    this.manifest = manifest;
    this.driver = driver;
    this.graph = compileGraph(manifest, registry);
    this.dt = 1 / manifest.brain.tickHz;
    const guard = <T>(f: () => T): T => { try { return f(); } catch (e) { throw asDriverError(e); } };
    this.#io = { ...driver, name: driver.name, readSensor: (id) => guard(() => driver.readSensor(id)), writeActuator: (id, c) => guard(() => driver.writeActuator(id, c)), init: (m) => driver.init(m), step: (dt) => driver.step(dt), snapshot: () => driver.snapshot() };
    for (const node of this.graph.order) this.#instances.set(node.id, node.spec.create(node.params, { assets }));
  }

  /** Compile the brain, load the files its skills need, then bind the driver. Compile errors surface before any hardware is touched. */
  static async create(manifest: MachineManifest, driver: Driver, registry: SkillRegistry, assetSource?: AssetSource): Promise<Machine> {
    const graph = compileGraph(manifest, registry);
    const assets: Record<string, string> = {};
    for (const node of graph.order) for (const path of node.spec.assets?.(node.params) ?? []) {
      if (!assetSource) throw new Error(`node "${node.id}" needs ${path} but no asset source was given`);
      assets[path] ??= await assetSource(path);
    }
    const m = new Machine(manifest, driver, registry, assets);
    try { await driver.init(manifest); } catch (e) { throw asDriverError(e); }
    return m;
  }

  get ticks(): number { return this.#ticks; }
  get time(): number { return this.#ticks * this.dt; }
  get last(): TickRecord | undefined { return this.#last; }
  /** True once the brain's `done` port reports the task complete. */
  get done(): boolean { return !!this.manifest.brain.done && this.#last?.values[this.manifest.brain.done] === true; }

  /** One brain cycle: read → think → act → advance the world. */
  async tick(): Promise<TickRecord> {
    const values: Record<string, unknown> = {};
    const ctx: TickContext = { t: this.time, dt: this.dt, driver: this.#io };
    for (const node of this.graph.order) {
      const source = node.spec.delayed ? this.#prev : values;
      const inputs: Record<string, unknown> = {};
      for (const e of this.graph.inputsOf.get(node.id) ?? []) inputs[e.toPort] = source[`${e.fromNode}.${e.fromPort}`];
      for (const [port, v] of Object.entries(this.#instances.get(node.id)!.tick(inputs, ctx))) values[`${node.id}.${port}`] = v;
    }
    try { await this.driver.step(this.dt); } catch (e) { throw asDriverError(e); }
    this.#ticks += 1;
    this.#prev = values;
    return (this.#last = { t: this.time, values, snapshot: this.driver.snapshot() });
  }

  /** Run for up to `seconds`, stopping early when the brain reports done. */
  async run(seconds: number, onTick?: (rec: TickRecord) => void): Promise<TickRecord> {
    const n = Math.round(seconds * this.manifest.brain.tickHz);
    let rec = this.#last!;
    for (let i = 0; i < n && !this.done; i++) { rec = await this.tick(); onTick?.(rec); }
    return rec;
  }

  /** Numeric and boolean driver state plus every metric port, at the last tick. */
  scorecard(): Scorecard {
    const card: Scorecard = {};
    for (const [k, v] of Object.entries(this.#last?.snapshot ?? {})) if (typeof v === "number" || typeof v === "boolean") card[k] = v;
    for (const node of this.graph.order) for (const port of node.spec.metrics ?? []) {
      const v = this.#last?.values[`${node.id}.${port}`];
      if (typeof v === "number" || typeof v === "boolean") card[`${node.id}.${port}`] = v;
    }
    return card;
  }

  dispose(): void {
    for (const inst of this.#instances.values()) inst.dispose?.();
    this.driver.dispose?.();
  }
}
