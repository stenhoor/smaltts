# API reference

The smaltts API specification. It describes the API as designed in [DESIGN.md](DESIGN.md), in the order of its
parts. Each entry says how far it is:

- **Prototype:** in `src/` today, against smaltdb `0b36f33`. Names and shapes may still change when it is re-based on
  smaltdb 0.9.0 ([milestone 1](MILESTONES.md#_1-re-base-on-smaltdb-0-9-0)).
- **Planned (milestone N):** specified here, not built yet; see [MILESTONES.md](MILESTONES.md).

Every TypeScript example on this page that is not marked planned is stripped with
[smaltty](https://stenhoor.github.io/smaltty/) (so it must be erasable TypeScript) and run against the engine by
`test/reference.test.ts`. Static type checks of the examples return with smaltty's checker.

smaltts is not on npm. Its package will be `@smaltworks/smaltts`, published with smaltdb.

## Conventions

- **Build data, then run it.** Builders (`table`, `scan`, `flow`, …) return plain, JSON-safe values and touch no
  database. Only methods of an attached database (`db.apply`, `db.rows`, `db.run`, …) run anything, and they are all
  asynchronous.
- **Names, not positions.** Columns are named everywhere. smaltts resolves names to the engine's positions when it
  compiles a plan, and reports an unknown name then.
- **Thin.** Every operation and expression is one of the engine's. smaltts adds names, types, specs, change sets and
  flows, and no meanings of its own.
- **No SQL.** smaltts reaches the engine only through plans, schema operations, transactions and plugin calls.
- **JavaScript values:** `number` (or `bigint` beyond 2^53), `string`, `Uint8Array`, `null`; `boolean`, `Date`,
  arrays and objects for the engine's `bool`, temporal, list and struct types (planned, milestone 2).

## Attaching

```ts
import { Database } from 'smaltdb/engine';
import { attach, registerSmaltts } from '@smaltworks/smaltts';

registerSmaltts();
const db = attach(Database.openMemory());
```

| | | |
|---|---|---|
| `attach(db)` | A `SmaltDb` over an engine `Database` (`smaltdb/engine`), a client `Database` (`smaltdb`, the engine in a worker), or a `Backend`. | Prototype (the client path is untested until milestone 10) |
| `registerSmaltts()` | Registers smaltts with the engine as the language of the views it stores. Call it where the engine runs; in a worker entry, `defineWorker({ languages: [smalttsLanguage] })`. | Prototype |
| `engineBackend(db)`, `clientBackend(db)`, `backendOf(db)` | The `Backend` interface over each kind of database: `run(statement, params)`, `transaction(fn)`, `callPlugin(…)`. | Prototype |

## Specs and types

A spec is the desired state of a table, as data. Declared in code, it carries a row type; built at run time, it is
the same object with untyped rows.

```ts
import { table, int, real, text, tableSpec, inferTable } from '@smaltworks/smaltts';

const customers = table('customers', {
  id: int().primaryKey(),
  email: text().notNull().unique().collate('nocase'),
  name: text(),
});
const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().indexed(),
  total: real().notNull(),
}, { storage: 'columnar' });

type Order = NonNullable<typeof orders.$row>; // { id: number; customerId: number; total: number }

const products = inferTable('products', [{ sku: 'a-1', price: 9.5 }], { primaryKey: ['sku'] });
const copy = tableSpec({ ...orders, name: 'orders_archive', indexes: [] });
```

### Tables

| | | |
|---|---|---|
| `table(name, columns, options?)` | A spec from column builders, with its row type (`$row`) and insert type (`$insert`: nullable, defaulted and integer-primary-key columns optional). Options: `storage` (`row`, `columnar`), `primaryKey`, `unique`, `indexes`, `foreignKeys`, `renamedFrom`. | Prototype |
| `tableSpec(spec)` | A spec from plain data, checked: duplicate columns, and keys or indexes naming unknown columns, throw. | Prototype |
| `inferTable(name, rows, options?)` | A spec inferred from sample rows: the run-time front door for discovered schemas. | Prototype (booleans, `Date`s, arrays and objects: planned, milestone 2) |
| `TableSpec` fields | `kind: 'table'`, `name`, `columns`, `primaryKey`, `unique`, `indexes`, `foreignKeys`, `storage`, `renamedFrom` | Prototype; `checks` planned (milestone 2) |

### Columns

| Builder | Storage type | Plan type | TypeScript type | |
|---|---|---|---|---|
| `int()` | `INTEGER` | `int` | `number` | Prototype |
| `real()` | `REAL` | `real` (NaN is a value) | `number` | Prototype |
| `numeric()` | `NUMERIC` | `num` | `number` | Prototype |
| `text()` | `TEXT` | `text` | `string` | Prototype |
| `blob()` | `BLOB` | `blob` | `Uint8Array` | Prototype |
| `any()` | `ANY` | `any` | any value | Prototype |
| `bool()` | `BOOLEAN` | `bool` | `boolean` | Planned (milestone 2) |
| `date()` | `DATE` | `date` | `Date` (midnight UTC) | Planned (milestone 2) |
| `datetime({ zone? })` | `DATETIME` | `datetime` (µs) | `Date` | Planned (milestone 2) |
| `time()` | `TIME` | `time` (µs) | `string` (ISO) | Planned (milestone 2) |
| `duration()` | `DURATION` | `duration` (µs) | `string` (ISO 8601) | Planned (milestone 2) |
| `list(inner)` | `LIST` | `list<T>` | `T[]` | Planned (milestone 2) |
| `struct({ … })` | `STRUCT` | `struct<…>` | an object | Planned (milestone 2) |

Every column is nullable unless `.notNull()` or `.primaryKey()`. Modifiers:

| | | |
|---|---|---|
| `.notNull()` | NOT NULL; removes `null` from the row type. | Prototype |
| `.primaryKey()` | The primary key (an `int()` primary key is the rowid, assigned when not given). | Prototype |
| `.unique()` | A unique key on this column. | Prototype |
| `.indexed()` | An index on this column alone, named `<table>_<column>`. | Prototype |
| `.collate(c)` | `binary` (default), `nocase` or `rtrim`. | Prototype |
| `.default(value)` | A constant default; makes the column optional in `$insert`. | Prototype |
| `.renamedFrom(name)` | The column's previous name: the differ renames instead of dropping and adding. | Prototype |
| `.check(pred)`, `.defaultExpr(expr)`, `.references(column, actions)` | CHECK, a computed default, a foreign key. | Planned (milestone 2) |

An index spec is `{ name, columns: [{ column, desc?, collation? }], unique? }`; a foreign key spec is
`{ columns, table, refColumns?, onDelete?, onUpdate? }`.

## Catalog

```ts
import { Database } from 'smaltdb/engine';
import { attach } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
const catalog = await db.catalog();
const tables = catalog.tables.map((t) => t.name);
```

| | | |
|---|---|---|
| `db.catalog({ fresh? })` | The database as specs: `tables`, `views` (`{ name, materialized, definition }`), `table(name)` (tables and materialized views), `view(name)` (a smaltts view's relation). Cached until a change; `fresh` reads again. | Prototype (reads `information_schema`; the engine's catalog API in milestone 1) |
| `readCatalog(backend)` | The same, from a `Backend`. | Prototype |

Reading a database and diffing it against its own catalog gives no steps. Foreign keys, CHECKs and default values join
the comparison when the engine's catalog lists them (planned, milestone 3).

## Change sets

```ts
import { Database } from 'smaltdb/engine';
import { attach, describe, int, real, table } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), total: real().notNull() });

const changes = await db.diff({ tables: [orders] }); // nothing runs
console.log(describe(changes));
await db.apply(changes, { allowDataLoss: 'none', label: 'v1' });
```

| | | |
|---|---|---|
| `db.diff(desired, { prune? })` | A `ChangeSet` that brings the database to `desired` (`{ tables }`). Tables not in `desired` are reported, and dropped only with `prune`. | Prototype |
| `diffCatalog(tables, desired, options?)` | The same, from specs alone, with no database. | Prototype |
| `db.apply(changes, policy?)` | Runs a change set in one transaction if the policy allows it, and records it in `smaltts_history`. Takes a change set parsed from JSON as it is. | Prototype |
| `db.migrate(desired, policy?)` | `diff`, then `apply`. | Prototype |
| `describe(changes)` | The change set as text, for review. | Prototype |
| `db.migrateFiles(dir)` | Replays saved change-set files in order, refusing edited ones. | Planned (milestone 4, after gate A) |

**`ChangeSet`:** `{ steps, diagnostics, impact, dataLoss, checksum }`, JSON. Each step is `{ action, object, impact,
dataLoss, reason, statements }`, where `statements` are the engine statements it runs.

| `action` | Impact | Data loss |
|---|---|---|
| `createTable` | `metadata` | `none` |
| `renameTable`, `renameColumn` (from `renamedFrom`) | `metadata` | `none` |
| `addColumn` (nullable or defaulted, at the end) | `instant` | `none` |
| `dropColumn` | `rewrite` | `certain` |
| `createIndex` | `build` | `none` |
| `dropIndex` | `metadata` | `none` |
| `rebuildTable` (a change the engine can't make in place: type, nullability, collation, default, keys, storage, column order) | `rewrite` | `none`, `possible` or `certain`, by the conversion table of [DESIGN.md 8.3](DESIGN.md#_8-3-type-changes-decided-by-types-never-by-data), never by the data |
| `dropTable` (with `prune`) | `metadata` | `certain` |

**`ApplyPolicy`:** `{ allowDataLoss?: 'none' | 'possible' | 'certain', maxImpact?: Impact, label?: string }`.
`allowDataLoss` defaults to `none`. A change set with error diagnostics is refused.

## Typed plans

A relation is the engine's plan with names instead of positions. Each method is one plan operation, applied in the
order written.

```ts
import { agg, int, param, real, scan, table, text } from '@smaltworks/smaltts';

const customers = table('customers', { id: int().primaryKey(), name: text() });
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull(), total: real().notNull() });

const spend = scan(orders)
  .filter((o) => o.total.gte(param.real('min')))
  .join(scan(customers), (o, c) => o.customerId.eq(c.c_id), { prefix: 'c_' })
  .aggregate((r) => ({ name: r.c_name }), (r) => ({ spent: agg.sum(r.total), orders: agg.count() }))
  .sort('-spent');
```

### Sources

| | | |
|---|---|---|
| `scan(table)` | A table's rows, by spec (typed) or by name (untyped); a name may be a view. | Prototype |
| `values(columns, rows)` | Rows from JavaScript, with column types. | Prototype; typed-array columns planned (milestone 5) |
| `tableFunction(name, args, columns, named?)` | A plugin's table function (`read_csv`, `read_parquet`, …) with the columns it gives. | Prototype |
| `relFromJSON(node)` | A relation from its JSON. | Prototype |

### Operations

| | Plan operation | |
|---|---|---|
| `.filter(pred)` | `filter` | Prototype |
| `.select(fields)`, `.extend(fields)`, `.pick(...names)` | `project` | Prototype |
| `.join`, `.leftJoin`, `.semiJoin`, `.antiJoin` (`prefix` renames the right side's columns) | `join` | Prototype |
| `.rightJoin`, `.fullJoin`, `.crossJoin`, `.asofJoin`, `{ ordered }` | `join` | Planned (milestone 5) |
| `.aggregate(keys, aggs)` | `aggregate` | Prototype; `{ ordered }` planned |
| `.sort('-col', 'col')` | `sort` (stable) | Prototype |
| `.limit(n, offset?)` | `limit` | Prototype; `{ fromEnd }` planned |
| `.distinct()` | `distinct` | Prototype; `{ keep }` planned |
| `.union(other, { all? })` | `setop` | Prototype |
| `.intersect`, `.except`, `.window(…)`, `iterate(seed, step)`, `.pivot`, `.unpivot`, `.sample`, `.explode` | `setop`, `window`, `iterate`, `pivot`, `unpivot`, `sample`, `explode` | Planned (milestone 5) |
| `.toJSON()` | The relation's JSON (what a view stores). | Prototype |

### Expressions

Callbacks receive the row's columns as typed expressions (`Expr<T>`): a misspelt column or a wrong type is a type error (checked once smaltty's checker covers smaltts).

| | | |
|---|---|---|
| Comparisons: `.eq`, `.ne`, `.lt`, `.lte`, `.gt`, `.gte`, `.in([...])`, `.like(p)`, `.isNull()`, `.isNotNull()` | the engine's `cmp_*`, `in_list`, `like`, `isNull` | Prototype (on `sql.*` names until milestone 1) |
| Logic: `.and`, `.or`, `.not()`, `and(...)`, `or(...)` | the logic nodes | Prototype |
| Arithmetic: `.add`, `.sub`, `.mul`, `.mod` | the engine's arithmetic | Prototype |
| `.orElse(v)` (coalesce), `.lower()`, `.upper()`, `.concat(s)`, `.collate(c)` | `coalesce`, `lower`, `upper`, `concat` | Prototype |
| `fn.<operation>(...args)`: any engine operation by its engine name (`fn.div_float`, `fn.div_trunc`, `fn.round_half_even`, `fn.to_zone`, …), typed from a table of signatures | the operation itself | Planned (milestone 5) |
| `lit(v)`, `col(name)` | a literal, a column by name | Prototype |
| `param.int(name)`, `.real`, `.text`, `.any` | a named parameter, given when the plan runs | Prototype |
| `agg.count(e?)`, `.countDistinct`, `.sum`, `.total`, `.avg`, `.min`, `.max` | aggregates | Prototype; the engine's full list planned (milestone 5) |

The prototype's `.div` and `.intDiv` give a meaning of smaltts's own; the thin rule replaces them with
`fn.div_float` and `fn.div_trunc` (milestone 5).

## Views

```ts
import { Database } from 'smaltdb/engine';
import { agg, attach, int, real, registerSmaltts, scan, table } from '@smaltworks/smaltts';

registerSmaltts();
const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull(), total: real().notNull() });
await db.migrate({ tables: [orders] });

await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(100)));
const totals = scan(orders).aggregate((o) => ({ customerId: o.customerId }), (o) => ({ total: agg.sum(o.total) }));
await db.createView('order_totals', totals, { materialized: true, storage: 'columnar' });
await db.refresh('order_totals', { concurrently: true });
```

| | | |
|---|---|---|
| `db.createView(name, rel, { materialized?, storage?, populate?, replace? })` | Stores `rel` as a smaltts view, bound by name each time it is read. | Prototype |
| `columns: [...]` or `columns: true` | Declares the view an **interface**: its column names and order are fixed (`true`: the relation's current columns). Without it the view is **reflecting** and follows the tables. | Planned (milestone 6) |
| `db.refresh(name, { concurrently?, ifChanged? })` | Fills a materialized view again. | Prototype |

What a change underneath does to each kind of view, and which type changes an interface allows, is specified in
[DESIGN.md section 8](DESIGN.md#_8-views-and-materialized-views). Typed interfaces that hold whichever language issues
the DDL need the engine (E10).

## Loads and writes

```ts
import { Database } from 'smaltdb/engine';
import { attach, int, real, scan, table } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull(), total: real().notNull() });
await db.migrate({ tables: [orders] });

await db.load(orders, [{ customerId: 1, total: 10 }]);
await db.load(orders, [{ id: 1, customerId: 1, total: 12 }], { mode: 'upsert' });
await db.load(orders, scan(orders).filter((o) => o.total.gt(0)), { mode: 'swap' });
await db.deleteWhere(orders, (o) => o.total.lt(0));
await db.updateWhere(orders, (o) => ({ total: o.total.mul(2) }), (o) => o.customerId.eq(1));
```

| | | |
|---|---|---|
| `db.load(table, source, { mode? })` | Writes a relation's rows or JavaScript rows into a table, matched by column name. Returns `{ rows }`. | Prototype |
| `mode: 'append'` (default), `'upsert'`, `'replace'`, `'swap'` | Add; add and update on a key conflict; delete all then add, in one transaction; build a copy and switch it in. | Prototype |
| `mode: 'merge'` with `key` | Insert, update or delete per match. | Planned (milestone 7) |
| `db.deleteWhere(table, pred)`, `db.updateWhere(table, set, pred)` | Delete or update the rows where `pred` is true. | Prototype |
| `returning` on writes | The written rows. | Planned (milestone 5) |

## Flows

<!-- spec:planned -->
```ts
const nightly = flow('nightly-orders', [
  migrate(schemaV7, { allowDataLoss: 'none' }),
  load(orders, tableFunction('read_parquet', ['s3:orders/*.parquet'], orderColumns), { mode: 'merge', key: ['id'] }),
  refresh('order_totals', { concurrently: true }),
  check(scan(orders).filter((o) => o.total.lt(0)), { expect: 'empty' }),
]);
const preview = await db.plan(nightly);
await db.run(nightly, { transaction: 'step' });
```

| | | |
|---|---|---|
| `flow(name, steps)` | A flow: an ordered list of steps, as JSON. | Planned (milestone 7) |
| Steps: `migrate(desired, policy)`, `apply(changes, policy)`, `load(table, source, options)`, `refresh(view, options)`, `check(rel, { expect })`, `analyze(table?)`, `call(plugin, method, args)` | Each is one of the operations above, as data. | Planned (milestone 7) |
| `db.plan(flow)` | Every step's change set, plans and estimates; nothing runs. | Planned (milestone 7) |
| `db.run(flow, { transaction: 'all' \| 'step' })` | Runs the flow in one transaction, or each step in its own, recorded in the history so a failed run resumes after the last committed step. | Planned (milestone 7) |

Schedules, dependencies between flows and retries are smaltfl's, not smaltts's.

## Plan review

```ts
import { Database } from 'smaltdb/engine';
import { attach, int, real, scan, table } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull().indexed(), total: real().notNull() });
await db.migrate({ tables: [orders] });
await db.analyze();

const rel = scan(orders).filter((o) => o.customerId.eq(2)).pick('total');
const { plan, fields, params } = await db.compile(rel);
const measured = await db.explain(rel, { analyze: true });
console.log(String(measured));
```

| | | |
|---|---|---|
| `db.compile(rel)` | `{ plan, fields, params }`: the engine plan, its output columns and its parameter names in order. | Prototype |
| `db.rows(rel, params?, { signal? })` | Runs a relation; rows are objects typed by the relation. | Prototype |
| `db.explain(rel, { analyze?, params? })` | The physical plan as a tree of `ExplainNode` (`detail`, `estimatedRows`, `actual: { rows, loops, timeMs }`, `children`); `String(…)` renders it. | Prototype |
| Costs and structured fields per node (operator, table, index) | Asserting a plan's shape from fields, not text. | Planned (milestone 8, needs smaltdb E2) |
| `db.analyze(table?)` | Gathers statistics, so plans can be estimated. | Prototype |

## Plugins and transactions

```ts
import { Database } from 'smaltdb/engine';
import { attach } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
await db.transaction(async (tx) => {
  await tx.analyze();
});
const io = db.plugin('@smaltdb/io');
```

| | | |
|---|---|---|
| `db.plugin(name).call(method, ...args)` | Calls a plugin's method. | Prototype |
| Typed plugin descriptors; connections and external tables as specs | | Planned (milestone 9) |
| `db.transaction(fn)` | Runs `fn` in one transaction; nested calls are savepoints (in process). | Prototype |

## The language

| | | |
|---|---|---|
| `smalttsLanguage` | smaltts's `SmaltLanguage`: binds the views it stores (their source is the relation's JSON) and edits its sources when ALTER TABLE renames, adds or drops columns. | Prototype |
| `LANGUAGE` | `'smaltts'`, the language name sources record. | Prototype |
| Tables and indexes without source text; the language for views only | | Planned (milestone 1) |

## Errors

| | | |
|---|---|---|
| Unknown names | `compile` throws, naming the column and the columns that exist. | Prototype |
| Policy refusals | `apply` throws, listing each refused step with its impact and data loss. | Prototype |
| A failed step | `apply` throws `<action> <object>: <engine message>`, with the engine error as `cause`; nothing is applied. | Prototype |
| `origin` | Engine errors name the smaltts call that built the failing node (smaltdb ADR 0016 §10). | Planned (milestone 1) |
