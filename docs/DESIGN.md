# smaltts design

- **Status:** proposed, for the owner's review. Decisions from the design interview are recorded in section 14. A
  prototype of sections 4–9 is in `src/` and runs against the in-process smaltdb engine (`test/smaltts.test.ts`); it
  predates the view decisions of section 8 (see section 13).
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

**Scope** (owner's decision): DDL comes first, but the relational builder covers what pipelines need. Beyond the
operations above, v1 adds:

| Group | Operations | Engine plan |
|---|---|---|
| Windows | `rank`, `rowNumber`, `denseRank`, `lag`, `lead`, `firstValue`, aggregates over frames: dedupe, latest-row and slowly changing dimensions | `window` |
| Set operations, subqueries | `intersect`, `except`; `exists`, `in` and scalar subqueries, correlated by closing over outer columns | `setop`, `subquery`, `inSubquery` |
| Recursion | `recursive(seed, (self) => step)` for trees and graphs | `iterate`, `working` |
| Merge and incremental loads | a merge load (insert, update or delete per match) and loads from captured changes | `append` with `upserts`, `update`, `delete`; change capture needs the engine (E8) |

## 8. Views and materialized views

```ts
// A reflecting view (the default): its columns follow the tables it reads.
await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(100)));
// An interface view: its columns are declared, and are a contract.
await db.createView('order_totals', byCustomer, { columns: ['customerId', 'total'], materialized: true, storage: 'columnar' });
await db.createView('daily', byDay, { columns: true });   // declare the relation's current columns as the interface
await db.refresh('order_totals', { concurrently: true });
```

A view's source is its relation's JSON, in the language `smaltts`. The engine binds a materialized view through
smaltts when it fills it; a plain view is read by smaltts by inlining its relation (plans have no view reference
yet: E3). When ALTER TABLE renames a column, the engine asks smaltts to edit every smaltts source that refers to it.

### 8.1 Two purposes: reflecting and interface views

A view has one of two purposes, and declares which:

| | Reflecting view (the default) | Interface view |
|---|---|---|
| Declared by | nothing | a **column list**: `columns: ['a', 'b']`, or `columns: true` for the relation's current columns |
| Its columns | follow the tables it reads | are a contract: names, order and types |
| A column it reads is renamed | a column it passes through takes the new name; columns it names itself keep their names | the view reads the new name; its output does not change |
| A column is added to a table it reads in full | the view gains the column | the view does not change |
| A type changes underneath | the view's column takes the new type | allowed only by a lossless conversion (8.3), which the view applies; otherwise breaking |
| A column it reads is dropped | breaking | breaking |
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
| BOOL → INTEGER, DATE → TIMESTAMP (when the engine has these types, E7) | lossless: the view converts |
| NOT NULL → nullable declared | lossless |
| INTEGER → REAL | breaking: not exact beyond ±2^53 |
| REAL → INTEGER, TEXT → INTEGER or REAL, BLOB → TEXT, TIMESTAMP → DATE, INTEGER → BOOL | breaking |
| nullable → NOT NULL declared | breaking |

A breaking change is an error in the change set. `apply` refuses it unless the same change set changes the view (its
declared columns or types), and then lists the view's dependents as affected. The same table classifies data loss in
table rebuilds (section 6). The table and the conversions belong to the engine (E10), so smaltql and smaltts give the
same verdicts and apply the same conversions.

### 8.4 Materialized views

A materialized view stores its rows in columns fixed when it is created: a refresh after its relation's shape
changes fails (`the query now returns 5 columns, the view has 4`). So when a change set changes a reflecting
materialized view's shape, it adds a step that recreates and refills it (impact rewrite). An interface materialized
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
| **E8** | engine | **Change capture** (the roadmap's sync groundwork) and **resumable rebuilds** that do not hold the writer for a whole copy. | Incremental loads and merge loads in smaltfl; later, rebuilding large OPFS tables (v1 accepts blocking rebuilds). |
| **E9** | engine | **Refresh that adapts a materialized view's stored columns** when its query's shape changes, instead of failing. | Reflecting materialized views without a recreate step. |
| **E10** | engine | **View interfaces in the engine**: (1) the declared column list carries types, captured from the bound query when the view is created; (2) a published **conversion table** (each pair of types: lossless or breaking, and the conversion), used when binding a view and by languages to classify changes; (3) **dependents checked after every DDL**, not only ALTER: dropping or recreating a table under an interface view is refused unless the statement asks to cascade, and dropping or replacing an interface view itself needs an explicit option. | Interfaces that hold whichever language issues the DDL (section 8.2); identical verdicts in smaltql and smaltts. |

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

The prototype predates section 8: it keeps a view's names on a rename (it should follow the table unless the view
declares a column list), has no column lists, and classifies every type change in a rebuild as possible data loss
(it should use the conversion table of 8.3). These are the next prototype changes.

Not yet: the worker client (written, untested: needs a browser test), windows, recursion, subqueries, foreign-key
comparison (E1), plugin descriptors with typed methods, external tables and connections as specs, a job API for
long rebuilds, and a published package (the name and smaltdb pin follow the sibling repositories).

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

### Open

1. **Migrations on disk.** How a release reaches many databases:
   - *live diff only*: each database diffs the desired schema against itself when it opens and applies under a
     policy; the only record is `smaltts_history` in each database;
   - *live diff and saved change sets*: CI saves each reviewed change set as a JSON file in the application's
     repository, and databases replay the files they have not applied, in order, so every database runs exactly the
     reviewed steps (checksums catch edited files); live diff stays for development and pipelines;
   - *saved change sets only*: live diff only writes new files and detects drift.
2. **Plugins**: typed descriptors (a plugin ships a smaltts module with typed methods and table functions), or the
   generic `plugin(name).call()` only? Should connections and external tables be specs that are diffed and applied?
3. **Engine proposals**: open F1, E1–E10 as smaltdb issues now, and in which order? (E10 first for views; F1 is a bug.)
4. **Boolean and date types**: wait for the engine's (E7), or add smaltts logical types before then?
5. **Typed column lists in SQL**: E10 captures an interface's types when the view is created. Should smaltql also
   accept declared types in the list (`CREATE VIEW v(a INTEGER, b REAL) AS …`), a smaltql addition?
