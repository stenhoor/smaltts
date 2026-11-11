# Milestones

The plan in [DESIGN.md](DESIGN.md), as milestones. Each ends with something measurable. Gates are owner decisions:
nothing after a gate starts until the owner says so.

**Sizes are relative,** for one session working through them:

| Size | Roughly |
|---|---|
| S | 1–2 PRs |
| M | 3–5 PRs |
| L | 6–10 PRs, or work in another repository first |

smaltdb changes are separate PRs in smaltdb, each with its own size, listed under the milestone that needs them. A
milestone that needs one starts with the parts that don't.

## 0. Owner's yes on outside code

Size: S. Status: done, 2026-11-10.

- The owner's decision: smaltts uses and extends smaltty for its TypeScript tooling, with no `typescript` dependency;
  other smaltworks packages are allowed; Node's types and vitest are allowed for development and tests, never in
  deployed code.
- `typescript` is removed and the `tsc` typecheck with it. The reference's examples are stripped with smaltty and run.
  Static checks (compile-time tests, the examples' types) return with smaltty's checker: see "Alongside" below.

## Alongside: smaltty's checker covers smaltts

Size: L, in smaltty (its milestone 7, the checker trial), with the owner's decision of 2026-11-10 to start it with
smaltts in its scope as well as smaltdf. Status: done for smaltts, 2026-11-11: `npm run check` runs smaltty's checker
(`test/checker.test.ts`, smaltty pinned at `40db25b`) over `test/` and the reference's examples with no errors, and all
3 compile-time tests are found; smaltty's own tests compare the checker with tsc (no false errors on smaltts's code and
on 1,076 mutants of its examples). It reads smaltts's source for its types, as there is no `.d.ts` without tsc.

- smaltty's checker reads smaltts's `.d.ts` as it reads smaltdf's, and checks calls into smaltts: unknown methods
  and properties, argument types and counts, column names and types in row callbacks (which need its mapped,
  conditional and template-literal types). Checking smaltts's own source is not in scope.
- **Done when:** `npm run check` runs smaltty's checker over `test/` and the reference's examples, the compile-time
  tests' `@ts-expect-error` lines are reported, and it reports nothing tsc wouldn't (smaltty's milestone 7,
  stenhoor/smaltty#4 records the scope).

## 1. Re-base on smaltdb 0.9.0

Size: M. Needs milestone 0. Status: done, 2026-11-10: pinned to smaltdb `1ce660a`; 39 tests, none registering SQL.

- Pin smaltdb `main` (0.9.0, feature-complete), and follow its pin to the published `@smaltworks/smaltdb` when it is
  out.
- Expressions name the engine's operations (`cmp_eq`, `div_float`, …), with result types from `catalog.resultType`.
- The language provides only the stored-object part (`bindView`, `viewReferences`, `viewDefinition`,
  `sourceEditor`); tables and indexes are defined without source text.
- The catalog reader uses `db.catalog` / `catalog()` instead of `information_schema` plans.
- Errors carry an `origin` naming the smaltts call.
- **Done when:** every prototype test passes on the new pin, and a test project runs them with no SQL language
  registered.

## 2. Specs with the engine's types

Size: M. Status: done, 2026-11-10: the types, values in and out and inference (stenhoor/smaltts#7); CHECKs, computed
defaults and foreign keys (in review). The 500-column measurement waits for smaltty's checker.

- `bool()`, `date()`, `datetime({ zone? })`, `time()`, `duration()`, `list(…)`, `struct({…})`; CHECKs and defaults
  as plan expressions; foreign keys.
- `inferTable` from JavaScript data recognises booleans, `Date`s, arrays and objects.
- Values in and out: `Date` for `date` and `datetime`, booleans, arrays and objects; the exact temporal form on
  request.
- **Done when:** every type round-trips through a load and a read; and a 500-column declared table checks in under a
  second with smaltty's checker (shallow types), once that runs.

## 3. Diff, change sets and history, complete

Size: L. Status: done, 2026-11-10: every spec field compared (CHECKs, foreign keys and defaults read from
`information_schema` until the engine's catalog lists them), rebuilds converted and classified by the conversion
table, row and columnar tables (`test/diff.test.ts`). Gate A is next.

- **smaltdb (S), no longer first** (stenhoor/smaltdb#189): the catalog listing foreign keys, CHECKs and default values (E1's remainder) would
  replace the `information_schema` reads; milestone 3 did not wait for it.
- The differ compares every spec field; the conversion table of DESIGN.md 8.3, for every type, classifies rebuilds.
- `apply`: policies on impact and data loss, one transaction, the history table with checksums.
- **Done when:** for every spec field, a change produces the expected step and class; diffing any database against
  its own catalog gives no steps, on row and columnar tables.

**Gate A (owner): migrations on disk.** Decided 2026-11-10: live diff plus saved change sets (ADR 0023, decision 19).

## 4. Saved change sets

Size: M (gate A chose live diff plus saved change sets).
Status: done, 2026-11-10: `changeSetFile`, `parseChangeSetFile` and `db.migrateFiles` (`test/files.test.ts`).

- `db.migrateFiles(dir)`: replay unapplied change-set files in order, refuse edited files (checksums), and report
  drift between the history and the catalog.
- **Done when:** two databases at different versions reach the same catalog by replaying the same files.

## 5. Typed plans, the full format

Size: M. Status: done, 2026-11-10: the relation operations (stenhoor/smaltts#10); windows, correlated subqueries,
`iterate` and CASE; the table of signatures (`test/plans.test.ts`, `test/functions.test.ts`).

- A builder for each plan operation (DESIGN.md section 7): windows, set operations, subqueries, `iterate`, pivot and
  unpivot, asof joins, sample, explode, ordered joins and aggregates, `limit` from the end, `distinct` keeping a row.
- The engine's function list typed: a table of signatures for the operations, and loose types for any it doesn't
  name yet.
- **Done when:** each operation has a test that runs it through smaltts and through the raw plan API and gets the same
  rows; and the compiled plans of the common pipelines are the ones the raw builders give (no extra nodes).

## 6. Views: reflecting and interface

Size: M in smaltts; **smaltdb E10 is L** (stenhoor/smaltdb#188).
Status: part 1 done, 2026-11-10: interface views with a column list, view sources that follow renames column by
column, and change sets that check the views over a changed table (`test/views.test.ts`); part 2 waits on E10.

- **Without E10:** reflecting views by default, interface views with a column list (names and order), reading views
  of other languages, the change-set warnings and errors for affected views, and the recreate step for reflecting
  materialized views whose shape changes.
- **smaltdb E10:** typed column lists, the conversion table in the engine, dependents checked after every DDL.
- **Done when (part 1):** a rename, an added column and a dropped column each give the documented result and
  change-set entry, for both kinds of view, on plain and materialized views.
- **Done when (part 2, after E10):** the same DDL from smaltql gives the same results.

**Gate B (owner):** decided 2026-11-10: ship interfaces as names and order now, without waiting for E10 (ADR 0023,
decision 21).

## 7. Flows

Size: L.

- `flow`, its steps (`migrate`, `apply`, `load`, `refresh`, `check`, `analyze`, `call`), `db.plan(flow)` as a
  preview, `db.run(flow)` in one transaction or per step, resuming after the last committed step.
- Loads in every mode, `merge` among them; incremental loads wait for change capture (smaltdb E8, L, after 0.9.0).
- **Done when:** a flow previews exactly what it then runs; a flow that fails at step n leaves steps before n
  committed (per-step mode) or nothing (one transaction); and a resumed run finishes it.

**Gate C (owner), with smaltfl:** what a flow holds and what smaltfl adds (schedules, dependencies, retries), before
smaltfl starts.

## 8. Plan review

Size: S in smaltts; **smaltdb E2 is M** (stenhoor/smaltdb#187).

- `explain` as a tree with estimated and actual rows (today's engine); costs and structured operator fields once E2
  is in.
- **Done when:** a test can assert a plan's shape (an index is used, no full scan) from fields, not from text.

## 9. Plugins and external data

Size: M.

- Connections and external tables as specs, diffed and applied like tables.
- Plugin calls typed by descriptors, if the owner chooses them (DESIGN.md section 14, open question 2).
- **Done when:** a flow reads Parquet through `@smaltdb/parquet` into a table, both declared as specs.

## 10. The client and the browser

Size: M.

- Everything above through the worker client, and a worker entry with smaltts's language registered
  (`defineWorker`).
- Browser tests (Playwright, as smaltdb and smaltdf run them, on Chromium, Firefox and WebKit).
- **Done when:** the test suite runs in process and through the worker in each browser, with the same results.

## 11. Docs site and publish

Size: M. Needs smaltdb's 0.9.0 publish.

- A VitePress site on smalt-brand's theme, as smaltdf and smaltty have; the reference generated from the specs and
  builders, with every example run as a test.
- `@smaltworks/smaltts` published with smaltdb, smaltql and smaltdf, and a smalt-brand PR updating smaltts's status.
- **Done when:** the site deploys, the package installs, and its examples run.

## Order and weight

| # | Milestone | Size | Waits on |
|---|---|---|---|
| 0 | Outside code | S | done (2026-11-10) |
| — | smaltty's checker covers smaltts | L (smaltty) | done for smaltts (2026-11-11) |
| 1 | Re-base | M | done (2026-11-10) |
| 2 | Types in specs | M | done (2026-11-10) |
| 3 | Diff complete | L | done (2026-11-10) |
| 4 | Saved change sets | M | done (2026-11-10) |
| 5 | Typed plans | M | done (2026-11-10) |
| 6 | Views | M | 3, 5; part 2 on smaltdb E10 (L); gate B (decided) |
| 7 | Flows | L | 3, 5; gate C |
| 8 | Plan review | S | 5; costs on smaltdb E2 (M) |
| 9 | Plugins and external data | M | 3 |
| 10 | Client and browser | M | 7 |
| 11 | Docs and publish | M | 10, smaltdb's publish |

Milestones 2, 3 and 5 can run in parallel after 1. In smaltts alone the total is about six L-equivalents (seven M, two L, three S); the engine
work it asks for (E1's remainder, E2, E10) is about one more L, mostly E10.
