import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Machine, type Driver } from "@ossilic/runtime";
import { createDefaultRegistry } from "@ossilic/skills";
import { Sim2DDriver } from "@ossilic/sim";
import { createMujocoDriver } from "@ossilic/mujoco";
import { Ros2Driver } from "@ossilic/ros2";
import { assertManifest, type DeployTarget, type MachineManifest } from "@ossilic/spec";

/** Drivers available to this CLI. Hardware drivers install as packages and register here. */
export const drivers: Record<string, (config: Record<string, unknown>, dir: string) => Driver> = {
  sim2d: (config) => new Sim2DDriver(config),
  mujoco: (config, dir) => createMujocoDriver(config, dir),
  ros2: (config) => new Ros2Driver(config),
};

export interface OpenedMachine {
  manifest: MachineManifest;
  target: DeployTarget;
  dir: string;
  /** A fresh, compiled machine bound to a fresh driver. */
  create(): Promise<Machine>;
  /** The same, for any manifest and target (Adapt runs many variants); in-memory assets win over files. */
  createFor(manifest: MachineManifest, target: DeployTarget, assets?: Record<string, string>): Promise<Machine>;
}

export function openMachine(path: string, targetName?: string): OpenedMachine {
  const manifest = assertManifest(JSON.parse(readFileSync(path, "utf8")));
  const target = targetName ? manifest.deploy.targets.find((t) => t.name === targetName) : manifest.deploy.targets[0];
  if (!target) throw new Error(`unknown target "${targetName}". Targets: ${manifest.deploy.targets.map((t) => t.name).join(", ")}`);
  const makeDriver = drivers[target.driver];
  if (!makeDriver) throw new Error(`no driver "${target.driver}" installed. Available: ${Object.keys(drivers).join(", ")}`);
  const dir = dirname(resolve(path));
  const registry = createDefaultRegistry();
  const createFor = (m: MachineManifest, t: DeployTarget, assets: Record<string, string> = {}) => {
    const make = drivers[t.driver];
    if (!make) throw new Error(`no driver "${t.driver}" installed`);
    return Machine.create(m, make(t.config ?? {}, dir), registry, async (p) => assets[p] ?? readFileSync(join(dir, p), "utf8"));
  };
  return { manifest, target, dir, create: () => createFor(manifest, target), createFor };
}
