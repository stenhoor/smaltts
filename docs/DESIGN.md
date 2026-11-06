# smaltts design

- **Status:** proposed, for the owner's review. A prototype of sections 4–9 is in `src/` and runs against the
  in-process smaltdb engine (`test/smaltts.test.ts`).
- **Date:** 2026-11-06
- **Builds on:** smaltdb [ADR 0014](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0014-shared-plan-layer.md)
  (the shared plan layer) and [ADR 0015](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0015-smaltql.md)
  (smaltql and the language API). Research: [docs/research](research/README.md).
- **Replaces:** the first, query-first draft (`docs/PLAN.md`, in git history).

## 1. What smaltts is

smaltts is the **database-first, plan-first TypeScript API for smaltdb**. It is for the people who build toolchains
and data pipelines: code that creates, reshapes, indexes, fills and checks databases, usually with schemas that
arrive at run time as well as schemas written in code.

| | smaltql | smaltdf | **smaltts** |
|---|---|---|---|
| Who | app developers writing queries | analysts working with frames | toolchain and pipeline builders |
| First-class thing | the query (text) | the frame (DML first) | **the database: its objects, their changes, and plans (DDL first)** |
| Unit of work | a statement | a lazy frame | a change set, a load, a relation |
| Schema | DDL text | inferred from data | **specs: data you build, read back, compare and apply** |

### Why it is not a pass-through

The owner's test: if smaltts were only a way to send SQL or to manipulate frames, it should not exist. It passes
because what it offers is engine-native and has no equivalent in either sibling:

- **Schemas are values** that round-trip: the spec you write and the spec read back from a database are the same kind
  of object, so a database can be compared with what a pipeline wants, and the difference is data.
- **Changes are reviewable before they run**: a change set says what each step costs (metadata, instant, build,
  rewrite) and what it may lose (none, possible, certain), and a policy decides whether it may run. Neither SQL nor a
  frame library has this; with SQL it is a separate tool parsing text.
- **Plans are values**: a relation is JSON with names, compiled to the engine's positional plan. It is what a view
  stores, what a load writes from, what explain shows. smaltts talks to the engine only in plans and schema
  operations; there is no SQL anywhere in it.
- **It is a language of the engine** (ADR 0015): views and tables made by smaltts keep smaltts sources, which the
  engine hands back to smaltts to bind and to edit on ALTER TABLE. Their sources are JSON, so editing them is editing
  data, never text.

## 2. Principles

1. **DDL first.** When DDL and DML ergonomics conflict, DDL wins. Queries exist to feed loads, views and checks.
2. **Build data, then run it.** Every builder returns plain, JSON-safe data (specs, relations, change sets). Running
   is a separate, explicit call. Anything can be printed, stored, diffed, approved and sent elsewhere before it runs.
3. **One model, two front doors.** A spec written in TypeScript and a spec built at run time (from a file, an API,
   another database) are the same object and go through the same paths. The first also carries a row type.
4. **Never guess, never prompt.** Renames are declared (`renamedFrom`), never inferred. Destructive or lossy steps are
   marked, and refused unless a policy allows them.
5. **Never hide the plan.** Every relation can show its smaltts IR, its engine plan and its physical plan with
   estimates and measurements.
6. **Engine-native.** smaltts uses the engine's plan format, schema operations, transactions and plugin calls, and
   nothing else. What the engine cannot do yet is proposed to smaltdb (section 11), not emulated in a second engine.
7. **Shallow types.** Row types come from a flat mapping of column types; no deep recursive generics, so tables with
   hundreds of columns stay fast in the editor.
8. **Same code in a page and in Node.** One asynchronous API over the in-process engine and the worker client.

## 3. Concepts

| Concept | What it is | Module |
|---|---|---|
| **Spec** | the desired state of an object: `TableSpec`, `IndexSpec`, `SchemaSpec` (a set of tables) | `spec.ts` |
| **Catalog** | a live database read back as specs (plus its views) | `catalog.ts` |
| **Change set** | the difference between a catalog and a desired schema: ordered steps, each with its engine statements, impact and data loss | `changes.ts` |
| **Relation** (`Rel<Row>`) | a plan as a value, by column name; compiled to the engine's positional plan | `rel.ts` |
| **Load** | rows moved into a table from a relation or from JavaScript, with a mode | `database.ts` |
| **Backend** | the engine in-process, or the client to an engine in a worker | `backend.ts` |
| **Language** | smaltts registered with the engine: binds smaltts views, edits smaltts sources | `language.ts` |

## 4. Attaching

```ts
import { Database } from 'smaltdb/engine';          // or: import { open } from 'smaltdb' (worker client)
import { attach, registerSmaltts } from '@smaltworks/smaltts';

registerSmaltts();                                   // in-process; in a worker: defineWorker({ languages: [smalttsLanguage] })
const db = attach(Database.openMemory());            // any engine or client Database
```

`attach` takes an engine `Database`, a client `Database` or a `Backend`. Everything on the result is asynchronous.

## 5. Specs: tables declared or discovered

```ts
import { table, int, real, text, inferTable, tableSpec } from '@smaltworks/smaltts';

// Declared: a row type comes with it.
export const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().indexed(),
  total: real().notNull(),
  note: text(),
}, { storage: 'row' });
type Order = NonNullable<typeof orders.$row>;  // { id: number; customerId: number; total: number; note: string | null }

// Discovered at run time: the same object, rows untyped.
const products = inferTable('products', sampleRows, { primaryKey: ['sku'] });
const fromJson = tableSpec(JSON.parse(configText));            // checked: unknown columns in keys and indexes throw
const copy = { ...orders, name: 'orders_archive', indexes: [] }; // specs are data: spread, map, filter
```

| Spec field | Engine definition |
|---|---|
| `columns[]`: `name`, `type` (`INTEGER`, `REAL`, `NUMERIC`, `TEXT`, `BLOB`, `ANY`), `notNull`, `collation`, `default`, `renamedFrom` | `ColumnDef` |
| `primaryKey`, `unique[]` | `KeyDef` |
| `indexes[]`: `name`, columns with `desc` and `collation`, `unique` | `IndexDef` |
| `foreignKeys[]` | `ForeignKeyDef` |
| `storage`: `row` / `columnar` | `TableDef.storage` |
| `renamedFrom` | (intent for the differ) |

Column builders (`int()`, `real()`, `numeric()`, `text()`, `blob()`, `any()`) and modifiers (`.notNull()`,
`.primaryKey()`, `.unique()`, `.indexed()`, `.collate()`, `.default()`, `.renamedFrom()`) only produce spec data.
`table()` uses a `const` type parameter, so no `as const` is needed.

## 6. Catalog, diff, change sets and apply

```ts
const v2 = { tables: [customers, table('orders', {
  id: int().primaryKey(),
  buyer: int().notNull().renamedFrom('customerId').indexed(),
  total: text().notNull(),                    // REAL → TEXT: needs a rebuild
  note: text(),
})] };

const changes = await db.diff(v2);            // nothing runs
console.log(describe(changes));
// 1 step(s), impact rewrite, data loss possible, checksum 27883d7a29f9faad
//  1. rebuildTable orders  [impact rewrite, data loss possible]
//       total: type REAL → TEXT; also renames customerId to buyer, adds note,
//       drops index orders_customerId, creates index orders_buyer
await db.apply(changes);                                  // refused: possible data loss
await db.apply(changes, { allowDataLoss: 'possible' });   // runs, in one transaction, and is recorded
(await db.diff(v2)).steps;                                // []: the database now matches
```

- **`db.catalog()`** reads tables (columns, keys, indexes), views and materialized views through `information_schema`
  plans, as specs. Reading a database and diffing it against itself gives an empty change set (tested).
- **`db.diff(desired, { prune })`** compares. Tables the database has and the schema does not are reported, and
  dropped only with `prune`.
- **Steps** and how each is classified:

  | Step | Impact | Data loss | Engine statements |
  |---|---|---|---|
  | `createTable` | metadata | none | `createTable` |
  | `renameTable`, `renameColumn` (from `renamedFrom`) | metadata | none | `alterTable` |
  | `addColumn` (nullable or with a default, at the end) | instant | none | `alterTable` |
  | `dropColumn` | rewrite | certain | `alterTable` |
  | `createIndex` | build | none | `createIndex` |
  | `dropIndex` | metadata | none | `drop` |
  | `rebuildTable`: a change the engine cannot make in place (type, nullability, collation, default, keys, storage, column order) | rewrite | none / possible / certain | `createTable` (new), `append` plan (copy by name), `drop` (old), `alterTable` (rename), `createIndex`… |
  | `dropTable` (with `prune`) | metadata | certain | `drop` |

- **`apply(changes, policy)`** refuses errors, any step above `policy.allowDataLoss` (default `none`) and any step
  above `policy.maxImpact`. It runs every statement of every step in **one transaction** (smaltdb's DDL is
  transactional: a failed step leaves the database as it was) and records the change set in `smaltts_history`
  (checksum, label, steps).
- **Change sets are JSON.** They can be generated in CI, reviewed, stored in a repository, approved and applied
  later or on another machine; `apply` takes the parsed JSON as it is.
- **`db.migrate(desired, policy)`** is `diff` then `apply`.

## 7. Relations: plans as values

```ts
import { scan, values, tableFunction, agg, param } from '@smaltworks/smaltts';

const spend = scan(orders)
  .filter((o) => o.total.gte(param.real('min')))
  .join(scan(customers), (o, c) => o.customerId.eq(c.c_id), { prefix: 'c_' })
  .aggregate((r) => ({ name: r.c_name }), (r) => ({ spent: agg.sum(r.total), orders: agg.count() }))
  .sort('-spent');

await db.rows(spend, { min: 1 });   // { name: string | null; spent: number | null; orders: number }[]
JSON.stringify(spend);              // the IR: { r: 'sort', input: { r: 'aggregate', … } }
```

A relation is pipeline-shaped: each method is one relational operation, applied in the order written (as Calcite's
RelBuilder, not as a SQL query's fixed clause order).

| Group | Operations | Engine plan |
|---|---|---|
| Sources | `scan(table \| view)`, `values(columns, rows)`, `tableFunction(name, args, columns)` (plugin readers: `read_csv`, `read_parquet`, …) | `scan`, `values`, `source` |
| Rows | `filter`, `limit`, `distinct` | `filter`, `limit`, `distinct` |
| Columns | `select` (new columns), `extend` (add or replace), `pick` | `project` |
| Combining | `join`, `leftJoin` (right side nullable), `semiJoin`, `antiJoin`, `union` | `join`, `setop` |
| Grouping, order | `aggregate(keys, aggs)`, `sort('-col', 'col')` | `aggregate`, `sort` |

**Expressions** are typed by the row: `o.total` is `Expr<number>`, a misspelt column or a comparison with the wrong
type fails `tsc` (tested with `@ts-expect-error`). Each operation names the engine operation that gives it its
meaning; where TypeScript and SQL differ, smaltts takes TypeScript's: `div` is float division (7 / 2 = 3.5), `intDiv`
truncates. Columns collide only on joins, where `prefix` renames the right side.

**Compiling** resolves names against the catalog's specs and produces the engine's positional plan; the engine
validates it as it validates every plan. Named parameters become positional ones in order of first use.

## 8. Views and materialized views

```ts
await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(100)));
await db.createView('order_totals', byCustomer, { materialized: true, storage: 'columnar' });
await db.refresh('order_totals', { concurrently: true });
await db.rows(scan('order_totals'));
```

A view's source is its relation's JSON, in the language `smaltts`. The engine binds a materialized view through
smaltts when it fills it; a plain view is read by smaltts by inlining its relation (plans have no view reference
yet: E3). When ALTER TABLE renames a column, the engine asks smaltts to edit every smaltts source that refers to it.
**A view's columns are its interface**: a rename underneath changes what the view reads, not the names it gives, so
the pipeline steps downstream keep working (smaltql, following SQLite, changes the output name instead).

## 9. Loads and writes

```ts
await db.load(orders, rows);                                    // append JavaScript rows
await db.load(orders, rows, { mode: 'upsert' });                // a row whose key is taken replaces the others' values
await db.load(orders, scan('staging_orders'), { mode: 'replace' });  // delete all, then append: one transaction
await db.load(orders, tableFunction('read_csv', ['file:orders.csv'], cols), { mode: 'swap' });
await db.deleteWhere(orders, (o) => o.total.lt(0));
await db.updateWhere(orders, (o) => ({ total: o.total.mul(1.1) }), (o) => o.customerId.eq(7));
```

| Mode | What it does | Engine statements |
|---|---|---|
| `append` | add rows | `append` |
| `upsert` | add rows; on a key conflict, set the other columns | `append` with `upserts` |
| `replace` | delete every row, then add | `delete`, `append`, in one transaction |
| `swap` | build a new copy, switch it in, rebuild its indexes: readers never see it half-built | `createTable`, `append`, `drop`, `alterTable`, `createIndex`, in one transaction |

Sources are matched to the target's columns **by name**. A load from a relation runs entirely in the engine (no rows
cross into JavaScript): table to table, plugin file reader to table, view to table.

## 10. Plan review, plugins, transactions

```ts
await db.analyze();
console.log(String(await db.explain(rel, { analyze: true })));
// PROJECT  [1 rows, 1 loops, 1.208 ms]
//   HASH AGGREGATE  [1 rows, 1 loops, 1.196 ms]
//     SEARCH orders USING INDEX orders_customerId (=?)  (est 4 rows)  [4 rows, 1 loops, 0.793 ms]

await db.compile(rel);                          // { plan: PlanOp, fields, params }: the engine plan itself
await db.plugin('@smaltdb/io').call('importCSV', …);
await db.transaction(async (tx) => { await tx.load(…); await tx.apply(…); });   // nested: savepoints
```

`explain` returns a tree (`ExplainNode`: detail, estimated rows, measured rows, loops, time). Costs per node need the
engine (E2).

## 11. The engine: findings and proposals

Building the prototype against smaltdb `0b36f33` found one bug and the gaps below. Each is a candidate smaltdb
issue; none is worked around with a second implementation in smaltts.

| # | Kind | What | Why smaltts needs it |
|---|---|---|---|
| **F1** | bug | The first materialized view creates the system table `smalt_matview` from SQL text, with no stored definition. Afterwards every `renameColumn` asks the `sql` language to edit it and fails without smaltql: `ALTER TABLE needs the sql language to edit its objects' source text`. ADR 0015 §6 says system tables are defined in code. | Renames in any database with a materialized view, without SQL. Pinned by a `test.fails` that flips when fixed. |
| **E1** | API | **Catalog as definitions**: `TableDef` / `IndexDef` / view sources through `BindContext` and the client, instead of `information_schema` rows. `information_schema` loses a table's storage, foreign keys, expression and partial indexes, CHECKs, defaults as values and each object's language. | Exact round-trips for every spec field; diffs that see everything. |
| **E2** | API | **Structured EXPLAIN with costs**: estimated rows and cost per node in `plan` mode, operator kind, table and index as fields rather than one detail string. | Plan review and costing without parsing text; comparing plans in CI. |
| **E3** | plan format | **A view reference in plans** (`{ op: 'view', name }`), bound by the view's own language. Also lets smaltql read smaltts views and smaltts read SQL views (today each language reads only its own). | Cross-language views; no inlining in smaltts. |
| **E4** | schema op | **More in-place changes**, or a `rebuildTable` operation the engine runs itself: alter a column's type, nullability, default, collation; add or drop a key; change storage. | Fewer and cheaper rebuilds; the engine can keep statistics and dependent views. |
| **E5** | schema op | **Impact from the engine**: a dry run of a schema operation that reports whether it rewrites the table, how many rows it touches and what depends on the object (`pg_depend`, MySQL's ALGORITHM). | Classification from the engine rather than from smaltts's rules; dependency-ordered steps. |
| **E6** | plan format | **A columnar `values` source** (already planned in ADR 0015 §9) and a bulk append path. | Fast loads of large JavaScript batches. |
| **E7** | plan format | **Behaviour-named functions** (ADR 0015 step 2): float division, a boolean type, dates and times. | `div` without a cast; booleans in specs and rows. |
| **E8** | engine | **Change capture** (the roadmap's sync groundwork) and **resumable rebuilds** that do not hold the writer for a whole copy. | Incremental loads in smaltfl; rebuilding large OPFS tables. |

## 12. Relationships

- **smaltdb**: smaltts is a client of its public plan, schema and plugin APIs and imports nothing else. Builders use
  `smaltdb/plan` (no engine in a page that only builds plans); the language uses `smaltdb/language`.
- **smaltql, smaltdf**: peers. smaltts shares no code with them; they meet in the engine. Tables made by any of them
  are read by the others; views are language-bound until E3.
- **smaltfl** (owner's decision): the pipeline product **built on smaltts**. smaltts provides the transactional units
  (change sets, loads, views, refreshes, explain) and stays free of orchestration (schedules, DAGs, lineage UI).

## 13. Prototype status

Working against the in-process engine (`npm test`: 15 tests, 1 expected failure for F1): typed and inferred specs,
catalog round-trip, diff with renames, rebuilds and policies, change-set JSON and history, loads in four modes,
relations with joins, aggregates, parameters and typed rows, plain and materialized views, ALTER source editing,
explain with measurements, compile-time name checks.

Not yet: the worker client (written, untested: needs a browser test), windows, recursion, subqueries, foreign-key
comparison (E1), plugin descriptors with typed methods, external tables and connections as specs, a job API for
long rebuilds, and a published package (the name and smaltdb pin follow the sibling repositories).

## 14. Open questions for the owner

1. **Migrations on disk**: desired state only (diff against the live database each time), or also a versioned
   folder of change-set JSON files in the application's repository (as Atlas's versioned mode)?
2. **Rebuilds of large tables**: is a blocking rebuild in one transaction acceptable for v1, or must resumable
   rebuilds (E8) come first?
3. **View column names on rename**: keep a view's names stable (this design) or follow the table (smaltql)?
4. **Relation scope**: how far should the relational builder go while DDL comes first: windows, recursion,
   subqueries, set operations beyond `union`?
5. **Plugins**: typed descriptors (a plugin ships a smaltts module with typed methods and table functions), or the
   generic `plugin(name).call()` only?
6. **Engine proposals**: open F1 and E1–E8 as smaltdb issues now, and in which order?
7. **Types**: wait for the engine's boolean and date types (E7), or add smaltts logical types (a boolean stored as
   `INTEGER` with a check) before then?
