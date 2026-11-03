# ADR 0001: A declarative Machine Manifest is the unit of a product

**Status:** accepted · 2026-11-01

## Context
Robotics stacks today (ROS 2, vendor SDKs) are code-first. A machine is a pile of nodes, launch files and glue. That is fine for specialists and hostile to everyone else. Unity's lasting insight was that a *scene* is data: inspectable, shareable, editable in a visual tool, and portable across targets.

## Decision
A machine is a single manifest (`ossilic: "1"`) with three parts: **body** (base, sensors, actuators), **brain** (a typed skill graph) and **deploy** (named targets, each bound to a driver). The manifest is JSON today; YAML and a visual editor are views over the same model.

## Consequences
- The Studio can be built as an editor of the manifest rather than a code generator.
- Marketplace listings (skills, bodies, drivers) attach to manifest concepts.
- Escape hatch: a skill may wrap arbitrary code (Python, C++, an LLM call). The manifest stays declarative; the skill is where code lives.
