# ADR 0007: Adapt fits brains in simulation the user never has to run

**Status:** accepted · 2026-11-02

## Context
The platform's promise is that nobody trains from zero. The first version must work on a laptop, with no GPU and no ML framework, and still produce brains with measurable evidence.

## Decision
`@ossilic/adapt` is a four-step pipeline over the engine:
1. **Characterize** runs short probes on the target (full-speed drive, full-speed turn) and reads the body, producing a **Body Profile** (kind, degrees of freedom, measured top speed and turn rate, mass when the host reports it).
2. **Match** picks a **brain template** for the task and body kind. A template installs a brain graph when the manifest has none and exposes knobs: numeric skill parameters with declared ranges, or the weights of a small neural policy.
3. **Fit** maximizes a **task** score with a small evolution strategy. Every candidate is scored across several **randomized worlds** (obstacle jitter, start heading, sensor noise, friction and mass scales), so the result is robust rather than lucky. Fits are deterministic from their seed.
4. **Evaluate** reports a success rate over fresh randomized worlds before and after, plus per-metric means. A **Fit Report** carries the whole story.

A policy template does not start from random weights. When the manifest already has a hand-written brain for the task (or the parametric template can install one), Fit first runs that **teacher** on randomized worlds, records what it saw and did, and fits the network to it by gradient descent. Evolution then refines a brain that already knows the task. This is the platform's thesis in miniature: nobody trains from zero.

The learned brain is a `brain.policy` skill reading a `ossilic mlp` file: dense tanh layers in JSON, forwarded by thirty lines of arithmetic. It runs in Node, in Desktop and on an edge board without a runtime dependency. ONNX import can convert small networks into it; larger policies will need a dedicated runtime and arrive with the GPU training service.

The caller supplies how to create a machine, so the identical pipeline runs headless in the CLI, in Desktop against the bridge, and later on the Hub's workers.

## Consequences
- Parametric templates (gait, navigation gains) fit in a minute; the from-scratch navigation policy needs a few hundred episodes and the kinematic simulator's speed.
- Fall recovery and other behaviors that need real learning stay out of this version; they need the Python training service and larger policies, which the Fit contract already accommodates.
- Randomization lives in the drivers (`frictionScale`, `massScale` in the physics host), where the physics is.
