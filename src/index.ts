/**
 * smaltts: a thin, typed TypeScript API over smaltdb's plan and schema operations. See docs/DESIGN.md.
 *
 * This entry point imports only `smaltdb/plan` at run time. The language (for smaltts views) is
 * `@smaltworks/smaltts/language`, for where the engine runs.
 */
export { type ColumnSpec, type IndexSpec, type KeySpec, type ForeignKeySpec, type TableSpec, type SchemaSpec, type StorageType, type Collation, type Value, type RowOf, type InsertOf, ColumnBuilder, table, tableSpec, inferTable, int, real, numeric, text, blob, any, bool, date, datetime, time, duration, list, struct, columnPlanType, type CheckSpec } from './spec.js';
export { toColumnDef, toTableDef, toIndexDef } from './ddl.js';
export { type Catalog, type CatalogViewInfo, readCatalog, specOfCatalogTable } from './catalog.js';
export { type ChangeSet, type Step, type Impact, type DataLoss, type Diagnostic, type DiffOptions, type ApplyPolicy, type Applied, HISTORY_TABLE, diff, diffCatalog, apply, describe } from './changes.js';
export { type RelNode, type ExprNode, type ColumnType, type Cols, type Compiled, type Field, type Resolver, type AggOptions, type JoinKind, type JoinOptions, type AsofOptions, type Frame, type FrameBound, type OneColumn, Rel, Expr, scan, values, fromColumns, tableFunction, iterate, relFromJSON, compileRel, lit, col, and, or, not, fn, param, agg, caseWhen, exists, scalar } from './rel.js';
export { SCALAR, AGGREGATE, ARITY, OPERATIONS, type ScalarName, type AggregateName, type OperationName, type WindowName } from './functions.js';
export { type Signatures, SIGNED } from './signatures.js';
export { type ExplainNode, type Explained, type LoadMode, type AsText, SmaltDb, attach } from './database.js';
export { type Backend, type Result, type RunOptions, engineBackend, clientBackend, backendOf } from './backend.js';
export { LANGUAGE, type ViewSource } from './source.js';
