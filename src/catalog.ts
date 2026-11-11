/**
 * The catalog: a live database read back as specs, so that what a database HAS and what a toolchain WANTS are the same
 * kind of value and can be compared (`diff`).
 *
 * It reads the engine's catalog API (ADR 0016 section 7: `db.catalog` in process, `catalog()` on the client), the same
 * in both places, and nothing else: columns, keys, indexes, storage, defaults, CHECKs and foreign keys (smaltdb#189).
 */
import type { CatalogData, CatalogTable } from 'smaltdb/plan';
import type { Backend } from './backend.js';
import type { RelNode } from './rel.js';
import type { ExprNode } from './expr.js';
import { type CheckSpec, type ColumnSpec, type ForeignKeySpec, type IndexSpec, type KeySpec, type TableSpec, type Value, tableSpec } from './spec.js';
import { LANGUAGE, type ViewSource } from './source.js';

export interface CatalogViewInfo {
  readonly name: string;
  readonly materialized: boolean;
  /** The language the view is written in, and its source text. */
  readonly language: string | undefined;
  readonly definition: string;
  /** An interface view's declared columns, in order (DESIGN.md section 8.1); absent for a reflecting view. */
  readonly columns?: readonly string[];
  /** A materialized view's storage. */
  readonly storage?: 'row' | 'columnar';
}

/** A view's declared columns: the engine's column list, or a smaltts source's. */
function declared(language: string | undefined, text: string, columns?: readonly string[]): readonly string[] | undefined {
  if (columns?.length) return columns;
  if (language !== LANGUAGE) return undefined;
  try {
    return (JSON.parse(text) as ViewSource).columns;
  } catch {
    return undefined;
  }
}

export interface Catalog {
  /** User tables, as specs. */
  readonly tables: readonly TableSpec[];
  readonly views: readonly CatalogViewInfo[];
  /** A table, or a materialized view's stored rows (scannable like a table). */
  table(name: string): TableSpec | undefined;
  /** A smaltts view's relation. */
  view(name: string): RelNode | undefined;
  /** A plain view in another language that declares its columns: its column names. */
  foreignView(name: string): readonly string[] | undefined;
  /** The engine's result type of a function for these argument types, where the backend can answer. */
  resultType?(name: string, args: readonly import('smaltdb/plan').PlanType[]): import('smaltdb/plan').PlanType | undefined;
}

const isSystem = (name: string) => /^(smalt_|sqlite_)/i.test(name);
/** Indexes the engine makes for PRIMARY KEY and UNIQUE constraints: part of the constraint, not separate objects. */
const isAutoIndex = (name: string) => /^(sqlite|smalt)_autoindex_/i.test(name);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A catalog table as a spec: its columns, keys and indexes (expression and partial indexes are left out). */
/** A table's defaults, CHECKs and foreign keys, as specs. */
export interface TableExtras {
  /** By lower-case column name: a constant default, or a computed one. */
  readonly defaults: ReadonlyMap<string, { readonly value: Value } | { readonly expr: ExprNode }>;
  readonly checks: readonly CheckSpec[];
  readonly foreignKeys: readonly ForeignKeySpec[];
}

const NO_EXTRAS: TableExtras = { defaults: new Map(), checks: [], foreignKeys: [] };

export function specOfCatalogTable(t: CatalogTable, extras: TableExtras = NO_EXTRAS): TableSpec {
  const defaults = extras.defaults;
  const names = t.columns.map((c) => c.name);
  const keyOf = (columns: readonly number[]): KeySpec => ({ columns: columns.map((i) => names[i]!) });
  const pk = t.keys.find((k) => k.kind === 'primaryKey');
  const unique = t.keys.filter((k) => k.kind === 'unique').map((k) => keyOf(k.columns));
  const indexes: IndexSpec[] = t.indexes
    .filter((ix) => !isAutoIndex(ix.name) && !ix.partial && ix.columns.every((c) => c.column >= 0))
    .map((ix) => ({
      name: ix.name,
      columns: ix.columns.map((c) => ({ column: names[c.column]!, ...(c.desc ? { desc: true } : {}), ...(c.collation !== t.columns[c.column]!.collation ? { collation: c.collation } : {}) })),
      ...(ix.unique ? { unique: true } : {}),
    }));
  const columns: ColumnSpec[] = t.columns.map((c) => ({
    name: c.name,
    type: c.storageType,
    ...(c.storageType === 'LIST' || c.storageType === 'STRUCT' ? { planType: c.type } : {}),
    ...(c.notNull ? { notNull: true } : {}),
    ...(c.collation !== 'binary' ? { collation: c.collation } : {}),
    ...defaultOf(c.hasDefault ? defaults.get(c.name.toLowerCase()) : undefined),
  }));
  return tableSpec({
    kind: 'table',
    name: t.name,
    columns,
    ...(pk ? { primaryKey: keyOf(pk.columns) } : {}),
    ...(unique.length ? { unique } : {}),
    ...(indexes.length ? { indexes } : {}),
    ...(extras.foreignKeys.length ? { foreignKeys: extras.foreignKeys } : {}),
    ...(extras.checks.length ? { checks: extras.checks } : {}),
    ...(t.storage === 'columnar' ? { storage: 'columnar' as const } : {}),
  });
}

function defaultOf(d: { readonly value: Value } | { readonly expr: ExprNode } | undefined): Partial<ColumnSpec> {
  if (!d) return {};
  return 'expr' in d ? { defaultExpr: d.expr } : { default: d.value };
}

/** Read the database's user tables and views as specs. */
export async function readCatalog(db: Backend): Promise<Catalog> {
  const data: CatalogData = await db.catalog();
  const tables: TableSpec[] = [];
  const stored: TableSpec[] = [];
  const views: CatalogViewInfo[] = [];
  for (const t of data.tables) {
    if (t.schema !== 'main' || isSystem(t.name)) continue;
    const spec = specOfCatalogTable(t, extrasOf(t, data.tables));
    if (t.kind === 'table') tables.push(spec);
    else if (t.kind === 'materializedView') {
      stored.push(spec);
      const columns = declared(t.source?.language, t.source?.text ?? '');
      views.push({ name: t.name, materialized: true, language: t.source?.language, definition: t.source?.text ?? '', ...(columns ? { columns } : {}), storage: t.storage === 'columnar' ? 'columnar' : 'row' });
    }
  }
  for (const v of data.views) {
    if (v.schema !== 'main') continue;
    const columns = declared(v.language, v.text, v.columns);
    views.push({ name: v.name, materialized: false, language: v.language, definition: v.text, ...(columns ? { columns } : {}) });
  }
  const find = (n: string) => tables.find((s) => same(s.name, n)) ?? stored.find((s) => same(s.name, n));
  return {
    tables,
    views,
    table: find,
    view(n) {
      const v = data.views.find((x) => same(x.name, n));
      return v && v.language === LANGUAGE ? (JSON.parse(v.text) as ViewSource).rel : undefined;
    },
    foreignView(n) {
      const v = data.views.find((x) => same(x.name, n));
      return v && v.language !== LANGUAGE ? v.columns : undefined;
    },
    ...(db.resultType ? { resultType: db.resultType } : {}),
  };
}

/** A smaltts expression kept as its JSON (CHECKs and computed defaults written by smaltts); undefined for other text. */
function parseExpr(text: string): ExprNode | undefined {
  if (!text.startsWith('{"k":')) return undefined;
  try {
    return JSON.parse(text) as ExprNode;
  } catch {
    return undefined;
  }
}

/**
 * Defaults, CHECKs and foreign keys of a catalog table, as the catalog lists them (ADR 0016 §7, smaltdb#189). A
 * computed default or a CHECK written by smaltts keeps its expression as JSON text; CHECKs in another language (their
 * text is not a smaltts expression) are left out. A foreign key without parent columns names the parent's primary key.
 */
function extrasOf(t: CatalogTable, tables: readonly CatalogTable[]): TableExtras {
  const names = t.columns.map((c) => c.name);
  const defaults = new Map<string, { value: Value } | { expr: ExprNode }>();
  for (const c of t.columns) {
    if (!c.default) continue;
    const expr = parseExpr(c.default.text);
    defaults.set(c.name.toLowerCase(), expr ? { expr } : { value: c.default.value as Value });
  }
  const checks: CheckSpec[] = [];
  for (const c of t.checks) {
    const expr = parseExpr(c.text);
    if (expr) checks.push({ ...(c.name ? { name: c.name } : {}), expr });
  }
  const foreignKeys: ForeignKeySpec[] = t.foreignKeys.map((f) => {
    const parent = tables.find((p) => p.schema === 'main' && same(p.name, f.table));
    const pk = parent?.keys.find((k) => k.kind === 'primaryKey');
    const refColumns = f.refColumns ?? (parent && pk ? pk.columns.map((i) => parent.columns[i]!.name) : undefined);
    return {
      ...(f.name ? { name: f.name } : {}),
      columns: f.columns.map((i) => names[i]!),
      table: parent?.name ?? f.table,
      ...(refColumns ? { refColumns } : {}),
      onUpdate: f.onUpdate,
      onDelete: f.onDelete,
    };
  });
  return { defaults, checks, foreignKeys };
}
