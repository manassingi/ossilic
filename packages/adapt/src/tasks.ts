/**
 * A task turns a Run Record into a score and a pass/fail. Fit maximizes the
 * score; Evaluate reports the pass rate. Scores are shaped so that partial
 * progress counts, which is what lets an optimizer climb.
 */
import { dmath } from "@ossilic/runtime";
import type { RunRecord, Scorecard } from "@ossilic/spec";

export interface Task {
  name: string;
  /** Bump when success or score change meaning: evidence from different versions is not comparable. */
  version: number;
  kind: "wheeled" | "legged";
  /** Episode length in simulated seconds. */
  seconds: number;
  success(rec: RunRecord): boolean;
  score(rec: RunRecord): number;
}

/** A brain metric (`node.name`) wins over a driver metric of the same name: `goto.distance` is distance to goal, `distance` is distance travelled. */
const metric = (card: Scorecard, name: string) => (Object.entries(card).find(([k]) => k.endsWith(`.${name}`)) ?? Object.entries(card).find(([k]) => k === name))?.[1];
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);

export const TASKS: Record<string, Task> = {
  navigate: {
    name: "navigate", version: 1, kind: "wheeled", seconds: 40,
    success: (r) => metric(r.scorecard, "reached") === true && num(r.scorecard.collisions) === 0,
    score: (r) => {
      const reached = metric(r.scorecard, "reached") === true;
      const dist = num(metric(r.scorecard, "distance"), 10);
      // collisions count blocked ticks in the kinematic sim, so the penalty saturates: touching a wall is bad, grinding along it is not worse than failing
      return (reached ? 100 + Math.max(0, 40 - r.duration) * 1.5 : -8 * dist) - 40 * Math.min(1, num(r.scorecard.collisions) / 10);
    },
  },
  walk: {
    name: "walk", version: 1, kind: "legged", seconds: 8,
    success: (r) => r.scorecard.upright === true && progress(r) > 2.0,
    score: (r) => (r.scorecard.upright === true ? 0 : -40) + 10 * progress(r) - 4 * drift(r),
  },
};

/** Forward progress along the body's starting heading, from the trajectory. */
function progress(r: RunRecord): number {
  const p = r.trajectory.poses; if (p.length < 2) return 0;
  const [x0, y0, th] = p[0], [x1, y1] = p[p.length - 1];
  return (x1 - x0) * dmath.cos(th) + (y1 - y0) * dmath.sin(th);
}
function drift(r: RunRecord): number {
  const p = r.trajectory.poses; if (p.length < 2) return 0;
  const [x0, y0, th] = p[0], [x1, y1] = p[p.length - 1];
  return Math.abs(-(x1 - x0) * dmath.sin(th) + (y1 - y0) * dmath.cos(th));
}
