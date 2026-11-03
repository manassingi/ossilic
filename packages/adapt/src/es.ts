/**
 * A small evolution strategy in the unit box: a population of Gaussian
 * perturbations around a mean, the top third averaged into the next mean,
 * step size grown on success and shrunk on failure. Enough for a few hundred
 * evaluations of gait parameters or a small policy; a GPU trainer replaces it
 * for large policies without changing the Fit contract.
 */
import { Rng } from "./rng.ts";

export interface OptimizeOptions {
  dim: number;
  /** Starting point in [0, 1]^dim. */
  init: number[];
  budget: number;
  population?: number;
  sigma?: number;
  seed?: number;
  evaluate(x: number[], generation: number): Promise<number>;
  onProgress?(p: { evaluated: number; budget: number; best: number; generation: number }): void;
}

export interface OptimizeResult { best: number[]; bestScore: number; history: number[]; evaluated: number; /** The few best distinct candidates seen, best first. */ top: Array<{ x: number[]; score: number }> }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export async function optimize(o: OptimizeOptions): Promise<OptimizeResult> {
  const rng = new Rng(o.seed ?? 1);
  const lambda = o.population ?? Math.max(6, Math.min(16, 4 + Math.floor(3 * Math.log(o.dim))));
  const mu = Math.max(1, Math.floor(lambda / 3));
  let mean = o.init.map(clamp01), sigma = o.sigma ?? 0.2;
  let best = mean, bestScore = await o.evaluate(mean, 0), evaluated = 1;
  const history = [bestScore];
  const top: Array<{ x: number[]; score: number }> = [{ x: mean, score: bestScore }];
  const remember = (x: number[], score: number) => { top.push({ x, score }); top.sort((a, b) => b.score - a.score); top.splice(4); };
  for (let gen = 1; evaluated < o.budget; gen++) {
    const pop: Array<{ x: number[]; s: number }> = [];
    for (let k = 0; k < lambda && evaluated < o.budget; k++) {
      const x = mean.map((m) => clamp01(m + sigma * rng.gaussian()));
      const s = await o.evaluate(x, gen);
      pop.push({ x, s }); remember(x, s);
      evaluated++;
    }
    pop.sort((a, b) => b.s - a.s);
    const improved = pop[0].s > bestScore;
    if (improved) { best = pop[0].x; bestScore = pop[0].s; }
    const elite = pop.slice(0, mu);
    mean = mean.map((_, i) => elite.reduce((acc, e) => acc + e.x[i], 0) / elite.length);
    sigma = Math.min(0.5, Math.max(0.01, sigma * (improved ? 1.2 : 0.9)));
    history.push(bestScore);
    o.onProgress?.({ evaluated, budget: o.budget, best: bestScore, generation: gen });
  }
  return { best, bestScore, history, evaluated, top };
}
