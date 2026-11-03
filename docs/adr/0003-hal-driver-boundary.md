# ADR 0003: Sim and hardware are interchangeable Drivers

**Status:** accepted · 2026-11-01

## Context
The platform's promise is "prove it in simulation, ship it to hardware without rewriting the brain." That only holds if the brain never talks to hardware directly.

## Decision
A `Driver` binds a manifest's body to a world: `init(manifest)`, `readSensor(id)`, `writeActuator(id, cmd)`, `step(dt)`, `snapshot()`. Skills only see the driver through `TickContext`. Deploy targets name a driver (`sim2d`, `ros2`, `mujoco`, a vendor board). Physical limits (motor saturation, sensor noise) live in the driver so the brain feels them in sim.

## Consequences
- Hardware vendors integrate by shipping a driver package, which is the seed of the hardware side of the marketplace.
- Higher-fidelity simulators are drivers too, so a machine can be promoted sim2d → physics → hardware with no brain changes.
