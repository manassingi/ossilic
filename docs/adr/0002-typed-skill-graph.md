# ADR 0002: The brain is a typed dataflow graph with a fixed tick

**Status:** accepted · 2026-11-01

## Context
Behavior could be expressed as scripts, behavior trees, state machines or dataflow graphs. We need something a visual editor can show, a compiler can check, and a runtime can execute deterministically at a fixed rate on an edge device.

## Decision
The brain is a directed acyclic graph of **skills**. Ports carry a small set of physical types (`number`, `bool`, `vec2`, `pose`, `twist`, `scan`, `any`). The compiler checks skill existence, port names, type compatibility, required inputs and cycles, and reports every error at once. Execution is one topological pass per tick at `tickHz`, followed by `driver.step(dt)`.

## Consequences
- Determinism: same driver state in, same outputs out. Enables replay, regression tests and sim-to-real comparison.
- Feedback loops require an explicit delay skill (planned), which makes latency visible instead of accidental.
- Behavior trees and state machines become skills that emit twists/booleans, not a second runtime.
