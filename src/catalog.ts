/**
 * The catalog: a live database read back as specs, so that what a database HAS and what a toolchain WANTS are the same
 * kind of value and can be compared (`diff`).
 *
 * It reads the engine's catalog API (ADR 0016 section 7: `db.catalog` in process, `catalog()` on the client), the same
 * in both places. The catalog does not list default values yet (only whether a column has one: smaltdb proposal E1),
 * so those alone are read from `information_schema.columns` through a plan, until it does.
 */
import type { CatalogData, CatalogTable } from 'smaltdb/plan';
import type { Backend } from './backend.js';
import type { RelNode } from './rel.js';
import { type ColumnSpec, type IndexSpec, type KeySpec, type TableSpec, type Value, tableSpec } from './spec.js';
import { LANGUAGE, type ViewSource } from './source.js';

export interface CatalogViewInfo {
  readonly name: string;
  readonly materialized: boolean;
  /** The language the view is written in, and its source text. */
  readonly language: string | undefined;
  readonly definition: string;
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
export function specOfCatalogTable(t: CatalogTable, defaults: ReadonlyMap<string, Value> = new Map()): TableSpec {
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
    ...(c.notNull ? { notNull: true } : {}),
    ...(c.collation !== 'binary' ? { collation: c.collation } : {}),
    ...(c.hasDefault && defaults.has(c.name.toLowerCase()) ? { default: defaults.get(c.name.toLowerCase())! } : {}),
  }));
  return tableSpec({
    kind: 'table',
    name: t.name,
    columns,
    ...(pk ? { primaryKey: keyOf(pk.columns) } : {}),
    ...(unique.length ? { unique } : {}),
    ...(indexes.length ? { indexes } : {}),
    ...(t.storage === 'columnar' ? { storage: 'columnar' as const } : {}),
  });
}

/** Read the database's user tables and views as specs. */
export async function readCatalog(db: Backend): Promise<Catalog> {
  const data: CatalogData = await db.catalog();
  const defaults = await readDefaults(db);
  const tables: TableSpec[] = [];
  const stored: TableSpec[] = [];
  const views: CatalogViewInfo[] = [];
  for (const t of data.tables) {
    if (t.schema !== 'main' || isSystem(t.name)) continue;
    const spec = specOfCatalogTable(t, defaults.get(t.name.toLowerCase()));
    if (t.kind === 'table') tables.push(spec);
    else if (t.kind === 'materializedView') {
      stored.push(spec);
      views.push({ name: t.name, materialized: true, language: t.source?.language, definition: t.source?.text ?? '' });
    }
  }
  for (const v of data.views) if (v.schema === 'main') views.push({ name: v.name, materialized: false, language: v.language, definition: v.text });
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

/** Default values by table and column, from `information_schema.columns` (until the catalog lists them: E1). */
async function readDefaults(db: Backend): Promise<Map<string, Map<string, Value>>> {
  const types = ['text', 'text', 'text', 'text', 'int', 'text', 'text', 'text', 'text', 'text', 'text'] as const;
  const r = await db.run({ kind: 'query', plan: { op: 'source', kind: 'virtual', schema: 'information_schema', name: 'columns', args: [], types } });
  const out = new Map<string, Map<string, Value>>();
  for (const row of r.rows) {
    const [, schema, table, column, , text] = row as readonly (Value | null)[];
    if (schema !== 'main' || text === null || text === undefined) continue;
    const key = String(table).toLowerCase();
    if (!out.has(key)) out.set(key, new Map());
    out.get(key)!.set(String(column).toLowerCase(), parseDefault(String(text)));
  }
  return out;
}

function parseDefault(text: string): Value {
  if (/^null$/i.test(text)) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(text)) return Number(text);
  const quoted = /^'(.*)'$/s.exec(text) ?? /^"(.*)"$/s.exec(text);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  return text;
}
