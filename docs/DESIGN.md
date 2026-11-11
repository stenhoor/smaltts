# smaltts design

- **Status:** proposed, for the owner's review. Revised 2026-11-08 against smaltdb `9cd575c` (0.9.0, feature-complete,
  not yet published) and smaltdf after its rebuild on plans. Decisions are recorded in section 14; the order of work is
  in [MILESTONES.md](MILESTONES.md). A prototype of sections 4–10 is in `src/`, pinned to smaltdb 0.9.0 (`1ce660a`) (section 13).
- **Date:** 2026-11-06, revised 2026-11-08
- **Builds on:** smaltdb [ADR 0014](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0014-shared-plan-layer.md)
  (the shared plan layer) and [ADR 0015](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0015-smaltql.md)
  (smaltql and the language API). Research: [docs/research](research/README.md).
- **Replaces:** the first, query-first draft (`docs/PLAN.md`, in git history).

## 1. What smaltts is

smaltts is a **thin, typed TypeScript API over smaltdb's plan and schema operations, with structured flows**, for
applications and layers that want neither SQL nor dataframes (smalt-brand's description, the owner's placement at the
language layer beside smaltql and smaltdf). Its first users are the people who build toolchains and data pipelines,
smaltfl among them: code that creates, reshapes, indexes, fills and checks databases, with schemas that arrive at run
time as well as schemas written in code.

**Thin** means it adds no meaning of its own. Every operation and expression is one of the engine's, named as the
engine names it; what smaltts adds is names instead of positions, TypeScript types, schemas as values, reviewable
change sets and flows. That is also what separates it from smaltdf, which has its own specified semantics (Polars-like
names, strict arithmetic, `/` as float division) and from smaltql, which keeps SQLite's.

| | smaltql | smaltdf | **smaltts** |
|---|---|---|---|
| Who | app developers writing queries | analysts working with frames | applications, layers, toolchain and pipeline builders |
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
- **Flows are values**: a flow is a reviewable sequence of change sets, loads, refreshes and checks, which a tool such
  as smaltfl schedules (section 9.1).
- **Its views are its own** (ADR 0015, 0016 §6): smaltts registers as a language for the views it stores, whose
  sources are JSON, so the engine's edits on ALTER TABLE are edits of data, never text.

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
import { attach } from '@smaltworks/smaltts';
import { registerSmaltts } from '@smaltworks/smaltts/language';

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

### 5.1 The engine's types

smaltts has exactly the engine's types, and adds none (owner's decision: engine first). Since smaltdb ADRs 0018–0020
they are:

| Spec type (storage) | Plan type | JavaScript value | Builder |
|---|---|---|---|
| `INTEGER`, `REAL`, `NUMERIC`, `TEXT`, `BLOB`, `ANY` | `int`, `real`, `num`, `text`, `blob`, `any` | `number` / `bigint`, `number` (NaN kept, distinct from null), `string`, `Uint8Array` | `int()`, `real()`, `numeric()`, `text()`, `blob()`, `any()` |
| `BOOLEAN` (ADR 0018) | `bool` | `boolean` | `bool()` |
| `DATE` (ADR 0019) | `date` | `Date` at midnight UTC (default) | `date()` |
| `DATETIME` | `datetime`: µs, no zone in the type | `Date` (default) | `datetime()` |
| `TIME` | `time`: µs since midnight | ISO text | `time()` |
| `DURATION` | `duration`: µs | ISO 8601 text | `duration()` |
| `LIST` (ADR 0020) | `list<T>` | array | `list(int())` |
| `STRUCT` | `struct<a T, …>` | object | `struct({ a: int(), b: text() })` |

- **Dates and times follow ADR 0019**, which the owner accepted on 2026-11-07 and which replaces this section's first
  version (precision as part of the type, separate local and UTC types, months in intervals, a SQL dialect version):
  one unit, µs; a `datetime` is a wall-clock time or a UTC instant as the data means it; a **time zone is a value**
  passed to `to_zone` / `from_zone` / `zone_offset`, so each row can have its own; calendar steps are `offset_by`.
- **Reading values:** the engine gives temporal values as ISO text by default and other forms on request; each
  language chooses. smaltts reads `datetime` and `date` as `Date`, as smaltdf does, so values written from a `Date`
  round-trip exactly. A `Date` holds ms, so a `datetime`'s µs are dropped, as the engine's `Date` form drops them
  (owner's decision, 2026-11-10); `{ temporal: 'text' }` reads the exact text.
- **A zone for a column** would be smaltts metadata in the spec (`datetime({ zone: 'Europe/Paris' })`), passed to the
  engine's zone operations; storage has no zone (ADR 0019 §2). Not built yet: the catalog could not read it back, so it
  needs somewhere to be kept (planned).
- **SQL keeps SQLite's meaning** (ADR 0019 decision 4): SQL's `DATE` declared type stays NUMERIC, and SQL reads
  temporal values as text and lists and structs as JSON. Tables smaltts defines are plan-defined, so they get the real
  types; smaltql users read them as text. No dialect version is needed.
- **Row types stay shallow:** each builder maps to a TypeScript type through one flat table, nested types through one
  level of mapping per nesting.

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

- **`db.catalog()`** reads tables (columns, keys, indexes, storage), views and materialized views from the engine's
  catalog (`db.catalog` in process, `catalog()` on the client: ADR 0016 §7), as specs: foreign keys, CHECKs and
  default values too, which the catalog lists since smaltdb#200 (E1). Reading a database and diffing it against itself
  gives an empty change set (tested).
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
  | `rebuildTable`: a change the engine cannot make in place (type, nullability, collation, default, keys, storage, column order) | rewrite | none / possible / certain (below) | `createTable` (new), `append` plan (copy by name), `drop` (old), `alterTable` (rename), `createIndex`… |
  | `dropTable` (with `prune`) | metadata | certain | `drop` |

- **Data loss is decided by types, never by data.** A rebuild loses nothing when every column's type change is
  lossless by the conversion table of section 8.3; it may lose data otherwise, whatever the rows hold today; it
  certainly loses data when it drops columns. `diff` and `apply` never scan rows to classify a change, so a change set
  gets the same verdict in CI and in every database it is applied to. If a policy allows a lossy rebuild and a row
  cannot be converted, the copy fails inside `apply`'s transaction and nothing changes. A rebuild that wants a lossy
  conversion on purpose names it in the change (a rounding or parsing function) instead.
- **`apply(changes, policy)`** refuses errors, any step above `policy.allowDataLoss` (default `none`) and any step
  above `policy.maxImpact`. It runs every statement of every step in **one transaction** (smaltdb's DDL is
  transactional: a failed step leaves the database as it was) and records the change set in `smaltts_history`
  (checksum, label, steps).
- **Change sets are JSON.** They can be generated in CI, reviewed, stored in a repository, approved and applied
  later or on another machine; `apply` takes the parsed JSON as it is.
- **`db.migrate(desired, policy)`** is `diff` then `apply`.

## 7. Relations: typed plans

```ts
import { scan, agg, param } from '@smaltworks/smaltts';

const spend = scan(orders)
  .filter((o) => o.total.gte(param.real('min')))
  .join(scan(customers), (o, c) => o.customerId.eq(c.c_id), { prefix: 'c_' })
  .aggregate((r) => ({ name: r.c_name }), (r) => ({ spent: agg.sum(r.total), orders: agg.count() }))
  .sort('-spent');

await db.rows(spend, { min: 1 });   // { name: string | null; spent: number | null; orders: number }[]
JSON.stringify(spend);              // the IR: { r: 'sort', input: { r: 'aggregate', … } }
```

A relation is the engine's plan with names instead of positions, and TypeScript types on every column. It is thin
by rule:

- **One builder per plan operation**, in the order written, nothing composed behind the user's back: `scan` (tables
  and views), `values` (from rows or typed-array columns), `source` (table functions and external data), `filter`,
  `project` (`select`, `extend`, `pick`), `join` (inner, left, right, full, semi, anti, cross, asof, with `ordered`),
  `aggregate` (with `ordered`), `window`, `sort`, `limit` (with `fromEnd`), `distinct` (with `keep`), `setop`,
  `iterate`, `pivot`, `unpivot`, `sample`, `explode`.
- **Expressions are the engine's operations**, by their engine names and with the result types the catalog gives
  (`catalog.resultType`). There is no smaltts-defined division: the operation is chosen
  explicitly, as `fn.div_float(o.total, 2)` or `fn.div_trunc(…)`, with short typed aliases only where an operation
  has one meaning (`eq` is `cmp_eq`, `and` is the logic node). The full set comes from the engine's function list, so
  a new engine operation is available without a smaltts release (typed loosely until smaltts's table of signatures
  names it).
- **Names resolve when the plan is compiled,** against the specs or the catalog, and fail then, naming the builder
  call (`origin`, ADR 0016 §10). Typos and wrong types are type errors first, where the row type is known (checked by smaltty's checker once it
  covers smaltts).
- **No query semantics of smaltts's own,** and no frames: an application that wants dataframes uses smaltdf, one that
  wants SQL uses smaltql. All three build plans for the same engine, and their tables and views read each other.

The scope decision of the interview (windows, set operations and subqueries, recursion, merge and incremental loads)
stands; the thin rule makes it a one-to-one mapping of the plan format rather than a language to specify.

## 8. Views and materialized views

```ts
// A reflecting view (the default): its columns follow the tables it reads.
await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(100)));
// An interface view: its columns are declared, and are a contract.
await db.createView('order_totals', byCustomer, { columns: ['customerId', 'total'], materialized: true, storage: 'columnar' });
await db.createView('daily', byDay, { columns: true });   // declare the relation's current columns as the interface
await db.refresh('order_totals', { concurrently: true });
```

A view's source is its relation's JSON, in the language `smaltts`. The engine reads views by name (a `scan` may name
a view, bound by its own language: ADR 0016 §6), so a smaltts view can be read from smaltql or smaltdf, and theirs from
smaltts, when the view declares its columns. When ALTER TABLE renames a column, the engine asks smaltts to edit every
smaltts source that refers to it. Tables and indexes need no source text any more (ADR 0016 §6): smaltts defines them
without one, and registers as a language only for its views (the stored-object part of the language interface).

### 8.1 Two purposes: reflecting and interface views

A view has one of two purposes, and declares which:

| | Reflecting view (the default) | Interface view |
|---|---|---|
| Declared by | nothing | a **column list**: `columns: ['a', 'b']`, or `columns: true` for the relation's current columns |
| Its columns | follow the tables it reads | are a contract: names, order and types |
| A column it reads is renamed | a column it passes through takes the new name; columns it names itself keep their names | the view reads the new name; its output does not change |
| A column is added to a table it reads in full | the view gains the column | the view does not change |
| A type changes underneath | the view's column takes the new type | allowed only by a lossless conversion (8.3), which the view applies; otherwise breaking |
| A column it passes through is dropped (a reflecting `scan`) | the view loses the column | breaking |
| A column it names or reads in an expression is dropped | breaking | breaking |
| Suits | staging, internal and convenience views | views other tools and pipeline steps read; published datasets |

**The column list is the declaration, in every language.** It is standard SQL (`CREATE VIEW daily(day, total) AS …`,
as in PostgreSQL and SQLite), smaltql already parses it for views and materialized views, and the engine already
stores it (`createView.columns`) and checks its length. A view declared with a column list in smaltql and one
declared in smaltts are the same engine object with the same behaviour: no new SQL syntax and no dialect change
(smaltdb ADR 0015 §8). smaltql's views already behave this way: a rename rewrites the query's references, never the
column list. A smaltts view without a column list follows the table, as smaltql's does.

### 8.2 What protects an interface

Checked against smaltdb `0b36f33`, whichever language issues the DDL (smaltql's DDL reaches the engine as the same
schema operations):

| DDL | What happens today | Interface |
|---|---|---|
| Rename a column a view reads | allowed; the view's source is edited | holds |
| Drop a column a view reads | refused by the engine: after every ALTER it binds each view that worked before, through the view's language, and refuses the ALTER if one fails | holds |
| Drop a table a view reads | allowed; the view fails when read | lost |
| Drop and recreate a table with other types | allowed; the view silently gives the new types | lost |
| Drop or replace the view | allowed | lost |

Names and order hold today. Types, and protection against drops and recreation, need the engine (E10): a contract
that only smaltts checked would be a convention that any SQL session could break.

### 8.3 Type changes: decided by types, never by data

A type change that reaches a view's output through an interface column is breaking unless it converts losslessly to
the declared type. "Lossless" is a property of the two types alone: the conversion must be exact for every value the
new type can hold. smaltts never classifies a change by the values a column holds today, and never validates rows
while reading: a conversion a view applies is total, so a read never fails on a row.

| New underlying type → declared type | Result |
|---|---|
| the same type | unchanged |
| INTEGER → NUMERIC, REAL → NUMERIC | lossless: the view converts |
| INTEGER → TEXT, REAL → TEXT | lossless (exact, round-trip text): the view converts |
| TEXT → BLOB | lossless (UTF-8 bytes): the view converts |
| any type → ANY | lossless |
| BOOLEAN → INTEGER | lossless: the view converts |
| DATE → DATETIME (at midnight) | lossless: the view converts |
| BOOLEAN, DATE, DATETIME, TIME, DURATION → TEXT (the engine's result format) | lossless: the view converts |
| LIST, STRUCT → TEXT (JSON) | lossless: the view converts |
| `list<A>` → `list<B>`, `struct<…A…>` → `struct<…B…>` | as A → B, element by element (an added struct field is breaking) |
| NOT NULL → nullable declared | lossless |
| INTEGER → REAL | breaking: not exact beyond ±2^53 |
| REAL → INTEGER, TEXT → INTEGER or REAL, BLOB → TEXT, INTEGER → BOOLEAN | breaking |
| DATETIME → DATE, DATETIME → TIME | breaking |
| TEXT or INTEGER → any date or time type (a format or unit is a guess) | breaking |
| DURATION ↔ INTEGER (a unit is a guess either way) | breaking |
| nullable → NOT NULL declared | breaking |

A breaking change is an error in the change set. `apply` refuses it unless the same change set changes the view (its
declared columns or types), and then lists the view's dependents as affected. The same table classifies data loss in
table rebuilds (section 6). The table and the conversions belong to the engine (E10), so smaltql and smaltts give the
same verdicts and apply the same conversions.

**In rebuilds today** (`src/conversions.ts`, milestone 3): the engine's `append` copies a column's run-time value as
it is, so an integer under a temporal type is copied as that integer (a `date`'s day count would become a
`datetime`'s µs). A rebuild therefore converts each column whose type changes with the engine's cast for the pair
(`cast_text`, `cast_datetime`, `cast_integer_strict`, …), and the pair's entry gives the step's data loss. A pair with
no conversion (a `date` to a `duration`, a list's element type) is an error in the change set: drop the column and add
a new one, or convert the values in a load. Every lossless entry is checked on real values (`test/diff.test.ts`).
smaltts keeps this table until the engine publishes its own (E10).

### 8.4 Materialized views

A materialized view stores its rows in columns fixed when it is created: a refresh after its relation's shape
changes fails (`the query now returns 5 columns, the view has 4`). So when a change set changes a reflecting
materialized view's shape, it adds a step that recreates and refills it (`replaceView`, impact rewrite). An interface materialized
view's shape cannot change without a change to its declaration. A refresh that adapts the stored columns itself is
an engine proposal (E9).

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

### 9.1 Flows

A flow is the unit a pipeline runs: an ordered list of steps, as JSON data, each one of smaltts's operations.

```ts
const nightly = flow('nightly-orders', [
  migrate(schemaV7, { allowDataLoss: 'none' }),
  load(orders, readParquet('s3:orders/*.parquet'), { mode: 'merge', key: ['id'] }),
  refresh('order_totals', { concurrently: true }),
  check(scan(orders).filter((o) => o.total.lt(0)), { expect: 'empty' }),
]);
const preview = await db.plan(nightly);   // every step's change set, plans and estimates; nothing runs
await db.run(nightly, { transaction: 'all' });   // or 'step': each step commits alone, and a run can resume after one
```

- **Steps:** `migrate` (a change set from a desired schema, under a policy), `apply` (a reviewed change set), `load`,
  `refresh`, `check` (a relation that must be empty, or a count within bounds), `analyze`, and `call` (a plugin
  method).
- **A flow previews as data:** each step's change set, plans and estimates, before anything runs.
- **Transactions:** the whole flow, or each step; a run records its steps in the history table, so a failed run
  resumes after the last step that committed.
- **Not smaltts's:** schedules, dependencies between flows, retries, lineage views and their UI. Those are smaltfl's.

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

Status against smaltdb `9cd575c` (2026-11-08). Most of the first round is in the engine, through ADRs 0016–0020:

| # | What | Status |
|---|---|---|
| **F1** | Renames failed once a materialized view existed (the engine's own tables had SQL text) | **fixed** (ADR 0017 §4) |
| **E1** | Catalog as definitions (stenhoor/smaltdb#189) | **done**: `db.catalog` / `catalog()` (ADR 0016 §7) give plan, storage and declared types, collations, keys, indexes, storage and source, and since stenhoor/smaltdb#200 foreign keys, CHECKs and default values, as the schema operations' definitions. smaltts reads every database from the catalog alone. |
| **E11** | Expression texts of definitions without source text follow renames (stenhoor/smaltdb#190) | **done** (stenhoor/smaltdb#202, the owner's choice B): a table defined without source text names its expressions' language (`exprLanguage`), and the engine edits its CHECK texts with that language's source editor on a rename. smaltts sets `exprLanguage: 'smaltts'`, so a rename a CHECK reads is in place again (the smaltts language registered in the engine). |
| **E2** | Structured EXPLAIN with costs (stenhoor/smaltdb#187) | **open**: `plan` mode gives a detail string per node and no estimates; `analyze` gives estimated and actual rows, loops and time, no cost. |
| **E3** | A view reference in plans | **done**: `scan` names a view, bound by its language (ADR 0016 §6). |
| **E4** | More in-place changes, or an engine `rebuildTable` | open |
| **E5** | Impact and dependents from the engine (dry run of a schema operation) | open |
| **E6** | Columnar `values` | **done** (ADR 0016 §5) |
| **E7** | Types and behaviour-named operations | **done**: `bool` and NaN (0018), dates and times (0019), lists and structs (0020), behaviour names (0016 §1). |
| **E8** | Change capture; resumable rebuilds | open; the roadmap's sync groundwork (before the sync plugin) |
| **E9** | A materialized-view refresh that adapts its stored columns | open |
| **F2** | **fixed** (stenhoor/smaltdb#196, for #191) | Values from columns read text in the result format for `date`, `time` and `datetime` but not for `duration` (ADR 0019 §5: text in the result format parses). | Writing a `duration` from its text, which smaltts does now. A plain test in `test/engine-findings.test.ts` guards it. |
| **F4** | **fixed** (stenhoor/smaltdb#199, for #193) | ALTER TABLE could not rename a columnar table. smaltts rebuilt and swap-loaded columnar tables through a row-storage staging table (two copies). | Rebuilds and swap loads of columnar tables, now renamed into place like row tables. A plain test guards it. |
| **F3** | **fixed** (stenhoor/smaltdb#197, for #192) | A JavaScript `Date` in a `date` column of values was taken as a `datetime` (µs), a day millions of years away. smaltts gave the ISO day text instead. | `Date`s into `date` columns, now given as they are. A plain test guards it. |
| **E10** | View interfaces in the engine (stenhoor/smaltdb#188): typed column lists, the conversion table, dependents checked after every DDL (refusing drops and recreation under an interface unless cascaded) | open; the largest, and the one section 8 depends on |

The engine also gained what smaltts did not ask for and now uses: errors with an `origin` and structured fields,
typed results and write counts, `streamPlan`, guaranteed order, and the operations of ADR 0016 §5 (pivot, unpivot,
asof joins, sample, `ignoreNulls`, explode).

## 12. Relationships

- **smaltdb**: smaltts is a client of its public plan, schema and plugin APIs and imports nothing else. Builders use
  `smaltdb/plan` (no engine in a page that only builds plans); the language uses `smaltdb/language`.
- **smaltql, smaltdf**: peers. smaltts shares no code with them; they meet in the engine. Tables made by any of them
  are read by the others, and so are views that declare their columns. smaltdf also creates tables (from a frame's
  shape), writes and stores views: that is DML first, shaped by data. smaltts's part is the schema itself: declared
  keys, indexes and constraints, the catalog, diffs, change sets, interfaces and flows.
- **smaltty and smaltsc**: smaltty, the TypeScript kit, strips and binds the TypeScript users run in smaltui and
  smaltnb. It is also smaltts's TypeScript tooling (owner's decision, 2026-11-10): smaltts has no `typescript`
  dependency, its reference examples are stripped with smaltty, and smaltty's checker is extended to cover smaltts as
  well as smaltdf, which brings back smaltts's static checks. smaltts keeps its `.d.ts` shallow and declaration-only
  so that the checker can read it. smaltsc, the planned schema checker (table and
  column names against a schema), is where smaltts's specs and catalog are the natural input.
- **smaltfl** (owner's decision): the pipeline product **built on smaltts**. smaltts provides the transactional units
  (change sets, loads, views, refreshes, explain) and stays free of orchestration (schedules, DAGs, lineage UI).

## 13. Prototype status

The prototype (`src/`, 178 tests) runs against smaltdb 0.9.0 (`1ce660a`).

- **Milestone 1:** expressions are the engine's operations by their engine names (`fn`, `agg`, and the aliases of
  section 7), the catalog comes from the engine's catalog API, tables and indexes are defined without source text, the
  language serves views only and has its own entry point, and every plan node carries an `origin`.
- **Milestone 2:** the engine's types in specs (section 5.1), with CHECKs, computed defaults and foreign keys.
- **Milestone 3:** the complete differ, with the conversion table of section 8.3.
- **Milestone 4:** saved change sets (gate A): files that hold a change set and the schema it leads to, replayed in
  order with edit, order and drift checks (`src/files.ts`).
- **Milestone 5:** one builder per plan operation (section 7), each compiling to the plan the raw builders give, and
  correlated subqueries at any depth. The engine's operations are typed by a table of signatures
  (`src/signatures.ts`), its other functions loosely, and every call's argument count is checked against the catalog.
- **Milestone 6, part 1:** interface views with a column list (names and order), view sources that follow renames
  column by column (`src/views.ts`), and change sets that check every view over a changed table (section 8).

Static checks run with smaltty's checker (`test/checker.test.ts`): the tests and the reference's examples have no
errors, and every compile-time test (`@ts-expect-error`) is found. Typed interfaces wait on the engine (E10,
milestone 6 part 2), and the client path is untested
(milestone 10). Its dev dependencies were settled by the owner on 2026-11-10 (milestone 0): no `typescript`; smaltty,
Node's types and vitest for development and tests. Engine findings F2–F4 are fixed in smaltdb (#196, #197, #199) and guarded by plain tests.

## 14. Decisions and open questions

### Decided (design interview, 2026-11-06)

1. **smaltfl is built on smaltts**: smaltts is the foundation and stays free of orchestration (section 12).
2. **Schemas come from code and from run time equally**: both are first-class and produce the same specs (section 5).
3. **Engine changes may be proposed** where the design needs them (section 11).
4. **Blocking rebuilds are acceptable for v1**: one transaction holds the writer for the copy. Resumable rebuilds
   (E8) come later.
5. **Views have two purposes**: reflecting by default; interface when declared with a column list, in every language
   (section 8.1).
6. **Type changes are decided by types, never by data**: breaking unless lossless for every value; no row-level
   validation and no errors while reading (section 8.3).
7. **Interfaces are enforced by the engine** (E10), so that DDL from smaltql cannot break what smaltts declared. No
   new SQL syntax: the column list is standard SQL that smaltql already parses.
8. **The relational builder's scope** includes windows, set operations and subqueries, recursion, and merge and
   incremental loads (section 7).
9. **Types come from the engine**: no interim encodings in smaltts (section 5.1).
10. **JavaScript values**: `Date` by default, an option for exact values (2026-11-06). Revised on 2026-11-10: a
    `datetime`'s µs are dropped when it is read as a `Date`, as the engine's `Date` form does; the exact text is an
    option.
11. **smaltts is thin** (smalt-brand's description, 2026-11-08): typed plan and schema operations with structured
    flows, no query semantics of its own (section 7).
12. **Expression names** (2026-11-10): every engine operation as `fn.<engine name>`, with short aliases only where an
    operation has one meaning (section 7).
13. **TypeScript tooling is smaltty's** (2026-11-10): no `typescript` dependency; smaltty's checker is extended to
    cover smaltts. These and the earlier decisions are recorded in [ADR 0023](adr/0023-the-smaltts-language.md),
    accepted on 2026-11-10.
14. **Plugins are typed by descriptors** (2026-11-11, open question 1): a plugin ships a smaltts module with typed
    methods and table functions, and connections and external tables are specs, diffed and applied like tables
    (milestone 9).
15. **Flows wait** (2026-11-11, gate C): milestone 7 (flows) and smaltfl are not started yet; what a flow holds and
    what smaltfl adds are decided when they are.

Superseded by smaltdb ADR 0019 (accepted by the owner on 2026-11-07, after the 2026-11-06 interview): precision as
part of the type, separate local and UTC types, `INTERVAL` with months, and a SQL dialect version. smaltts follows
ADR 0019 (section 5.1).

Decided after the interview (2026-11-10, ADR 0023 decisions 19–21): migrations on disk are live diff *and* saved
change sets (gate A); the engine proposals are open as smaltdb issues (section 11); interfaces ship as names and order
before E10 (gate B).

### Open

1. ~~**Plugins**~~: decided (14).
2. **Typed column lists in SQL**: E10 captures an interface's types when the view is created. Should smaltql also
   accept declared types in the list (`CREATE VIEW v(a INTEGER, b REAL) AS …`), a smaltql addition?
3. **Flows and smaltfl** (gate C): what a flow holds and what smaltfl adds. Not yet (15).
