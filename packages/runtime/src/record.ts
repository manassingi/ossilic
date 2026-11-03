import { ENGINE_VERSION, manifestHash, type DeployTarget, type Pose, type RunRecord } from "@ossilic/spec";
import type { Machine } from "./machine.ts";

export interface RecordOptions { seconds: number; /** Sample the pose every N ticks. */ every?: number }

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Run a machine and produce reproducible evidence of what it did. */
export async function recordRun(machine: Machine, target: DeployTarget, opts: RecordOptions): Promise<RunRecord> {
  const every = opts.every ?? 5;
  const poses: [number, number, number][] = [];
  const startedAt = new Date().toISOString();
  await machine.run(opts.seconds, (rec) => {
    const p = rec.snapshot.pose as Pose | undefined;
    if (p && machine.ticks % every === 0) poses.push([r3(p.x), r3(p.y), r3(p.theta)]);
  });
  const m = machine.manifest;
  return {
    ossilic: "1", engine: ENGINE_VERSION,
    machine: { name: m.name, version: m.version, hash: await manifestHash(m) },
    target: target.name, driver: target.driver, seed: typeof target.config?.seed === "number" ? target.config.seed : null,
    tickHz: m.brain.tickHz, ticks: machine.ticks, duration: r3(machine.time), startedAt,
    scorecard: machine.scorecard(), trajectory: { every, poses },
    ...(m.license && { license: m.license }), ...(m.authors && { authors: m.authors }),
  };
}

/** Re-run a record on a fresh machine and report every difference. Determinism makes this exact. */
export async function verifyRun(record: RunRecord, machine: Machine, target: DeployTarget): Promise<{ ok: boolean; diffs: string[] }> {
  const diffs: string[] = [];
  const fresh = await recordRun(machine, target, { seconds: record.ticks / record.tickHz, every: record.trajectory.every });
  if (fresh.machine.hash !== record.machine.hash) diffs.push(`manifest hash ${record.machine.hash.slice(0, 12)} → ${fresh.machine.hash.slice(0, 12)}`);
  if (fresh.ticks !== record.ticks) diffs.push(`ticks ${record.ticks} → ${fresh.ticks}`);
  for (const k of new Set([...Object.keys(record.scorecard), ...Object.keys(fresh.scorecard)])) {
    const a = record.scorecard[k], b = fresh.scorecard[k];
    if (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 1e-9 : a !== b) diffs.push(`${k} ${a} → ${b}`);
  }
  const last = record.trajectory.poses.at(-1), now = fresh.trajectory.poses.at(-1);
  if (JSON.stringify(last) !== JSON.stringify(now)) diffs.push(`final pose ${JSON.stringify(last)} → ${JSON.stringify(now)}`);
  return { ok: diffs.length === 0, diffs };
}
