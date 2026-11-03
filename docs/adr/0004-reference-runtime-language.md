# ADR 0004: TypeScript reference runtime, Python SDK for the ML surface

**Status:** accepted · 2026-11-01

## Context
The runtime must run in the browser (Studio live preview), on Linux edge boxes, and eventually compile down to microcontrollers. ML practitioners live in Python. Robotics performance code lives in C++.

## Decision
The reference engine (spec, graph compiler, tick loop) is TypeScript with zero dependencies, so the same code runs in Studio and on Node/WASM edge targets. Skills may be implemented in Python (via a subprocess/gRPC skill host, planned) or C++ (via WASM or native driver). A Python SDK mirrors the `SkillSpec` contract for training and inference skills.

## Consequences
- Zero build tooling today: Node 24 runs `.ts` natively.
- Hard real-time control loops (>1 kHz) will not run in the TS engine; they belong in drivers or compiled skills, with the TS brain supervising at 10–200 Hz.
