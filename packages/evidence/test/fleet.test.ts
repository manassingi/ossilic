import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRates, decideRollout, rng, type FleetMetric, type RobotCounts } from "../src/index.ts";

const interventions: FleetMetric = { name: "interventions", num: "interventions", den: "hours", better: "lower", margin: 0.1 };

/** Poisson (Knuth) and gamma (Marsaglia–Tsang) draws from one seeded stream. */
function sampler(seed: number) {
  const u = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const gamma = (k: number): number => {
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const z = normal(), v = (1 + c * z) ** 3;
      if (v > 0 && Math.log(1 - u()) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const poisson = (l: number) => { let k = 0, p = 1; const t = Math.exp(-l); do { k++; p *= u(); } while (p > t); return k - 1; };
  return { gamma, poisson };
}

/** A fleet: sites with different base rates, robots that differ (gamma, shape k), a canary of `canary` robots per site. */
function fleet(seed: number, o: { rates: number[]; robots: number; canary: number; hours: number; k: number; ratio: (site: number) => number }): RobotCounts[] {
  const s = sampler(seed), rows: RobotCounts[] = [];
  o.rates.forEach((rate, si) => {
    for (let i = 0; i < o.robots; i++) {
      const arm = i < o.canary ? "canary" : "control", mean = rate * s.gamma(o.k) * o.hours * (arm === "canary" ? o.ratio(si) : 1);
      rows.push({ robot: `r${si}-${i}`, site: `site-${si}`, arm, counts: { interventions: s.poisson(mean), hours: o.hours } });
    }
  });
  return rows;
}

test("AT-F1 the canary's rate-ratio interval covers the true ratio at least 93% of the time, and rarely understates harm", () => {
  const scenarios = [
    { name: "3 sites, 2 canary robots each", rates: [0.2, 0.5, 1], robots: 20, canary: 2, hours: 8, k: 4 },
    { name: "1 site, 3 canary robots", rates: [0.6], robots: 40, canary: 3, hours: 8, k: 4 },
    { name: "heterogeneous robots (k = 1.5)", rates: [0.3, 1.2], robots: 25, canary: 3, hours: 16, k: 1.5 },
    { name: "rare events", rates: [0.05, 0.1], robots: 30, canary: 3, hours: 24, k: 4 },
  ];
  for (const sc of scenarios) for (const truth of [1, 1.5]) {
    let hit = 0, missedHarm = 0, n = 0;
    for (let i = 0; i < 2000; i++) {
      const r = compareRates(fleet(1000 * i + 7, { ...sc, ratio: () => truth }), interventions);
      if (r.call === "not_enough_data") continue;
      n++; if (r.lo <= truth && truth <= r.hi) hit++; else if (r.hi < truth) missedHarm++;
    }
    assert.ok(hit / n >= 0.93, `${sc.name}, true ratio ${truth}: coverage ${(hit / n).toFixed(3)} over ${n}`);
    assert.ok(missedHarm / n <= 0.03, `${sc.name}, true ratio ${truth}: the upper bound fell below the truth ${(missedHarm / n).toFixed(3)} of the time`);
  }
});

test("AT-F2 looks are corrected: a version no worse than the old one is rolled back at most α of the time", () => {
  let falseCalls = 0;
  for (let i = 0; i < 1000; i++) {
    for (let look = 1; look <= 4; look++) {
      const rows = fleet(77 * i + look, { rates: [0.3, 0.8], robots: 25, canary: 3, hours: 6 * look, k: 4, ratio: () => 1 });
      if (decideRollout(rows, [interventions], { look, looks: 4 }).decision === "roll_back") { falseCalls++; break; }
    }
  }
  assert.ok(falseCalls / 1000 <= 0.05, `rolled back ${falseCalls} of 1000 equally good versions`);
});

const exact = (rates: number[], canaryRatio: (site: number) => number, hours = 40, robots = 20, canary = 3): RobotCounts[] =>
  rates.flatMap((rate, si) => Array.from({ length: robots }, (_, i) => {
    const arm = i < canary ? "canary" as const : "control" as const;
    const jitter = 1 + 0.1 * ((i % 5) - 2); // robots differ a little, deterministically
    return { robot: `r${si}-${i}`, site: `site-${si}`, arm, counts: { interventions: Math.round(rate * hours * jitter * (arm === "canary" ? canaryRatio(si) : 1)), hours } };
  }));

test("AT-F3 decisions: clear harm rolls back, a harmless version promotes, thin data waits, the last look holds", () => {
  const harm = decideRollout(exact([0.5, 1], () => 2), [interventions], { look: 1, looks: 4 });
  assert.equal(harm.decision, "roll_back");
  assert.match(harm.reason, /^interventions: 1\.\d\d× the old version's rate \(between/, "the fleet as a whole is worse, so the reason names the fleet");

  const fine = decideRollout(exact([0.5, 1], () => 1, 400, 30, 6), [{ ...interventions, margin: 0.25 }], { look: 2, looks: 4 });
  assert.equal(fine.decision, "promote", fine.reason);

  const thin = decideRollout(exact([0.5], () => 1, 2, 10, 1), [interventions], { look: 1, looks: 4 });
  assert.equal(thin.decision, "continue");
  assert.match(thin.reason, /not enough data/);

  assert.equal(decideRollout(exact([0.5, 1], () => 1.05, 40), [interventions], { look: 4, looks: 4 }).decision, "hold");
});

test("AT-F4 a regression at one site is caught even when the fleet as a whole looks acceptable", () => {
  const rows = exact([1, 1, 1], (s) => (s === 1 ? 2.5 : 0.8), 60, 20, 3);
  const r = decideRollout(rows, [{ ...interventions, margin: 0.25 }], { look: 1, looks: 4 });
  assert.ok(r.results[0].hi > 1.25, "pooled, the fleet does not look clearly worse");
  assert.equal(r.decision, "roll_back");
  assert.match(r.reason, /at site-1/);
});

test("AT-F5 'higher is better' metrics flip the margin, and a site needs both versions to count", () => {
  const tasks: FleetMetric = { name: "tasks per hour", num: "tasks", den: "hours", better: "higher", margin: 0.1 };
  const rows: RobotCounts[] = [];
  for (let i = 0; i < 20; i++) rows.push({ robot: `a${i}`, site: "a", arm: i < 3 ? "canary" : "control", counts: { tasks: (i < 3 ? 120 : 200) + (i % 4), hours: 1 } });
  rows.push({ robot: "lonely", site: "b", arm: "canary", counts: { tasks: 1, hours: 1 } });
  const r = compareRates(rows, tasks);
  assert.equal(r.call, "worse");
  assert.equal(r.canary.robots, 3, "site b has no control robot, so its canary is left out");
});
