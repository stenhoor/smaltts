# Research

Surveys behind the smaltts design ([DESIGN.md](../DESIGN.md)), written on 2026-11-06.

| Survey | Covers |
|---|---|
| [database-apis.md](database-apis.md) | Programmatic DDL, DML, catalog, plan and extension APIs of SQLite, PostgreSQL, Oracle, MySQL, SQL Server and DuckDB; Calcite, Substrait, DataFusion, Spark and Delta Lake; Liquibase, Flyway and Atlas |
| [typescript-apis.md](typescript-apis.md) | TypeScript and JavaScript database APIs: Drizzle, Kysely, Prisma, TypeORM, MikroORM, Knex, Sequelize, Zapatos, Atlas, Effect SQL; IndexedDB, Dexie, RxDB, TinyBase, DuckDB-WASM, PGlite; plan builders |

**Limits.** The session's network blocked some vendor sites (substrait.io, kysely.dev, orm.drizzle.team,
dexie.org). Facts were checked by web search where possible; the TypeScript survey marks the claims it could not
check as "(from memory)". Check a marked claim before relying on it.

## Where they agree

Both surveys converge on the same shape, and smaltts adopts it:

1. **One object model** for declaring, introspecting, comparing and applying: SQL Server's SMO and DacFx, TypeORM's
   `Table`, MikroORM's `DatabaseTable`. Never DDL as text that has to be parsed again (SQLite's weakness).
2. **Desired state, then diff, then a reviewable plan, then apply**: DacFx, Atlas, Oracle's `DBMS_METADATA_DIFF`,
   Liquibase `update-sql`, SMO capture mode. The diff is a library function that returns data, never an interactive
   prompt (drizzle-kit's weakness).
3. **Classify every change** by cost and by data loss, and let the caller require a class: MySQL's
   `ALGORITHM=INSTANT`, DacFx's `BlockOnPossibleDataLoss`, Atlas's analyzers, PostgreSQL's `table_rewrite` event.
4. **Renames are intent, not inference**: DacFx's refactor log, Atlas's hints. A plain diff never guesses a rename.
5. **A lazy relational builder** that produces the engine's plan data and can explain itself: Calcite's
   RelBuilder, DataFusion's LogicalPlanBuilder, DuckDB's relations. No maintained TypeScript plan builder exists today.
6. **Types from values, with an untyped tier for discovered schemas** that produces identical data: Drizzle,
   TinyBase, RxDB. Keep type-level computation shallow, because large ETL schemas break deep generic types.
7. **History in the database, with checksums**: Flyway, Liquibase, `atlas.sum`.
