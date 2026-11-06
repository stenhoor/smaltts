# smaltts: plan (draft for the owner's interview)

- **Status:** draft, before the design interview. Open questions are in [section 9](#9-open-questions).
- **Date:** 2026-11-06
- **Builds on:** smaltdb [ADR 0014](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0014-shared-plan-layer.md)
  (shared plan layer) and [ADR 0015](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0015-smaltql.md)
  (smaltql and the language API).

## 1. What smaltts is

smaltts is a **TypeScript-first language for smaltdb**: a typed, high-level interface that builds the engine's plans
directly. It is a peer of smaltql (SQL) and smaltdf (dataframes) on the same language API. It has no SQL in any form
(no SQL strings, no SQL-shaped builder) and no dataframe concepts (no frames, no eager/lazy split, no Polars naming).

Its audience is the TypeScript application developer who wants:

- tables, indexes, views and materialized views **defined in TypeScript**, with row types inferred from them;
- queries and writes that are **checked by the compiler**: a misspelt column, a wrong type in a comparison or a
  nullable column used as non-null fails `tsc`, not the database;
- results typed as plain TypeScript objects, with no casts;
- the plan the engine will run, its estimates and its measured run **as data**, to review and test.

## 2. Where it sits

```
@smaltworks/smaltts
  schema builders ─┐
  query builders ──┼─→ smaltts IR (names) ─→ binder ─→ engine plan (positions) ─→ smaltdb
  DML builders ────┘        │                  ▲
                            └─ stored as view source (JSON), re-bound by name ─┘
```

Two facts from the engine shape the design:

1. **Plans are positional and nameless.** Columns are `col(input, index)`, every comparison names its collation and
   every operation names the function that gives its meaning (`sql.eq`, `sql.div`, …). smaltts therefore needs its own
   **name-based intermediate representation** (IR) that the builders produce, and a **binder** that resolves names
   against the engine's `BindContext` and emits plans. Users never see positions.
2. **Views are stored as language source and bound late.** The engine keeps a view as `{ language, text }` and asks
   that language to bind it when the view is read. So smaltts must be a **registered `SmaltLanguage`** (`name: 'ts'`)
   whose view source is the serialized IR (JSON). The same IR serializes queries for logging, caching and plan review.

Runtimes: the in-process engine (`smaltdb/engine`, Node and own workers) and the worker client (`smaltdb`, pages).
The builders import only `smaltdb/plan` types so a page that builds queries does not load the engine; the binder runs
where the catalog is (in the worker, registered with `defineWorker({ languages: [ts] })`).

## 3. Schema: tables and types

Tables are values. Row types are inferred from them.

```ts
import { table, int, text, real, bool, timestamp, index } from '@smaltworks/smaltts';

export const users = table('users', {
  id: int().primaryKey(),                       // rowid alias
  email: text().notNull().unique().collate('nocase'),
  name: text().notNull(),
  score: real().default(0),
  active: bool().default(true),                  // logical type, see Q4
  createdAt: timestamp().defaultNow(),           // logical type, see Q4
}, (t) => ({
  byName: index(t.name),
  activeByScore: index(t.score.desc()).where(t.active),
  checks: [t.score.gte(0)],
}));

export const orders = table('orders', {
  id: int().primaryKey(),
  userId: int().notNull().references(() => users.id, { onDelete: 'cascade' }),
  total: real().notNull(),
}, { storage: 'columnar' });

type User = typeof users.$row;        // { id: number; email: string; name: string; score: number; ... }
type NewUser = typeof users.$insert;  // id, score, active, createdAt optional (defaults)
```

| Function | Maps to |
|---|---|
| `table(name, columns, extras?, options?)` | `TableDef` (`row` / `columnar` storage, TEMP) |
| Column types `int`, `real`, `num`, `text`, `blob`, `any` | engine storage types `INTEGER`, `REAL`, `NUMERIC`, `TEXT`, `BLOB`, `ANY` |
| Logical types `bool`, `timestamp`, `date`, `json<T>`, `enumOf(...)`, `bigint()` | a storage type plus a codec and checks (Q4) |
| Column modifiers `.notNull()`, `.primaryKey({ autoincrement })`, `.unique()`, `.default(v)`, `.defaultExpr(e)`, `.collate(c)`, `.check(pred)`, `.references(col, actions)` | `ColumnDef`, `KeyDef`, `CheckDef`, `ForeignKeyDef` |
| Table extras: composite `primaryKey(...)`, `unique(...)`, `check(...)`, `foreignKey(...)` | `KeyDef`, `CheckDef`, `ForeignKeyDef` |
| `index(...cols).unique().where(pred)`, expression keys `index(t.email.lower())` | `IndexDef` (partial, expression) |

## 4. Schema: DDL operations

| Function | Engine operation |
|---|---|
| `db.create(users, { ifNotExists })`, `db.create(index)` | `createTable`, `createIndex` |
| `db.drop(users, { ifExists })` | `drop` |
| `db.alter(users).renameTo(n)`, `.addColumn(n, col)`, `.renameColumn(a, b)`, `.dropColumn(n)` | `alterTable` |
| `view(name, query)` → `db.create(view)` | `createView` (`materialized: false`, source = IR JSON) |
| `materializedView(name, query, { storage, location, populate })` → `db.create(mv)` | `createView` (`materialized: true`, options) |
| `db.refresh(mv, { concurrently, ifChanged, withData })` | `maintenance: refresh` |
| `connection(name, options)`, `externalTable(name, columns?, options)` | `createConnection`, `createExternalTable` (Q11) |
| `db.migrate(schema)` / `db.diff(schema)` | compares the TypeScript schema with the catalog and emits the operations above (Q7) |
| `db.catalog.tables()`, `.views()`, `.indexes(t)`, `.columns(t)` | typed reads of `information_schema` |

A view is a value usable anywhere a table is: `from(activeUsers)` is typed by the view's query.

## 5. Queries

A `Query<Row>` is an immutable value. Every method returns a new query with a new inferred row type. Nothing runs
until a terminal method is called on a database.

```ts
import { from, count, sum, desc, param } from '@smaltworks/smaltts';

const topSpenders = from(users)
  .join(orders, (u, o) => o.userId.eq(u.id))          // row: { users: User; orders: Order }
  .where(({ users }) => users.active)
  .groupBy(({ users }) => ({ id: users.id, name: users.name }))
  .select(({ key, rows }) => ({ ...key, spent: sum(rows.orders.total), orders: count() }))
  .having((r) => r.spent.gt(param.real('min')))
  .orderBy((r) => desc(r.spent))
  .limit(10);

const rows = await db.all(topSpenders, { min: 100 }); // { id: number; name: string; spent: number; orders: number }[]
```

| Group | Functions | Plan operation |
|---|---|---|
| Sources | `from(table \| view \| mv)`, `values(rows)` (JS data), `tableFunction(name, args)`, `external(t)` | `scan`, `values`, `source` |
| Row filters | `.where(pred)`, `.distinct()`, `.limit(n)`, `.offset(n)`, `.first()` | `filter`, `distinct`, `limit` |
| Shape | `.select(r => ({...}))`, `.extend(r => ({...}))` (add columns), `.omit(...keys)`, `.rename({...})` | `project` |
| Order | `.orderBy(r => [asc(e), desc(e, { nulls: 'last' })])` | `sort` |
| Joins | `.join`, `.leftJoin` (right side becomes nullable), `.rightJoin`, `.fullJoin`, `.crossJoin`, `.whereExists(q)` / `.whereNotExists(q)` (semi / anti) | `join` |
| Grouping | `.groupBy(r => keys).select(({ key, rows }) => ...)`, `.having(pred)`, `.aggregate(r => ({...}))` (no keys) | `aggregate` |
| Windows | `rowNumber().over({ partitionBy, orderBy, frame })`, `rank`, `denseRank`, `percentRank`, `cumeDist`, `ntile`, `lag`, `lead`, `firstValue`, `lastValue`, `nthValue`, any aggregate `.over(...)` | `window` |
| Set operations | `union`, `unionAll`, `intersect`, `except` (row types must match) | `setop` |
| Reuse | a `Query` held in a variable is a CTE; `recursive(seed, (self) => step)` | inlined, `iterate` / `working` |
| Subqueries | `scalar(q)`, `exists(q)`, `e.in(q)`, correlated by closing over outer row values | `subquery`, `inSubquery` |
| Relations (Q8) | `users.orders` declared once, then `.include(...)` / `.with(...)` for nested results | joins + grouping, or several plans |

### Expressions

Typed values `Expr<T>` (`T` includes `null` for nullable columns), built by methods and free functions:

| Group | Functions |
|---|---|
| Literals and parameters | `lit(v)`, plain JS values where an `Expr` is expected, `param.int('name')`, `param.text(...)`, … |
| Comparison | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `between`, `in([...])`, `isNull`, `isNotNull`, `isDistinctFrom` |
| Logic | `and`, `or`, `not`, `when(c, v).when(...).else(v)` |
| Arithmetic | `add`, `sub`, `mul`, `div` (meaning: Q3), `intDiv`, `mod`, `neg`, bit operations |
| Null handling | `coalesce`, `ifNull`, `nullIf`, `.orElse(v)` (removes `null` from `T`) |
| Text | `concat`, `lower`, `upper`, `trim`, `length`, `substr`, `replace`, `like`, `glob`, `startsWith`, `contains`, `collate(c)` |
| Math | `abs`, `round`, `floor`, `ceil`, `sqrt`, `pow`, `exp`, `ln`, `log10`, trigonometry, `sign` |
| Date and time | `now()`, `date`, `time`, `datetime`, `julianday`, `strftime`, `addDays`… (depends on Q4) |
| Casts | `e.as('int' \| 'real' \| 'text' \| 'blob')`, checked conversions |
| JSON | `jsonExtract`, `jsonArray`, `jsonObject` (engine's JSON functions) |
| Aggregates | `count()`, `count(e)`, `countDistinct`, `sum`, `total`, `avg`, `min`, `max`, `groupConcat`, `stddev`, `variance`, `median`, `quantile`, `.filter(pred)` on any aggregate |

## 6. Writes

```ts
import { insert, update, remove } from '@smaltworks/smaltts';

await db.run(insert(users).values([{ email: 'a@x.dev', name: 'Ada' }]));
await db.run(insert(users).values(rows).onConflict((t) => t.email).doUpdate((old, nu) => ({ name: nu.name })));
const ids = await db.all(insert(archive).from(from(users).where((u) => u.active.not())).returning((r) => r.id));
await db.run(update(users).set((u) => ({ score: u.score.add(1) })).where((u) => u.id.eq(param.int('id'))), { id: 7 });
await db.run(remove(users).where((u) => u.active.not()));
```

| Function | Plan operation |
|---|---|
| `insert(t).values(rows \| row)`, `.from(query)`, `.defaults()` | `append` |
| `.onConflict(target?).doNothing()` / `.doUpdate(set, where?)`, `.orReplace()`, `.orIgnore()` | `append.upserts`, `onConflict` |
| `update(t).set(r => ({...})).where(pred)`, `.from(query, on)` | `update` |
| `remove(t).where(pred)` (`delete` is a reserved word) | `delete` |
| `.returning(r => ({...}))` on all three | `returning` |

## 7. Running, transactions and the database handle

| Function | |
|---|---|
| `open(name, options)` | smaltts's `open()` (ADR 0015: each language exports one), worker with smaltts registered |
| `fromEngine(db)` / `fromClient(db)` | wrap an existing in-process or client `Database` |
| `db.all(q, params?)`, `db.one(q)` (exactly one), `db.maybeOne(q)`, `db.value(q)` (one column), `db.count(q)`, `db.exists(q)` | run a query |
| `db.stream(q, { batchSize })` | async iterator of rows |
| `db.columns(q)` | columnar result (typed arrays) |
| `db.run(write)` | `{ changes, lastRowId }`, or rows with `returning` |
| `db.prepare(q)` | a prepared statement typed by its parameters and rows |
| `db.transaction(async (tx) => ...)`, `{ mode: 'immediate' }`, nested calls become savepoints | `transaction` statements |
| `db.analyze(t?)`, `db.vacuum()`, `db.setting(name)`, `db.set(name, v)` | `maintenance`, `setting` |
| `signal` on every call | cancellation |

## 8. Plan review and costing

| Function | Gives |
|---|---|
| `q.toIR()` / `q.toJSON()` | the smaltts IR, with names (stable, readable, diffable) |
| `db.plan(q)` | the bound engine plan (`PlanOp`), as the engine receives it |
| `db.explain(q)` | the physical plan as a typed tree: operator, access path (index, scan, columnar zone maps), join method and order, estimated rows and cost per node (cost needs engine work, Q9) |
| `db.explainAnalyze(q)` | the same tree with actual rows, loops and time per node |
| `printPlan(tree)` | a text rendering for logs and terminals |
| `expectPlan(tree)` helpers | test assertions: `usesIndex('users_email')`, `noFullScan('orders')`, `estimatedRowsBelow(n)` (Q9) |
| `db.compare(q1, q2)` | estimates of two queries side by side |

## 9. Open questions

| ID | Question | Why it matters |
|---|---|---|
| Q1 | Relation to smaltdf: separate language, or share an expression core? | Overlap in typed expressions and binding |
| Q2 | Query style: method chains with callbacks, object literals, or both? | The core of the developer experience |
| Q3 | Semantics: SQLite's (via `sql.*`) or TypeScript's (`===`, float division, booleans)? | Every operator's meaning; may need engine functions |
| Q4 | Logical types (boolean, dates, JSON, bigint): smaltts codecs now, or wait for engine types? | ADR 0015 plans engine boolean/date types |
| Q5 | NULL: `null` only, or `undefined` too? Optional vs nullable in insert types | Type inference everywhere |
| Q6 | Join result shape: nested by table (`{ users, orders }`) or flat with prefixes/aliases? | Every join |
| Q7 | Schema source of truth: TypeScript definitions, the database (codegen), or both? Migrations? | DDL design |
| Q8 | Relations and nested results (`include`) in scope? | Big feature, ORM territory |
| Q9 | Plan review: what costing must exist? Engine changes to expose cost per node? | EXPLAIN has no costs today |
| Q10 | Views in other languages: smaltql reads non-SQL views only through materialized views. Accept, or change the engine? | Interop with smaltql/smaltui/smaltbi |
| Q11 | External tables, connections, table functions, plugins in scope for v1? | Scope |
| Q12 | Result shape default: objects, arrays or columnar? | Performance vs ergonomics |
| Q13 | Runtime targets and packaging: worker-only, in-process too, separate entry for builders? | Bundle size |
| Q14 | Package name and repository conventions (`@smaltworks/smaltts`, CLAUDE.md, packed.json) | Consistency with siblings |
