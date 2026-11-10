# ADR 0023: smaltts, a thin typed language for smaltdb

- **Status:** accepted (2026-11-10; owner's decisions below)
- **Date:** 2026-11-09
- **Builds on:** smaltdb [ADR 0015](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0015-smaltql.md) (the
  engine carries no language), [ADR 0016](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0016-plan-api-for-every-language.md)
  (the plan API for every language), ADRs [0018](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0018-bool-and-nan.md),
  [0019](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0019-dates-and-times.md) and
  [0020](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0020-lists-and-structs.md) (the engine's types);
  smalt-brand [DECISIONS.md, "smaltts"](https://github.com/stenhoor/smalt-brand/blob/main/DECISIONS.md#smaltts).
- **Details:** [DESIGN.md](../DESIGN.md) (the design), [REFERENCE.md](../REFERENCE.md) (the API specification),
  [MILESTONES.md](../MILESTONES.md) (the order of work), [research](../research/README.md) (the surveys behind it).

## Context

- **The engine has no language** (smaltdb ADR 0015). SQL is smaltql's, dataframes are smaltdf's. An application or a
  layer that wants neither works with the raw plan API: columns by position, no TypeScript types, schema operations as
  hand-built definitions, and nothing between a desired schema and the operations that reach it.
- **The owner placed smaltts at the language layer**, beside smaltql and smaltdf, as "a thin, typed TypeScript API
  over smaltdb's plan and schema operations, with structured flows, for applications and layers that want neither SQL
  nor dataframes" (smalt-brand DECISIONS.md, BRAND.md). Its tagline is "Small. Alternative. Typed.".
- **Its first users build toolchains and pipelines** (smaltfl among them): they create, reshape, index, fill and check
  databases, with schemas declared in code and schemas discovered at run time. The owner's direction: DDL first; when
  DDL and DML ergonomics conflict, DDL wins.
- **The plan API is complete enough to build on.** smaltdb 0.9.0 has the catalog API, typed results, structured errors
  with an `origin`, guaranteed order, definitions without source text, views read by name, the new operations, and the
  types `bool`, `date`, `datetime`, `time`, `duration`, `list` and `struct` (ADRs 0016–0020).
- **The research** ([docs/research](../research/README.md)) found one shape across databases and TypeScript tools: one
  object model for declaring and introspecting, desired state diffed into a reviewable plan, every change classified by
  cost and data loss, renames as intent, a lazy relational builder that explains itself, and history in the database.
  No maintained TypeScript plan builder exists.

## Decision

### 1. A language that is thin

smaltts adds **no meaning of its own**. Every operation and expression is one of the engine's, named as the engine
names it (`cmp_eq`, `div_float`, `to_zone`). What smaltts adds:

- names instead of positions, resolved when a plan is compiled, with errors naming the smaltts call (`origin`);
- TypeScript types on every column and expression, from the specs or the catalog;
- schemas as values, change sets, interfaces and flows (below).

This is what separates it from smaltdf, which specifies its own semantics, and from smaltql, which keeps SQLite's. All
three build plans for the same engine and read each other's tables, and each other's views when the views declare
their columns.

### 2. Schemas are values

A **spec** is a table's desired state as JSON-safe data. A spec declared in code (`table('orders', { id: int()… })`)
carries a row type; a spec built at run time (from data, a file, another database) is the same object with untyped
rows. The catalog reads a database back as specs, so what a database has and what a tool wants are the same kind of
value. smaltts has exactly the engine's types and adds none ([DESIGN.md 5.1](../DESIGN.md#_5-1-the-engine-s-types)).

### 3. Changes are reviewed before they run

`diff(current, desired)` gives a **change set**: ordered steps, each with the engine statements it runs, its impact
(`metadata`, `instant`, `build`, `rewrite`) and its data loss (`none`, `possible`, `certain`). Nothing runs until
`apply`, which checks a policy, runs every step in one transaction and records the change set with its checksum.

- **Renames are declared** (`renamedFrom`), never inferred or prompted for.
- **Data loss is decided by types, never by data**: a type change is lossless only if it is exact for every value of
  the new type; the rows a database holds today never change the verdict, and no read ever fails on a row
  ([DESIGN.md 8.3](../DESIGN.md#_8-3-type-changes-decided-by-types-never-by-data)).
- **What the engine cannot change in place is a rebuild** built from plans: new table, rows copied by an `append`
  plan, old table dropped, new one renamed. A blocking rebuild is acceptable for v1.

### 4. Typed plans

A **relation** is the engine's plan with names: one builder per plan operation, in the order written, nothing composed
behind the user's back. The full set of plan operations is in scope (windows, set operations, subqueries, recursion,
pivot, asof joins, explode, merge loads). Expressions call the engine's operations, typed from the catalog's
function metadata.

### 5. Views: reflecting or interface

A smaltts view stores its relation's JSON and is bound by name where it is read; smaltts registers as a language only
for the views it stores. A view is **reflecting** by default: it follows the tables it reads. A **column list** makes
it an **interface**: its names, order and types are a contract. The column list is standard SQL that smaltql already
parses, so the two languages declare interfaces the same way. Interfaces that hold whichever language issues the DDL
need the engine to enforce them (smaltdb proposal E10).

### 6. Structured flows

A **flow** is a reviewable list of steps (`migrate`, `apply`, `load`, `refresh`, `check`, `analyze`, plugin calls) as
data. It previews every step's change set and plans before anything runs, and runs in one transaction or step by step,
resuming after the last committed step. Schedules, dependencies between flows, retries and lineage are smaltfl's.

### 7. Rules

- **No SQL**, anywhere: plans, schema operations, transactions and plugin calls only.
- **Build data, then run it:** every builder returns JSON-safe data; running is a separate, asynchronous call.
- **No runtime dependencies;** smaltdb is a peer dependency, and builders import only `smaltdb/plan`.
- **The API reference is the specification:** an API change changes it in the same PR, and its examples are
  stripped with smaltty and run against the engine.
- **TypeScript tooling is smaltty's:** no `typescript` dependency; smaltts uses smaltty and extends its checker.
- **What the engine lacks is proposed to smaltdb,** never emulated in smaltts.

## Owner's decisions

Taken in the design interview of 2026-11-06 and in later sessions:

1. **smaltfl is built on smaltts**; smaltts stays free of orchestration (2026-11-06).
2. **Schemas from code and from run time** are equally first-class (2026-11-06).
3. **Engine changes may be proposed** where the design needs them (2026-11-06).
4. **Blocking rebuilds are acceptable for v1** (2026-11-06).
5. **Views are reflecting by default; a column list declares an interface**, in every language (2026-11-06).
6. **Type changes are decided by types, never by data** (2026-11-06).
7. **Interfaces are enforced by the engine,** so DDL from another language cannot break them (2026-11-06).
8. **The relational scope** includes windows, set operations and subqueries, recursion, and merge and incremental
   loads (2026-11-06).
9. **Types come from the engine,** with no interim encodings in smaltts (2026-11-06); smaltdb ADR 0019 (2026-11-07)
   then set their model, which smaltts follows.
10. **smaltts is thin** (smalt-brand, 2026-11-08).
11. **VitePress** for the docs site, a dev dependency (2026-11-08).
12. **Merges go through pull requests** (2026-11-08).
13. **One numbering for all smalt ADRs:** this record is 0023, after smaltdb's 0022 (2026-11-09).
14. **Accepted** (2026-11-10).
15. **Expression names:** every engine operation as `fn.<engine name>`, plus short aliases only where an operation has
    one meaning (`.eq` is `cmp_eq`, `.and` the logic node); no meanings of smaltts's own (2026-11-10).
16. **Dependencies:** smaltts uses and extends smaltty for its TypeScript tooling and has no `typescript`
    dependency; other smaltworks packages are allowed; Node's types and vitest for development and tests only, never
    in deployed code (2026-11-10).
17. **smaltty's checker covers smaltts:** smaltty's checker work starts now with smaltts in its scope as well as
    smaltdf (2026-11-10).

## Open points for the owner

1. **Migrations on disk:** live diff only, live diff plus saved change-set files, or saved files only (gate A of the
   milestones).
2. **Plugins:** typed descriptors shipped by plugins, and connections and external tables as specs, or the generic
   `plugin(name).call()` only.
3. **Engine proposals:** which to open as smaltdb issues, and in what order. The ones smaltts needs: the catalog's
   foreign keys, CHECKs and defaults (E1, S), structured EXPLAIN with costs (E2, M), view interfaces (E10, L); later,
   change capture (E8), an adapting materialized-view refresh (E9), more in-place ALTERs (E4) and engine-side impact
   (E5).
4. **Interfaces before E10:** ship names and order only, or wait for E10 (gate B).
5. **Flows and smaltfl:** what a flow holds and what smaltfl adds (gate C).

## Alternatives considered

- **A query builder over SQL text** (as Kysely and Drizzle are over SQL). Rejected: the engine has no SQL; it would be
  smaltql under another name.
- **smaltts on top of smaltdf's frames.** Rejected: smaltts is for applications that want neither SQL nor dataframes,
  and it would inherit smaltdf's semantics.
- **smaltts semantics of its own** (its own division, equality, conversions). Rejected: a third set of meanings to
  specify and keep consistent; the engine owns every operation (smaltdb ADR 0015 §7).
- **An ORM** (entities, relations, lazy loading). Rejected: it hides the plan, and DDL comes first.
- **Stored bound plans for views.** Rejected, as in smaltdb ADR 0015: they go stale when tables change.
- **Interim types in smaltts** (a boolean as an INTEGER with a CHECK). Rejected: invisible to the engine and to other
  languages, and a migration later.
- **Classifying changes by the data a database holds.** Rejected: the same change set would get different verdicts in
  different databases, and reads would have to validate rows.
- **Inferring renames** (as drizzle-kit's prompts). Rejected: unreviewable and unusable in CI.

## Consequences

- **smaltdb gains a third language** that uses only its public plan, schema, catalog and language APIs, which tests
  those APIs from a side neither smaltql nor smaltdf covers: schema definitions and changes.
- **Schema management moves out of applications:** a tool states the schema it wants and gets a reviewable change set.
- **The engine is asked for more:** E1's remainder, E2 and E10 are on smaltts's path; E10 is the largest.
- **The prototype must be re-based** on smaltdb 0.9.0 (milestone 1): it predates the behaviour names and the language
  interface's changes.
- **Static checks wait for smaltty's checker:** until it covers smaltts, the tests run the code and the reference's
  examples, but nothing checks types; smaltty gains a second API to check, which tests its design beyond smaltdf.
- **smaltts's status stays "Planned"** until its first milestones land; the change comes with a smalt-brand PR.

## Order of work

[MILESTONES.md](../MILESTONES.md): twelve milestones with their sizes and three owner gates, from the owner's yes on
outside code (milestone 0) and the re-base on smaltdb 0.9.0 (milestone 1) to the docs site and the publish with
smaltdb (milestone 11).
