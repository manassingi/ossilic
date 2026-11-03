# Contributing to Ossilic

Thank you for helping. A few rules keep the evidence trustworthy.

## Run the tests

```bash
npm install
npm test                                  # engine, evidence and the statistics coverage tests
python3 -m pip install mujoco             # optional: enables the physics tests
```

## Rules

- **Every claim needs a test.** If a doc, report or error message says something is true, a test shows it.
- **Statistics changes need coverage evidence.** Any change to an interval or a verdict rule comes with a simulation that measures its coverage, as in `packages/evidence/test/evidence.test.ts`. Do not weaken a threshold to make a test pass.
- **Determinism is not optional.** Anything that affects a world must be a pure function of the seed. If a change alters fingerprints, say so in the pull request: committed baselines will need re-recording.
- **Small and clear.** If fifty lines do it, two hundred are a bug. No speculative abstractions.
- **The release check runs on your pull request**, against the example machines. A change that makes them meaningfully worse fails.

By contributing, you agree that your contributions are licensed under Apache-2.0.
