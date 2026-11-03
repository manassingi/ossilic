# Ossilic statistical methods

*Evidence schema 2, evaluator `ossilic-evidence 2`, 2026-11-03. Written for an outside statistical review, which is the gate for step I1. Code: `packages/evidence/src/stats.ts` and `compare.ts`. Tests: `packages/evidence/test/evidence.test.ts`.*

## The question

A team changes a robot policy from version A (baseline) to version B (candidate). Both versions run the same suite: n worlds, world i generated from seed `s₀ + i`. The world, its noise and its initial state are pure functions of the seed (§5), so world i is a matched pair. We want to know:

1. How much did the primary metric change, and how uncertain is that change?
2. Is the change larger than the margin δ that the team declared before comparing?
3. Is B meaningfully worse? This decides the release.

## Design

- **Paired.** A pair is used only if both versions started in the same recorded state (equal `worldHash`) and both runs were valid: not an infrastructure error, not an invalid world. Dropped pairs are listed. If more than `maxInvalidRate` (default 5%) of planned worlds were dropped on either side, the evaluation is invalid and no verdict is given.
- **Pre-declared.** The suite fixes the primary metric and its direction, the margin δ, the guardrails, α and the tolerances. All of these are part of the suite hash, so results under a different rule are never compared.
- **One primary metric.** Only the primary metric produces the verdict. Guardrails can block a release, never pass one. Everything else is reported as exploratory and labelled "not used to decide".

## Success (binary outcome)

The four cells of the 2×2 paired table:

| | | Count |
|---|---|---|
| **a** | both versions pass | |
| **b** | only A passes | |
| **c** | only B passes | |
| **d** | both fail | |

The estimate is Δ = p_B − p_A = (c − b)/n.

**Interval: Newcombe (1998), method 10 for paired data.** Newcombe RG, "Improved confidence intervals for the difference between binomial proportions based on paired data", *Statistics in Medicine* 17:2635–2650. The interval combines the Wilson score intervals (l₁, u₁) for p_B and (l₂, u₂) for p_A with a correlation term:

- φ = A / √((a+b)(c+d)(a+c)(b+d)), where A = ad − bc, replaced by max(0, ad − bc − n/2) when ad > bc (Newcombe's continuity adjustment), and φ = 0 when the denominator is 0.
- Lower = Δ − √((p_B − l₁)² − 2φ(p_B − l₁)(u₂ − p_A) + (u₂ − p_A)²)
- Upper = Δ + √((u₁ − p_B)² − 2φ(u₁ − p_B)(p_A − l₂) + (p_A − l₂)²)

This is the paired method, not method 10 of Newcombe's independent-samples paper.

The exact McNemar p-value (a two-sided binomial test of b against b + c) is reported alongside, but it does not decide anything.

**Measured coverage (AT4.1).** Nominal 95%. We ran 10,000 simulated comparisons at every feasible point of this grid:
- n ∈ {20, 50, 100}
- p_A ∈ {0.5, 0.8, 0.95}
- Δ ∈ {−0.1, 0, +0.1}
- within-pair correlation ρ ∈ {0, 0.5}

The worst coverage at any point was **94.5%**. The test requires at least 93% at every point.

## Other metrics (score, scorecard metrics)

The estimate is the mean paired difference d̄, signed so that positive is better.

**Interval: an expanded percentile bootstrap that resamples whole pairs.** Hesterberg T, "What teachers should know about the bootstrap", *The American Statistician* 69:371–386 (2015).
- B = 10,000 resamples. The seed is derived from the two evidence hashes, so a report recomputes identically. That makes the numbers repeatable, not valid; validity comes from the coverage below.
- The percentile levels are widened from α/2 to Φ(−√(n/(n−1)) · t₁₋α/₂,ₙ₋₁), which corrects the plain percentile interval's known under-coverage at small n.
- The median and interquartile range of the paired differences are reported too.

**Measured coverage (AT4.2).** 2,000 simulations at B = 1,000 per point:

| Distribution | n = 20 | n = 30 | n = 40 | n = 50 |
|---|---|---|---|---|
| Normal | 96.0% | — | — | 94.1% |
| Exponential (skewed) | 91.6–92.1% | 92.5% | 93.6% | 93.9% |
| Lognormal (heavy tail) | 88.2% | 89.6% | 89.8% | — |

**Consequences**
- A metric verdict needs at least **30 valid pairs**; below that it is always "inconclusive". The test requires at least 92% at n ∈ {30, 50} for normal and exponential differences.
- **Known limit:** for heavy-tailed metrics, the mean-difference interval under-covers (about 90% at n ≤ 40). Teams should prefer bounded metrics (success, counts with a cap, times with a time limit) as primary metrics and guardrails. Better heavy-tail methods (a studentized bootstrap, a trimmed or median effect) are open questions for the reviewer.

## Verdicts and the release gate

Write [L, U] for the interval of the primary metric's change (positive is better) and δ for its margin.

| Verdict | Rule |
|---|---|
| Meaningfully improved | L > +δ |
| Meaningfully regressed | U < −δ |
| No meaningful change | −δ < L and U < +δ |
| Inconclusive | otherwise |

When the interval excludes 0, the report also says that a change was detected, including one smaller than the margin.

**The release gate is a non-inferiority test.** It passes when all of these hold:
- L > −δ;
- every guardrail is non-inferior on its own margin;
- the evaluation is valid;
- any acceptance threshold is met.

So "inconclusive" about harm blocks a release, and "inconclusive" about benefit does not. The test cases are in AT4.3–AT4.5.

## Several suites, several metrics

- **Several suites gate one release** (`ossilic test --all`): each primary interval is computed at α/k, which keeps the family-wise error at most α (Bonferroni; AT4.6). Holm's procedure would be less conservative, but it works on p-values and the verdicts here are interval decisions.
- **Guardrails** only add ways to block, so they make false passes rarer, not more common.
- **Exploratory metrics** are never used to decide.

## Power

- **Success:** for the observed discordant rate p_d = (b + c)/n, the change resolvable with 80% power is about (z₁₋α/₂ + z₀.₈) · √(p_d / n), and the worlds needed to resolve δ are about (z₁₋α/₂ + z₀.₈)² p_d / δ².
- **Metrics:** the same formulas with the sample standard deviation of the paired differences in place of √p_d.

Both are approximations, labelled "about" in reports. For example, with 200 worlds and a discordant rate of 0.35, the report states a resolvable change of about 12 points.

## Reproduction

| Kind | Condition |
|---|---|
| Exact reproduction | Same brain, body and world hashes, the same `worldHash` per world, a deterministic driver or the same platform and kernel; every fingerprint and status equal |
| Equivalent reproduction | Same identity on another platform or kernel; every status equal and every metric within the suite's tolerance |
| Did not reproduce | Anything else for the same identity |

Replication on fresh cases is specified for step I5 and is not part of this release.

## Determinism (what pairing rests on)

- Sensor noise is counter-based: each value is a pure function of (seed, tick, sensor, element), through a fixed 32-bit integer hash. The engine (TypeScript) and the MuJoCo host (Python) implement the same function, and AT1.1 checks them value for value.
- Randomized worlds come from a seeded generator (`ossilic-randomize 1`). The realized initial state of every world is stored with it.
- Every computation that shapes a world or a score uses deterministic math (`dmath`: fdlibm ports built only from +, −, ×, ÷ and sqrt, which IEEE 754 fixes bit for bit). JavaScript's own Math.sin, Math.exp and the like are compiled C, and they differed in the last bit between ARM64 Macs and x64 Linux. That made 59 of 200 rover worlds fail to reproduce in CI before the change. Golden bit patterns and fingerprints recorded on one platform are checked on the other in CI (AT1.5, AT1.6).
- Kinematic simulation is therefore bit-exact across platforms. Physics (MuJoCo, a compiled C library) is bit-exact on the same platform and kernel version (AT1.2), and is compared by outcome elsewhere.

## What this does not establish

- Results hold under the conditions the suite names, not beyond them.
- A simulation result does not establish behaviour on hardware.
- Nothing here is safety certification.

## Questions for the reviewer

1. Is Newcombe method 10 (paired) the right default, or would Tango's score interval be preferable at small n or extreme rates?
2. Is the expanded percentile bootstrap acceptable for bounded metrics from n = 30, and what would you recommend for heavy-tailed metrics?
3. Is Bonferroni across suites acceptable, given that the gate works on intervals?
4. Is the non-inferiority framing of the release gate sound as stated?
