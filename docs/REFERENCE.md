# API reference

The smaltts API specification. It describes the API as designed in [DESIGN.md](DESIGN.md), in the order of its
parts. Each entry says how far it is:

- **Prototype:** in `src/` today, against smaltdb 0.9.0 (`1ce660a`). Names and shapes may still change before smaltts's
  first release.
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
import { attach } from '@smaltworks/smaltts';
import { registerSmaltts } from '@smaltworks/smaltts/language';

registerSmaltts();
const db = attach(Database.openMemory());
```

In a page, the engine runs in a worker: the worker entry starts smaltdb's engine with smaltts's language registered,
and the page attaches smaltdb's client.

<!-- spec:browser -->
```ts
// db-worker.ts
import { defineSmalttsWorker } from '@smaltworks/smaltts/worker';
defineSmalttsWorker();

// the page
import { open } from 'smaltdb';
import { attach } from '@smaltworks/smaltts';
const db = attach(await open('app.db', { worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }) }));
```

| | | |
|---|---|---|
| `attach(db)` | A `SmaltDb` over an engine `Database` (`smaltdb/engine`), a client `Database` (`smaltdb`, the engine in a worker), or a `Backend`. Through the client it gives what it gives in process: the same scenarios run both ways in Node and in Chromium, Firefox and WebKit (`test/client.test.ts`, `npm run test:browser`). | Prototype |
| `defineSmalttsWorker(options?)` (from `@smaltworks/smaltts/worker`) | Starts smaltdb's engine worker (`defineWorker` from `smaltdb/worker-runtime`) with smaltts's language registered, and the languages, plugins and parallel-reader setting of `options`. | Prototype |
| `registerSmaltts()` (from `@smaltworks/smaltts/language`) | Registers smaltts with the engine as the language of the views it stores, and of its tables' CHECK texts, which the engine edits on a column rename (smaltdb#190; without it a renamed column's CHECK keeps the old name in its text, and the next diff rebuilds the table). Call it where the engine runs in process; in a worker, `defineSmalttsWorker()` does it. | Prototype |
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
| `inferTable(name, rows, options?)` | A spec inferred from sample rows: the run-time front door for discovered schemas. Booleans are `BOOLEAN`, `Date`s `DATETIME`, arrays `LIST` (an empty array tells nothing of its elements), objects `STRUCT`; integers and reals widen to `REAL`, anything else mixed to `ANY`. | Prototype |
| `TableSpec` fields | `kind: 'table'`, `name`, `columns` (`name`, `type`, `planType` for a list or struct, `notNull`, `collation`, `default`, `renamedFrom`), `primaryKey`, `unique`, `indexes`, `foreignKeys`, `storage`, `renamedFrom` | Prototype; `checks` planned (milestone 2) |

### Columns

| Builder | Storage type | Plan type | TypeScript type | |
|---|---|---|---|---|
| `int()` | `INTEGER` | `int` | `number` | Prototype |
| `real()` | `REAL` | `real` (NaN is a value) | `number` | Prototype |
| `numeric()` | `NUMERIC` | `num` | `number` | Prototype |
| `text()` | `TEXT` | `text` | `string` | Prototype |
| `blob()` | `BLOB` | `blob` | `Uint8Array` | Prototype |
| `any()` | `ANY` | `any` | any value | Prototype |
| `bool()` | `BOOLEAN` | `bool` | `boolean` | Prototype |
| `date()` | `DATE` | `date` | `Date` (midnight UTC) | Prototype |
| `datetime()` | `DATETIME` | `datetime` (µs) | `Date` (ms: µs are dropped) | Prototype; a column's default zone (`{ zone }`) is planned |
| `time()` | `TIME` | `time` (µs) | `string` (`12:30:00`) | Prototype |
| `duration()` | `DURATION` | `duration` (µs) | `string` (ISO 8601, `PT1H30M`) | Prototype |
| `list(inner)` | `LIST` | `list<T>` | `T[]` | Prototype |
| `struct({ … })` | `STRUCT` | `struct<…>` | an object | Prototype |

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
| `.check(pred, name?)` | A CHECK on this column: `pred` receives the column (`int().check((n) => n.gt(0), 'positive')`). | Prototype |
| `.defaultExpr(expr)` | A computed default: an expression over no columns, evaluated for each row written (`fn.random()`); makes the column optional in `$insert`. | Prototype |
| `.references(table, column?, { onDelete?, onUpdate?, name? })` | A foreign key from this column to `column` of `table` (absent: its primary key). The engine enforces foreign keys by default. | Prototype |
| `table(…, { checks: (row) => … })` | CHECKs over the row: a list, or named (`{ affordable: row.price.lte(1000) }`). | Prototype |

```ts
import { fn, int, real, table, text } from '@smaltworks/smaltts';

const customers = table('customers', { id: int().primaryKey(), name: text().notNull() });
const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().references(customers, 'id', { onDelete: 'CASCADE' }),
  qty: int().notNull().check((q) => q.gt(0), 'qty_positive'),
  price: real().notNull(),
  priority: int().defaultExpr(fn.abs(-5)),
}, { checks: (r) => ({ affordable: r.price.lte(1000) }) });
```

An index spec is `{ name, columns: [{ column, desc?, collation? }], unique? }`; a foreign key spec is
`{ name?, columns, table, refColumns?, onDelete?, onUpdate? }`; a CHECK spec is `{ name?, expr }`, its expression as
JSON (`ExprNode`). CHECKs and computed defaults are stored with their expression's JSON as their text, so they are read
back exactly; CHECKs written in another language are not read into specs.

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
| `db.catalog({ fresh? })` | The database as specs, from the engine's catalog API: `tables`, `views` (`{ name, materialized, language, definition }`), `table(name)` (tables and materialized views), `view(name)` (a smaltts view's relation), `foreignView(name)` (another language's view's column names). Cached until a change; `fresh` reads again. | Prototype |
| `specOfCatalogTable(table)` | One of the engine's catalog tables (`CatalogTable`) as a spec. | Prototype |
| `readCatalog(backend)` | The same, from a `Backend`. | Prototype |

Reading a database and diffing it against its own catalog gives no steps, constraints and computed defaults included.

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
| `diffCatalog(tables, desired, options?, views?)` | The same, from specs alone, with no database; with a catalog's `views`, the views are checked as `db.diff` checks them. | Prototype |
| `db.apply(changes, policy?)` | Runs a change set in one transaction if the policy allows it, and records it in `smaltts_history`. Takes a change set parsed from JSON as it is. | Prototype |
| `db.migrate(desired, policy?)` | `diff`, then `apply`. | Prototype |
| `describe(changes)` | The change set as text, for review. | Prototype |
| `changeSetFile(changes, schema)` | A change set to save as a file, with the schema it leads to (the `desired` it was diffed against) and a checksum of both. `JSON.stringify` it. | Prototype |
| `parseChangeSetFile(text, name?)` | A file's text as a `ChangeSetFile`; refuses text that isn't one, or one edited after it was saved. | Prototype |
| `db.migrateFiles(files, policy?)` | Replays the saved files (`{ name, text }[]`) the database hasn't applied, in name order, each in its own transaction, and returns `{ applied, skipped, drift }`. | Prototype |

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
| `rebuildTable` (a change the engine can't make in place: type, nullability, collation, default, keys, CHECKs, foreign keys, storage, column order, or renaming a column a computed default reads) | `rewrite` | `none`, `possible` or `certain`, by the conversion table of [DESIGN.md 8.3](DESIGN.md#_8-3-type-changes-decided-by-types-never-by-data), never by the data |
| `dropTable` (with `prune`) | `metadata` | `certain` |
| `replaceView` (a reflecting materialized view whose columns change; a view reading a column a rebuild renames): drops the view and creates it again with its source as it should read, a materialized one filled again | `rewrite` (materialized), `metadata` | `none` |

**Type changes** in a rebuild are converted with the engine's cast for the pair and classified by the conversion table
([DESIGN.md 8.3](DESIGN.md#_8-3-type-changes-decided-by-types-never-by-data)): lossless pairs (`INTEGER` to
`NUMERIC` or `TEXT`, `BOOLEAN` to `INTEGER`, `DATE` to `DATETIME`, any date or time to `TEXT`, `TEXT` to `BLOB`, …) are
data loss `none`; pairs that can change or fail (`REAL` to `INTEGER`, `TEXT` to a number or a date, `DATETIME` to
`DATE`) are `possible`; a pair with no conversion is an error diagnostic, and `apply` refuses the change set. A
NOT NULL column added with no default makes a rebuild `possible` (it fails on a table with rows). Columnar tables are
rebuilt as row tables are: the new table is built beside the old one and renamed into its place.

**Views over a changed table** are checked against the change set (see [Views](#views)):

| | Diagnostic | Step |
|---|---|---|
| A view the change set breaks (a column it names or filters on is dropped, a table it reads is dropped) | `error`: `apply` refuses | |
| An interface's column changes type: lossless to its type / otherwise | `warning` / `error` | |
| A reflecting view's columns change (renamed, added, dropped, retyped) | `info`, with the old and new columns | `replaceView` if materialized |
| A view reads a column a rebuild renames (the engine edits only in-place renames) | | `replaceView` |

**Saved change sets** (gate A: live diff, and saved change sets as well). CI saves each reviewed change set as a file;
every database replays the files it hasn't applied, so each runs exactly the reviewed steps. `migrateFiles` refuses:

- a file edited after it was saved (its checksum), or one changed since it was applied (the history's checksum);
- a file that sorts before one already applied (added out of order);
- a database that has drifted from the history: before a file runs, the database must have the previous file's schema
  (an empty one before the first), compared with `prune`, so a table added outside the files is drift.

After the last file, `drift` is the change set from the database to that file's schema: no steps when they agree. The
history table records each file's name and checksum. The default policy allows what the reviewed files do; pass one
to refuse more. Files are given by name and text, so smaltts uses no file API: in Node, read a directory with
`readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))`.

```ts
import assert from 'node:assert/strict';
import { Database } from 'smaltdb/engine';
import { attach, changeSetFile, int, real, table, text } from '@smaltworks/smaltts';

const v1 = { tables: [table('orders', { id: int().primaryKey(), total: real().notNull() })] };
const v2 = { tables: [table('orders', { id: int().primaryKey(), amount: real().notNull().renamedFrom('total'), note: text() })] };

// In CI: diff a development database against each version, and save each change set.
const dev = attach(Database.openMemory());
const files = [];
for (const [i, desired] of [v1, v2].entries()) {
  const changes = await dev.diff(desired);
  files.push({ name: `000${i + 1}.json`, text: JSON.stringify(changeSetFile(changes, desired)) });
  await dev.apply(changes);
}

// Wherever the application runs: replay what this database hasn't applied.
const db = attach(Database.openMemory());
await db.migrateFiles(files.slice(0, 1));
const { applied, skipped, drift } = await db.migrateFiles(files);
assert.deepEqual([skipped, applied, drift.steps], [['0001.json'], ['0002.json'], []]);
```

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
| `values(columns, rows)` | Rows from JavaScript, with column types. | Prototype |
| `fromColumns(columns, arrays)` | Rows given as one array per column: typed arrays, arrays of values, or either with a null bitmap `{ data, nulls }`. For loads and queries: a view can't store typed arrays. | Prototype |
| `tableFunction(name, args, columns, named?)` | A plugin's table function (`read_csv`, `read_parquet`, …) with the columns it gives. | Prototype |
| `relFromJSON(node)` | A relation from its JSON. | Prototype |

### Operations

| | Plan operation | |
|---|---|---|
| `.filter(pred)` | `filter` | Prototype |
| `.select(fields)`, `.extend(fields)`, `.pick(...names)` | `project` | Prototype |
| `.join`, `.leftJoin`, `.rightJoin`, `.fullJoin`, `.semiJoin`, `.antiJoin` (`(l, r) => pred`), `.crossJoin`; `{ prefix, ordered }` (`prefix` renames the right side's columns; `ordered` keeps the left order and each left row's matches in the right order) | `join` | Prototype |
| `.asofJoin(right, (l, r) => [leftKey, rightKey], { direction?, tolerance?, on?, prefix?, ordered? })`: each row with the right row whose key is nearest its own (`backward`, the default: at or below it; `forward`; `nearest`), or NULLs | `join` (`asof`) | Prototype |
| `.aggregate(keys, aggs, { ordered? })` (`ordered`: groups in the order of their first row) | `aggregate` | Prototype |
| `.sort('-col', 'col')` | `sort` (stable) | Prototype |
| `.limit(n, offset?, { fromEnd? })` (`n` and `offset` may be parameters; `fromEnd`: the last `n` rows before the last `offset`, in order) | `limit` | Prototype |
| `.distinct({ on?, keep?, ordered? })` (`on`: the columns that decide duplicates; `keep`: `'first'` or `'last'` of each set) | `distinct` | Prototype |
| `.union(other, { all? })`, `.intersect(other)`, `.except(other)` | `setop` | Prototype |
| `.sample({ count } \| { fraction }, { replace?, seed? })` | `sample` | Prototype |
| `.explode(column, { position?, emptyAsNull?, keepNulls? })`: one row per element of a list column (`position` names a column with the element's position) | `explode` | Prototype |
| `.pivot({ keys, on, values, aggs, ordered? })`: a column per value of `on` (named by the value, or `value_agg` with more than one aggregate) | `pivot` | Prototype |
| `.unpivot(columns, { keep?, name?, value? })`: a row per column, with its name and value (`keep` defaults to the other columns) | `unpivot` | Prototype |
| `.window((r) => calls, { partition?, order?, frame? })`: every column, then one per call (`agg.row_number()`, `agg.lag(r.x, { ignoreNulls: true })`, `agg.sum(r.x)`, …). `partition` lists columns, `order` takes `sort`'s keys, `frame` is the engine's (`{ unit: 'ROWS', start: { kind: 'preceding', offset: 1 }, end: { kind: 'currentRow' } }`) | `window` | Prototype |
| `iterate(init, (previous) => step, { distinct?, name? })`: `init`'s rows, then the step's over the rows the previous step gave, until a step gives none (`distinct` drops rows given before) | `iterate`, `working` | Prototype |
| `.toJSON()` | The relation's JSON (what a view stores). | Prototype |

Names resolve when the plan is compiled; an error names the call (`except: the inputs have different columns …`).

Subqueries read the enclosing rows' columns by closure, at any depth; the JSON records the depth (`{ "k": "col",
"name": "id", "outer": 1 }`):

```ts
import assert from 'node:assert/strict';
import { Database } from 'smaltdb/engine';
import { agg, attach, exists, int, scan, table, text } from '@smaltworks/smaltts';

const authors = table('authors', { id: int().primaryKey(), name: text() });
const books = table('books', { id: int().primaryKey(), authorId: int(), year: int() });
const db = attach(Database.openMemory());
await db.migrate({ tables: [authors, books] });
await db.load(authors, [{ id: 1, name: 'ann' }, { id: 2, name: 'bo' }]);
await db.load(books, [{ id: 1, authorId: 1, year: 2001 }, { id: 2, authorId: 1, year: 2010 }]);

// Authors with a book, and each book's place among its author's, newest first.
const published = scan(authors).filter((a) => exists(scan(books).filter((b) => b.authorId.eq(a.id))));
assert.deepEqual(await db.rows(published), [{ id: 1, name: 'ann' }]);
const ranked = scan(books).window(() => ({ place: agg.row_number() }), { partition: ['authorId'], order: ['-year'] });
assert.deepEqual((await db.rows(ranked)).map((b) => b.place), [2, 1]);
```

```ts
import assert from 'node:assert/strict';
import { Database } from 'smaltdb/engine';
import { agg, attach, int, list, scan, table, text } from '@smaltworks/smaltts';

const posts = table('posts', { id: int().primaryKey(), author: text(), tags: list(text()) });
const db = attach(Database.openMemory());
await db.migrate({ tables: [posts] });
await db.load(posts, [{ id: 1, author: 'ann', tags: ['db', 'ts'] }, { id: 2, author: 'bo', tags: ['db'] }]);

// One row per tag, then a column per author.
const byTag = scan(posts)
  .explode('tags')
  .pivot({ keys: (r) => ({ tag: r.tags }), on: (r) => r.author, values: ['ann', 'bo'], aggs: () => ({ n: agg.count() }), ordered: true });
assert.deepEqual(await db.rows(byTag), [{ tag: 'db', ann: 1, bo: 1 }, { tag: 'ts', ann: 1, bo: 0 }]);
```

### Expressions

Callbacks receive the row's columns as typed expressions (`Expr<T>`): a misspelt column or a wrong type is a type error (checked once smaltty's checker covers smaltts).

| | | |
|---|---|---|
| `fn.<name>(...args)`: every engine operation and scalar function, by its engine name (`fn.add`, `fn.add_checked`, `fn.div_float`, `fn.div_trunc`, `fn.lower_unicode`, `fn.round_half_even`, `fn.to_zone`, …), typed by the engine's result type | the operation itself | Prototype |
| Comparisons: `.eq`, `.ne`, `.lt`, `.lte`, `.gt`, `.gte`, `.is`, `.isNot`, `.in([...])`, `.like(p)`, `.glob(p)`; the other side may be nullable (a NOT NULL column compared with a nullable one) | `cmp_eq` … `cmp_ge`, `cmp_is`, `cmp_is_not`, `in_list`, `like`, `glob`; results are the engine's `bool` | Prototype |
| Logic and NULLs: `.and`, `.or`, `.not()`, `and(...)`, `or(...)`, `not(x)`, `.isNull()`, `.isNotNull()`, `.orElse(v)` | the logic nodes, `isNull`, `coalesce` | Prototype |
| `.collate(c)` | the collation a comparison compares text by | Prototype |
| `lit(v)`, `col(name)` | a literal (a JavaScript boolean is a `bool`; a `Date` is a `date` or a `datetime`, whichever it is compared with), a column by name | Prototype |
| `param.int(name)`, `.real`, `.text`, `.bool`, `.date`, `.datetime`, `.any` | a named parameter, given when the plan runs (a `Date` for `.date` and `.datetime`) | Prototype |
| `agg.<name>(...args, { distinct?, filter?, ignoreNulls? })`: every engine aggregate and window function by its engine name (`agg.sum`, `agg.count()` for rows, `agg.first`, `agg.median`, `agg.implode`; in `window()` also `agg.row_number`, `agg.rank`, `agg.lag`, `agg.lead`, …) | the aggregate or window call itself | Prototype |
| `caseWhen([[when, then], …], otherwise?)` | the `case` node | Prototype |
| `exists(rel)`, `scalar(rel)`, `x.in(rel)`: subqueries, whose callbacks may read the enclosing rows' columns (a correlated reference, at any depth) | the `subquery` and `inSubquery` nodes | Prototype |

**Typed by a table of signatures.** The engine's own operations (`add`, `sub`, the comparisons, the casts, `like`, …)
have TypeScript signatures (`src/signatures.ts`): `fn.add` takes two numbers, or a time and a duration; `fn.sub` of two
times is a duration. Other functions are typed loosely, with the engine's result type, so one the engine adds is usable
at once. Compiling checks every call's argument count against the engine's catalog and names the call
(`fn.add: takes 2 arguments, not 3`).

**Aliases only where an operation has one meaning** (ADR 0023, owner's decision 15). Arithmetic (`fn.add` or
`fn.add_checked`), division (`fn.div_float`, `fn.div_trunc`, `fn.div_floor`), case (`fn.lower` or `fn.lower_unicode`)
and concatenation (`fn.text_concat` or `fn.concat`) have more than one, so they are called by their engine names.
`fn` and `agg` are generated from the engine's catalog (`src/functions.ts`, by `scripts/functions.mjs`), and a test
fails when the engine's list changes.

## Views

```ts
import assert from 'node:assert/strict';
import { Database } from 'smaltdb/engine';
import { agg, attach, int, real, scan, table } from '@smaltworks/smaltts';
import { registerSmaltts } from '@smaltworks/smaltts/language';

registerSmaltts();
const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull(), total: real().notNull() });
await db.migrate({ tables: [orders] });
await db.load(orders, [{ customerId: 1, total: 150 }]);

// A view: it keeps the columns it gives now (its interface, which the engine holds).
await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(100)));
// A view with a column list: these columns, in this order.
const totals = scan(orders).aggregate((o) => ({ customerId: o.customerId }), (o) => ({ total: agg.sum(o.total) }));
await db.createView('order_totals', totals, { columns: ['customerId', 'total'], materialized: true, storage: 'columnar' });
await db.refresh('order_totals', { concurrently: true });

// Rename a column and add one: both views keep their columns, by the names they had.
await db.migrate({ tables: [table('orders', { id: int().primaryKey(), customer: int().notNull().renamedFrom('customerId'), total: real().notNull(), note: real() })] });
assert.deepEqual(Object.keys((await db.rows(scan('big_orders')))[0]!), ['id', 'customerId', 'total']);
await db.refresh('order_totals');
assert.deepEqual(await db.rows(scan('order_totals')), [{ customerId: 1, total: 150 }]);
```

| | | |
|---|---|---|
| `db.createView(name, rel, { columns?, materialized?, storage?, populate?, replace? })` | Stores `rel` as a smaltts view, bound by name each time it is read. | Prototype |
| `columns: [...]` or `columns: true` | These of the relation's columns, in this order (`true`: all of them as they are now). Without it, the view gives the relation's columns as they are now. Either way the engine keeps the view's **interface**: its columns' names, types and whether they can be NULL ([smaltdb ADR 0027](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0027-view-interfaces.md)). A column the relation doesn't have, or one listed twice, is refused. | Prototype |
| `db.dropView(name, { materialized?, ifExists? })` | Drops a view. | Prototype |
| `db.refresh(name, { concurrently?, ifChanged? })` | Fills a materialized view again. | Prototype |
| `db.catalog().views` | Each view's `name`, `materialized`, `language`, `definition`, its `interface` (`{ name, type, notNull }` per column), `columns` when it has a column list (in any language), `storage` when materialized, and `reflects` for a view made before interfaces. | Prototype |

What a change underneath does to a view (the engine holds its interface, whichever language issues the DDL):

| | A view | A view made before interfaces (`reflects`) |
|---|---|---|
| A column it reads is renamed | it reads the new name; its columns keep their names | a column it passes through takes the new name; a column it names itself (`select`, `pick`, an aggregate) keeps its name |
| A column is added to a table it reads in full | it doesn't change (a note in the change set) | it gains the column (a materialized view is recreated: `replaceView`) |
| A column it gives is dropped | an error in the change set, and the engine refuses the drop | it loses the column (a materialized view is recreated) |
| A column it names or filters on is dropped | an error in the change set | an error in the change set (the engine refuses the drop too) |
| A column's type changes | converted by the engine to the interface's type when that is lossless (a note); otherwise an error | the view gives the new type |

A rename follows the column, not its name: a column of the same name in another table the view reads is untouched.
smaltts refuses a change set that would break a view rather than dropping the view (the owner's decision); drop the
view first, by hand. Which type changes are lossless is the engine's conversion table (`conversion` in `smaltdb/plan`,
[DESIGN.md section 8.3](DESIGN.md#_8-3-type-changes-decided-by-types-never-by-data)).

## Loads and writes

```ts
import { Database } from 'smaltdb/engine';
import { attach, fn, int, real, scan, table } from '@smaltworks/smaltts';

const db = attach(Database.openMemory());
const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull(), total: real().notNull() });
await db.migrate({ tables: [orders] });

await db.load(orders, [{ customerId: 1, total: 10 }]);
await db.load(orders, [{ id: 1, customerId: 1, total: 12 }], { mode: 'upsert' });
await db.load(orders, scan(orders).filter((o) => o.total.gt(0)), { mode: 'swap' });
await db.deleteWhere(orders, (o) => o.total.lt(0));
await db.updateWhere(orders, (o) => ({ total: fn.mul(o.total, 2) }), (o) => o.customerId.eq(1));
```

| | | |
|---|---|---|
| `db.load(table, source, { mode? })` | Writes a relation's rows or JavaScript rows into a table, matched by column name. JavaScript rows go to the engine as columns of values, so booleans, `Date`s, arrays and objects go in as they are. Returns `{ rows }`. | Prototype |
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
| `db.rows(rel, params?, { signal?, temporal? })` | Runs a relation; rows are objects typed by the relation. `date` and `datetime` values are `Date`s (a `datetime`'s µs are dropped: owner's decision, 2026-11-10); `{ temporal: 'text' }` gives the engine's exact text instead, and the row type says `string`. Lists and structs are arrays and objects. | Prototype |
| `db.explain(rel, { analyze?, params? })` | The physical plan as a tree of `ExplainNode` (`detail`, `estimatedRows`, `actual: { rows, loops, timeMs }`, `children`); `String(…)` renders it. | Prototype |
| Costs and structured fields per node (operator, table, index) | Asserting a plan's shape from fields, not text. | Planned (milestone 8, needs smaltdb E2) |
| `db.analyze(table?)` | Gathers statistics, so plans can be estimated. | Prototype |

## Plugins and transactions

```ts
import assert from 'node:assert/strict';
import { Database } from 'smaltdb/engine';
import external from '@smaltdb/external';
import parquet from '@smaltdb/parquet';
import { attach, connection, definePlugin, externalTable, methods, real, text } from '@smaltworks/smaltts';

const raw = Database.openMemory({ plugins: [external, parquet] });
const db = attach(raw);

// Connections and external tables are specs (a diff reads no file): created, left alone, made again when they change, dropped with prune.
const lake = connection('lake', { type: 'https', url: 'https://data.example.org/' });
const prices = externalTable('prices', { location: 'file:prices.parquet' });
const changes = await db.diff({ tables: [], connections: [lake], externals: [prices] });
assert.deepEqual(changes.steps.map((s) => s.action), ['createConnection', 'createExternalTable']);

// A plugin, typed by its descriptor: its table functions give typed relations, its methods type `call`.
const pq = definePlugin({ name: '@smaltdb/parquet', tableFunctions: ['read_parquet'] });
const rel = pq.tableFunctions.read_parquet('file:prices.parquet', { sku: text(), price: real() });
const io = definePlugin({ name: '@smaltdb/io', methods: methods<{ importCSV(table: string, csv: string): { rows: number } }>() });
void rel;
void io;

await db.transaction(async (tx) => {
  await tx.analyze();
});
```

| | | |
|---|---|---|
| `connection(name, { type?, url?, credentials?, … })` | A connection spec: the engine's options for it, as `createConnection` takes them; what they mean is its type's plugin's (`@smaltdb/external`: http, s3, azure). | Prototype |
| `externalTable(name, { location, format?, connection?, … }, columns?)` | An external table spec: its options (`connection` a name or a connection spec) and, optionally, its declared columns as column builders. Without columns, the engine reads them from the source when the table is created. `scan(name)` reads it, typed by its columns. | Prototype |
| `SchemaSpec.connections`, `SchemaSpec.externals` | Diffed and applied like tables: created when missing, left alone (a note) or dropped with `prune` when not wanted, and made again when their options or declared columns change (`replaceConnection`, `replaceExternalTable`, data loss none: the data is outside). A connection made again takes the external tables that read through it with it. Left out of the spec, the database's are left alone. | Prototype |
| `definePlugin({ name, methods?, tableFunctions? })` | A plugin's descriptor (DESIGN.md decision 14): `tableFunctions.<name>(args, columns, named?)` gives a relation typed by `columns`; `methods: methods<{ … }>()` types `db.plugin(descriptor).call`. smaltts depends on no plugin: a descriptor is data and types, and the engine runs the plugin. | Prototype |
| `db.plugin(descriptor or name).call(method, ...args)` | Calls a plugin's method, typed by its descriptor's methods. | Prototype |
| `db.catalog().connections`, `db.catalog().externals` | The database's connections and external tables, as specs. | Prototype |
| `db.transaction(fn)` | Runs `fn` in one transaction; nested calls are savepoints (in process). | Prototype |

## The language

| | | |
|---|---|---|
| `@smaltworks/smaltts/language` | The language's entry point, for where the engine runs: it imports `smaltdb/language`. The package's main entry point imports only `smaltdb/plan`, so a page that builds plans loads no engine. | Prototype |
| `smalttsLanguage`, `registerSmaltts()` | smaltts's `SmaltLanguage`, for its views only: it binds them (their source is the relation's JSON) and edits them when ALTER TABLE renames a table or a column they read. Tables and indexes are defined without source text (smaltdb ADR 0016 §6). | Prototype |
| `LANGUAGE` | `'smaltts'`, the language name sources record (from the main entry point). | Prototype |

## Errors

| | | |
|---|---|---|
| Unknown names | `compile` throws, naming the column and the columns that exist. | Prototype |
| Policy refusals | `apply` throws, listing each refused step with its impact and data loss. | Prototype |
| A failed step | `apply` throws `<action> <object>: <engine message>`, with the engine error as `cause`; nothing is applied. | Prototype |
| `origin` | Every plan node smaltts builds carries `{ smaltts: '<call>' }` (`'filter'`, `'fn.add_checked'`, …); an engine error raised while a plan runs gives back the innermost one as `error.origin` (smaltdb ADR 0016 §10). | Prototype |
