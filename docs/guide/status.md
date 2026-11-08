# Status

smaltts is **planned**: designed, with a prototype, and not published. This page says what is in, as of 2026-11-08.
The plan is in [DESIGN.md](../DESIGN) and [MILESTONES.md](../MILESTONES); the engine's side is on the
[smaltdb roadmap](https://smaltdb.dev/ROADMAP).

## Designed

The whole API, specified in the [API reference](../REFERENCE): specs and types, the catalog, change sets, typed
plans, views, loads, flows, plan review, plugins and transactions. Each entry there says whether it is in the
prototype or planned, and for which milestone.

## In the prototype

Against smaltdb `0b36f33`, the engine before its 0.9.0 plan API: specs declared and inferred, the catalog read back
as specs, diffs with renames and rebuilds, policies and history, loads in four modes, typed plans with joins and
aggregates, plain and materialized views, explain with measurements.

## Next

[Milestone 1](../MILESTONES#_1-re-base-on-smaltdb-0-9-0): re-base the prototype on smaltdb 0.9.0. Then the engine's
types in specs, a complete differ, and typed plans for the whole plan format.
