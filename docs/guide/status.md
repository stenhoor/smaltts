# Status

smaltts is **in early development**: not on npm yet, and its API may change. This page says what is in, as of
2026-11-23.
The plan is in [DESIGN.md](../DESIGN) and [MILESTONES.md](../MILESTONES); the engine's side is on the
[smaltdb roadmap](https://smaltdb.dev/ROADMAP).

## Designed

The whole API, specified in the [API reference](../REFERENCE): specs and types, the catalog, change sets, typed
plans, views, loads, flows, plan review, plugins and transactions. Each entry there says whether it is in the
prototype or planned, and for which milestone.

## In the prototype

Against smaltdb 0.9.0 (`b82ad6f`, pinned in `packed.json`): specs declared and inferred, the catalog read back as specs, diffs with renames
and rebuilds, policies and history, loads in four modes, typed plans with joins and aggregates over the engine's
operations by their engine names, plain and materialized views, explain with measurements, and errors that name the
smaltts call they came from.

## Building and installing

TypeScript 7 type-checks `src/` and `test/`, and TypeScript 6.0.3 builds `dist/` and its declarations (the family's
standard, smaltworks DECISIONS.md, "smaltts follows the family's TypeScript standard"). Another repository installs
smaltts from a commit through its `packed.json`, as smaltai's store does.

## Next

The milestones still open wait on others ([MILESTONES.md](../MILESTONES)): flows (milestone 7) on the owner's Gate C,
plan review (milestone 8) on the engine's E2 ([stenhoor/smaltdb#187](https://github.com/stenhoor/smaltdb/issues/187)),
and publishing (milestone 11) on smaltdb's 0.9.0 release. Typing the comparison methods by their arguments'
nullability waits on smaltty checking overloads ([stenhoor/smaltty#48](https://github.com/stenhoor/smaltty/issues/48)).
