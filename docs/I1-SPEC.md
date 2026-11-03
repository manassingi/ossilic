# I1 Evidence correctness: engineering specification

*2026-11-03. The gate for I1: every acceptance test (AT) below passes in `npm test`, and an outside statistician reviews [STATISTICS.md](STATISTICS.md), which this step writes. Nothing in this step imports other tools' results, builds the Hub marketplace or touches Adapt.*

Each requirement (R) has the acceptance tests that prove it. A requirement is done only when its tests pass.

## 1. Pairing: the same seed must mean the same world

**R1.1 Sensor noise depends on where it is, not on how often it is read.** In sim2d and in the MuJoCo host, every noise value is a pure function of (episode seed, tick, sensor id, element index), computed with a fixed integer hash. There is no running random stream.
- **AT1.1** A brain with one lidar read per tick and the same brain with two reads per tick receive identical lidar values at every tick, in sim2d and in MuJoCo.
- **AT1.2** The same brain on the same suite produces identical fingerprints on two runs, in sim2d and in MuJoCo on one platform.

**R1.2 Each episode records the world it actually started in.** The realized world (the randomized target configuration, including the start pose, obstacles, friction, mass and noise level) is stored with the episode, together with its hash `worldHash`.
- **AT1.3** Two episodes pair only if their `worldHash` values match. A mismatch makes the comparison "not comparable", naming the seeds.
- **AT1.4** Changing the randomization code changes `worldHash`, so old and new evidence never pair silently.

## 2. Identity: what exactly was tested

**R2.1 Four separate hashes replace the single manifest hash as the identity of what was tested.**
- `brain`: the brain section plus the SHA-256 of every file a node loads.
- `body`: the body section plus the SHA-256 of the model file.
- `world`: the starting target configuration.
- `suite`: as today, extended by R4.1.

The manifest hash stays as `manifest` for backward compatibility.
- **AT2.1** Changing only a policy's weights changes `brain`, leaves `body` alone, and the comparison is a change, not a reproduction.
- **AT2.2** Changing a wheel radius changes `body`, and the report states that the body changed.
- **AT2.3** Evidence whose `brain` and `body` match the published version is current. Anything else is stale, even when the manifest hash matches (it would only match after a weights edit).

## 3. Accounting: nothing is dropped, nothing is mislabelled

**R3.1 Every planned world gets exactly one status.**

| Status | Meaning | Counts as a policy failure |
|---|---|---|
| success | The task's success test passed | no |
| failure | The episode ran to its end and the success test failed | yes |
| timeout | The task's time limit ended it without success | yes (the task defines its limit) |
| safety_stop | A declared safety rule ended it | yes |
| policy_error | A skill (the brain) threw | yes |
| infra_error | A driver, physics host or the evaluator threw or lost its connection | no |
| invalid | The world's preconditions were not met (e.g. the start pose collides) | no |

**R3.2 Errors are classified by where they come from.** The runtime wraps driver calls, so a driver exception reaches the evaluator tagged as infrastructure. A skill exception is tagged as policy.

**R3.3 Accounting is complete.** Evidence records planned, completed and per-status counts. There is no way to exclude a world.

**R3.4 The analysis uses valid pairs only.** A pair is valid when neither side is `infra_error` or `invalid`. Dropped pairs are listed with their reasons. If more than `suite.maxInvalidRate` of the planned worlds (default 0.05) are dropped on either side, the result is "invalid evaluation" and the gate fails.
- **AT3.1** A driver that throws on world 3 yields `infra_error` for that world; the suite finishes; the report lists it; the pair is dropped.
- **AT3.2** A skill that throws yields `policy_error`, counted as a failure.
- **AT3.3** Infrastructure errors in more than 5% of worlds yield "invalid evaluation", and CI blocks.
- **AT3.4** The sum of all status counts equals the planned count, in every evidence file.

## 4. Statistics

**R4.1 A suite declares its decision rule before any comparison.**
- `primary`: `success` or one scorecard metric, with `direction` (`higher` or `lower` is better).
- `margin`: the smallest change that matters, in the primary metric's units. Required. Default suites set 0.10 for success.
- `guardrails`: metrics with their own direction and margin. Any one of them can block a release.
- `alpha`: default 0.05, which gives two-sided 95% intervals.
- `maxInvalidRate`: default 0.05.
- `tolerance`: per metric, used for equivalent reproduction.

Changing any of these changes the suite hash, and therefore comparability.

**R4.2 Success difference.** Δ = p(candidate) − p(baseline) over valid pairs. The interval is Newcombe's method 10 for paired data (Newcombe 1998, *Statistics in Medicine* 17:2635), built from the Wilson intervals of the two marginal rates and the continuity-adjusted φ correlation. It is **not** the method 10 for independent samples. The exact McNemar p-value is reported alongside it.

**R4.3 Metric difference.** The effect is the mean of the paired differences. Its interval is an expanded percentile bootstrap (Hesterberg 2015) that resamples whole pairs: B = 10,000 resamples, with the bootstrap seed derived from the two evidence hashes so the report itself is repeatable. Below 30 valid pairs, a metric verdict is always inconclusive. The report also shows the median and interquartile range of the paired differences.

*Changed during I1:* the plain percentile bootstrap under-covered (90.1% at 20 skewed pairs), and the expanded version still fell short below 30 pairs. The minimum went from 10 to 30 pairs instead of weakening the test. The heavy-tail limit is documented in STATISTICS.md.

**R4.4 The verdict on the primary metric.** Write L and U for the interval's ends and δ for the margin, signed so that positive means better.

| Verdict | Rule |
|---|---|
| Meaningfully improved | L > +δ |
| Meaningfully regressed | U < −δ |
| No meaningful change | −δ < L and U < +δ |
| Inconclusive | otherwise |

Separately, when the interval excludes zero, the report says that a change smaller than or larger than the margin was detected.

**R4.5 The release gate, separate from the verdict.** It passes when all of these hold:
- the primary metric is non-inferior (L > −δ);
- every guardrail is non-inferior;
- the evaluation is valid;
- the version is not irreproducible against an earlier record of itself;
- any acceptance threshold is met.

Inconclusive about harm blocks the release; inconclusive about benefit does not.

**R4.6 Power.** The report gives the margin this suite can resolve at 80% power, using the observed discordant rate for success and the observed paired standard deviation for metrics. It also gives the number of worlds needed to resolve the declared margin.

**R4.7 Multiplicity.** One primary metric decides the verdict, and guardrails only protect (they can block, never pass). Other metrics are labelled exploratory. When one release is gated on several suites (`ossilic test --all`), each primary interval is computed at α/k (Bonferroni).

*Changed during I1:* Holm's procedure works on p-values, but the verdicts are interval decisions, so Bonferroni intervals are the consistent choice.

**Acceptance tests**
- **AT4.1** The paired success interval covers the true difference in at least 93% of 10,000 simulated comparisons, at every point of a grid: n ∈ {20, 50, 100}; baseline rate ∈ {0.5, 0.8, 0.95}; true Δ ∈ {−0.1, 0, +0.1}; within-pair correlation ∈ {0, 0.5}. The simulation runs in CI with a fixed seed.
- **AT4.2** The paired bootstrap interval covers the true mean difference in at least 92% of simulations at n ∈ {30, 50}, for normal and for exponential (skewed) differences.
- **AT4.3** The boundary cases decide as specified. For example, +1.5 points with interval [+0.8, +2.2] and a margin of 5 gives "no meaningful change", with the note that a change smaller than the margin was detected.
- **AT4.4** A primary-metric gain with a guardrail regression beyond its margin fails the gate.
- **AT4.5** Interval [−3, +8] with margin 5 is inconclusive and passes the gate. Interval [−7, +2] is inconclusive and fails the gate.
- **AT4.6** Gating on three suites widens each interval to the α/3 level.

## 5. Reproduction kinds

**R5.1 Exact reproduction.** Same `brain`, `body` and `world` hashes, the same `worldHash` per episode, and either a deterministic driver or the same platform and physics-kernel version. Every fingerprint must be equal.

**R5.2 Equivalent reproduction.** Same identity and worlds on a different platform or kernel version. Every episode status must be equal, and every metric must be within the suite's tolerance.

**R5.3 Case provenance.** Evidence states where its cases came from: `seeded-public`, with the generator name and version. Private, Hub-assigned and customer-owned cases come later and use the same field.

**R5.4 Replication on fresh cases** is defined in the schema but built in I5.
- **AT5.1** An identical rerun is "exact reproduction".
- **AT5.2** A rerun on another platform with equal statuses and metrics within tolerance is "equivalent reproduction". With one status flipped, it is "did not reproduce".
- **AT5.3** Evidence with no case provenance fails validation.

## 6. Provenance and execution mode

**R6.1** `executedBy` records the mode (`local` or `ci`). For CI it adds the provider, repository, commit, workflow and run URL, read from the CI environment variables.

**R6.2** `environment` records the engine, evaluator, task-scoring, driver and driver versions, the physics kernel and its version (the MuJoCo host reports `mujoco.__version__` at init), the Node version and the platform.

**R6.3** The Hub computes trust facts and never accepts them from the submitter. Each is shown separately:
- artifact integrity (the digests match);
- workflow provenance (an attestation is present; verification comes in I2);
- execution mode;
- completeness (planned versus valid worlds);
- reproductions (count, by distinct accounts other than the owner);
- physical authenticity: "simulation", or "hardware, as attested by the author".
- **AT6.1** In a GitHub Actions environment, the CI fields are filled in. Locally, the mode is `local`.
- **AT6.2** A submitter cannot set any trust fact: fields sent by the submitter are ignored and recomputed.
- **AT6.3** A local result is never labelled "independently reproduced", whatever it contains.

## 7. Baseline governance

**R7.1** A baseline file carries its approval: who approved it, when, why, and the hash of the baseline it replaced.

**R7.2** `ossilic test --update` refuses when the release gate fails, unless `--accept-regression "<reason>"` is given. The reason is then recorded.

**R7.3** The GitHub Action never writes a baseline.
- **AT7.1** `--update` on a regression without the flag exits non-zero, and the baseline file is unchanged.
- **AT7.2** With the flag, the baseline records the reason and the previous baseline's hash.
- **AT7.3** The Action's steps contain no `--update`.

## 8. The two diffs

**R8.1 Artifact diff.** The report lists changed parameters (node and key, old and new value), added and removed nodes and wires, changed body fields, and changed files by hash and size. Policy files are reported by hash only.

**R8.2 Behaviour diff.** The report lists the worlds that flipped status, the metric changes with their intervals, and the status counts on both sides.
- **AT8.1** After a fitted parameter change, the artifact diff lists exactly the changed parameters.
- **AT8.2** A weights-only change is listed as "policy file changed", with no claim about what changed inside it.

## 9. Report, version 2

The report runs in this order:
1. The gate result.
2. The verdict, with the effect, its interval and the margin.
3. Guardrails.
4. Trust facts.
5. What changed (the artifact diff).
6. Which worlds changed (the behaviour diff).
7. Accounting.
8. Power.
9. How to reproduce it.

- **AT9.1** A snapshot test fixes the report's structure for one regression, one improvement, one inconclusive result and one invalid evaluation.

## 10. Compatibility and migration

- Evidence gets `schema: 2`. Version-1 evidence still loads, is labelled "legacy", and never pairs with version 2: it has no initial states, so it is not comparable.
- The three example machines are re-baselined under version 2.
- The Hub stores both versions and shows legacy evidence with that label.

## 11. Deliverables

- Code changes in spec, sim, the MuJoCo host, runtime, evidence, the CLI, the Hub and the Action.
- Every AT above in `npm test`, including the coverage simulations.
- `docs/STATISTICS.md`: the methods, formulas, references and coverage results, written for an outside reviewer.
- Docs updated so they claim nothing the code does not do.
