/**
 * smaltts: a thin, typed TypeScript API over smaltdb's plan and schema operations. See docs/DESIGN.md.
 *
 * This entry point imports only `smaltdb/plan` at run time. The language (for smaltts views) is
 * `@smaltworks/smaltts/language`, for where the engine runs.
 */
export { type ColumnSpec, type IndexSpec, type KeySpec, type ForeignKeySpec, type TableSpec, type SchemaSpec, type StorageType, type Collation, type Value, type RowOf, type InsertOf, ColumnBuilder, table, tableSpec, inferTable, int, real, numeric, text, blob, any, bool, date, datetime, time, duration, list, struct, columnPlanType, toTableDef, toIndexDef } from './spec.js';
export { type Catalog, type CatalogViewInfo, readCatalog, specOfCatalogTable } from './catalog.js';
export { type ChangeSet, type Step, type Impact, type DataLoss, type Diagnostic, type DiffOptions, type ApplyPolicy, type Applied, HISTORY_TABLE, diff, diffCatalog, apply, describe } from './changes.js';
export { type RelNode, type ExprNode, type ColumnType, type Cols, type Compiled, type Field, type Resolver, type AggOptions, Rel, Expr, scan, values, tableFunction, relFromJSON, compileRel, lit, col, and, or, not, fn, param, agg } from './rel.js';
export { SCALAR, AGGREGATE, type ScalarName, type AggregateName } from './functions.js';
export { type ExplainNode, type Explained, type LoadMode, type AsText, SmaltDb, attach } from './database.js';
export { type Backend, type Result, type RunOptions, engineBackend, clientBackend, backendOf } from './backend.js';
export { LANGUAGE, type ViewSource } from './source.js';
