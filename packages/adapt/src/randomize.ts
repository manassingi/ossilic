/**
 * Domain randomization: each episode runs in a slightly different world, so a
 * brain that scores well is robust to the gap between simulation and reality.
 */
import type { DeployTarget } from "@ossilic/spec";
import { Rng } from "./rng.ts";

export function randomizeTarget(target: DeployTarget, seed: number): DeployTarget {
  const rng = new Rng(seed);
  const cfg = { ...(target.config ?? {}) } as Record<string, any>;
  cfg.seed = seed;
  if (target.driver === "sim2d") {
    if (cfg.start) cfg.start = { ...cfg.start, theta: (cfg.start.theta ?? 0) + rng.range(-0.6, 0.6) };
    if (Array.isArray(cfg.obstacles)) cfg.obstacles = cfg.obstacles.map((o: any) => ({ ...o, x: o.x + rng.range(-0.25, 0.25), y: o.y + rng.range(-0.25, 0.25) }));
    cfg.lidarNoise = rng.range(0.005, 0.04);
  } else if (target.driver === "mujoco") {
    cfg.frictionScale = rng.range(0.7, 1.3);
    cfg.massScale = rng.range(0.85, 1.15);
    if (cfg.lidarNoise !== undefined) cfg.lidarNoise = rng.range(0.005, 0.04);
  }
  return { ...target, config: cfg };
}
