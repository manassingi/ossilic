# Ossilic

**Know what changed before you ship.** Ossilic is the release check for robot policies.

It runs two versions of a robot's brain through the same seeded worlds and accounts for every world. It compares them world by world against a margin you declared in advance, and blocks the release when the new version may be meaningfully worse. Every result is evidence that anyone can re-run.

```
### Ossilic Release Check · rover · navigate — ✅ Not meaningfully worse: safe to ship

Verdict: Meaningfully improved. Success +35 points (95% interval +28.3 to +41.9 points)
across 200 paired worlds, against a margin of ±10 points.

What changed: goto.cruise 0.6 → 0.945 · avoid.stopDist 0.55 → 0.8551 · …
Which worlds changed: 129/200 → 199/200 · newly failing: none
```

## Try it

Ossilic needs Node 24. The engine has no dependencies.

```bash
git clone https://github.com/manassingi/ossilic && cd ossilic && npm install
npm run ossilic -- test examples/rover/machine.json
```

That re-runs the reference rover through its 200 committed test worlds, and every fingerprint should match: an exact reproduction. To put `ossilic` on your PATH, run `npm link -w @ossilic/cli`.

Test your own machine:

```bash
ossilic suite robots/my-robot/machine.json --task navigate --margin 0.1   # define the test and its decision rule
ossilic test robots/my-robot/machine.json --update                        # record the baseline
# change the brain, then
ossilic test robots/my-robot/machine.json                                 # the release check
```

## On every pull request

```yaml
# .github/workflows/ossilic.yml
name: Ossilic
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  release-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: manassingi/ossilic@main
        with:
          machine: robots/my-robot/machine.json
          # physics: "true"   for MuJoCo targets
```

Each pull request gets a comment, updated on every push:
- the decision;
- the effect and its interval against your margin;
- guardrails and trust facts;
- what changed and which worlds flipped;
- the command to reproduce it.

A version that may be meaningfully worse fails the check. The Action never moves a baseline.

## Why the verdict can be trusted

- **The same seed is the same world.** Sensor noise is a pure function of (seed, tick, sensor, element). Each world records the state it started in, and worlds pair only when those states match.
- **Exactly what was tested.** There are separate hashes for the brain (including its policy weights), the body (including its model file), the world and the suite.
- **Every world accounted for.** Each world has one of seven statuses. Infrastructure failures are counted and shown, but never counted against the policy; too many of them make the evaluation invalid.
- **A decision rule declared up front.** One primary metric, a margin and guardrails. The release gate is a non-inferiority test.
- **Statistics with measured coverage.** Newcombe's interval for paired proportions, and an expanded bootstrap that resamples whole pairs. See [docs/STATISTICS.md](docs/STATISTICS.md); the acceptance tests are in [docs/I1-SPEC.md](docs/I1-SPEC.md).
- **Governed baselines.** Each baseline records who approved it and the baseline it replaced. Accepting a worse version needs a recorded reason.

## What is in this repository

| Package | Purpose |
|---|---|
| `@ossilic/evidence` | Suites, evidence, paired statistics, verdicts, the release gate, reports |
| `@ossilic/cli` | `ossilic suite · test · compare · reproduce`, plus `run · verify · fit · adapt · publish` |
| `@ossilic/spec` | The machine file, Run Records, evidence schema and validation |
| `@ossilic/runtime` | The typed skill-graph engine and the driver interface |
| `@ossilic/skills` | Standard skills: navigation, gait, control, learned policies |
| `@ossilic/sim` | A deterministic 2D simulator |
| `@ossilic/mujoco` | MuJoCo physics through an out-of-process host (`pip install mujoco`) |
| `@ossilic/ros2` | Real robots through rosbridge |
| `@ossilic/adapt` | Tune a brain template to a body; judged by the release check |
| `@ossilic/preview` | SVG renderers for brains and trajectories |
| `action.yml` | The GitHub Action |
| `examples/` | Reference machines with committed suites and baselines |

## Status

Alpha.
- The statistical methods are documented for an independent review that has not happened yet.
- Evidence is a software evaluation under the conditions a suite names. A simulation result does not establish behaviour on hardware, and nothing here is safety certification.

## The Ossilic platform

The Ossilic Hub (history across versions, independent reproductions, team workspaces) and Ossilic Desktop are built on this open core.

## License

Apache-2.0. Copyright 2026 Manas Singi. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
