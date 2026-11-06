/**
 * smaltts: a database-first, plan-first TypeScript API for the smaltdb engine. See docs/DESIGN.md.
 */
export { type ColumnSpec, type IndexSpec, type KeySpec, type ForeignKeySpec, type TableSpec, type SchemaSpec, type StorageType, type Collation, type Value, type RowOf, type InsertOf, ColumnBuilder, table, tableSpec, inferTable, int, real, numeric, text, blob, any, toTableDef, toIndexDef } from './spec.js';
export { type Catalog, readCatalog } from './catalog.js';
export { type ChangeSet, type Step, type Impact, type DataLoss, type Diagnostic, type DiffOptions, type ApplyPolicy, type Applied, HISTORY_TABLE, diff, diffCatalog, apply, describe } from './changes.js';
export { type RelNode, type ExprNode, type Cols, type Compiled, type Field, type Resolver, Rel, Expr, scan, values, tableFunction, relFromJSON, compileRel, lit, col, and, or, param, agg } from './rel.js';
export { type ExplainNode, type Explained, type LoadMode, SmaltDb, attach } from './database.js';
export { type Backend, type Result, engineBackend, clientBackend, backendOf } from './backend.js';
export { LANGUAGE, type ViewSource, smalttsLanguage, registerSmaltts } from './language.js';
