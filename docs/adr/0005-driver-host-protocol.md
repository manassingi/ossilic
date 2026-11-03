# ADR 0005: Physics and hardware bind through a Driver Host Protocol

**Status:** accepted · 2026-11-02

## Context
The engine is TypeScript so it runs in Ossilic Desktop, in Node and in CI unchanged. MuJoCo, ROS 2 and vendor SDKs are C, C++ and Python. Binding them in-process would tie the engine to native builds per platform and per library.

## Decision
A driver may run out of process as a **host** that speaks a line protocol: one JSON request per line on stdin, one JSON reply per line on stdout. `init` carries the manifest, the target config and the manifest directory; `step` carries `dt` and the buffered actuator commands and returns sensors, a snapshot and, on request, body poses for rendering. The engine's `Driver.step` is async to allow this. The transport is pluggable: a child process in Node, the Rust core in Ossilic Desktop, a socket for remote hosts later.

The first host is `ossilic_mujoco.py`, MuJoCo embedded as Ossilic's physics kernel.

## Consequences
- Anyone can write a driver in any language by implementing two messages. Hardware vendors do not need to touch the engine.
- One request is in flight at a time, so the brain's tick stays deterministic and ordered.
- A hot loop at 50 Hz with 25 physics substeps costs well under a millisecond of transport per tick; hard real-time control (>1 kHz) belongs inside the host, as ADR 0004 already states.
- The Desktop app can replace the Python host with a native binding later without changing a manifest or a brain.
