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
/** What `information_schema` adds to the catalog API for one table, until the catalog lists it (E1). */
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
  const extras = await readExtras(db);
  const tables: TableSpec[] = [];
  const stored: TableSpec[] = [];
  const views: CatalogViewInfo[] = [];
  for (const t of data.tables) {
    if (t.schema !== 'main' || isSystem(t.name)) continue;
    const spec = specOfCatalogTable(t, extras.get(t.name.toLowerCase()));
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

/** Rows of an `information_schema` view, read through a plan. */
async function infoSchema(db: Backend, name: string, width: number): Promise<readonly (readonly unknown[])[]> {
  const r = await db.run({ kind: 'query', plan: { op: 'source', kind: 'virtual', schema: 'information_schema', name, args: [], types: Array<'any'>(width).fill('any') } });
  return r.rows;
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
 * Defaults, CHECKs and foreign keys by table, from `information_schema` (the catalog API lists none of them yet: E1).
 * CHECKs written in another language (their text is not a smaltts expression) are left out.
 */
async function readExtras(db: Backend): Promise<Map<string, TableExtras>> {
  const [columns, constraints, checks, usage, refs] = await Promise.all([
    infoSchema(db, 'columns', 11),
    infoSchema(db, 'table_constraints', 9),
    infoSchema(db, 'check_constraints', 4),
    infoSchema(db, 'key_column_usage', 9),
    infoSchema(db, 'referential_constraints', 9),
  ]);
  const out = new Map<string, { defaults: Map<string, { value: Value } | { expr: ExprNode }>; checks: CheckSpec[]; foreignKeys: ForeignKeySpec[] }>();
  const of = (table: unknown) => {
    const key = String(table).toLowerCase();
    if (!out.has(key)) out.set(key, { defaults: new Map(), checks: [], foreignKeys: [] });
    return out.get(key)!;
  };
  for (const [, schema, table, column, , text] of columns) {
    if (schema !== 'main' || text === null || text === undefined) continue;
    const expr = parseExpr(String(text));
    of(table).defaults.set(String(column).toLowerCase(), expr ? { expr } : { value: parseDefault(String(text)) });
  }
  const clauses = new Map(checks.map(([, , name, clause]) => [String(name), String(clause)]));
  const columnsOf = (constraint: string) =>
    usage.filter((u) => u[2] === constraint).sort((a, b) => Number(a[7]) - Number(b[7])).map((u) => String(u[6]));
  const tableOf = new Map(constraints.map((c) => [String(c[2]), String(c[5])]));
  for (const c of constraints) {
    if (c[4] !== 'main') continue;
    const [name, table, type] = [String(c[2]), c[5], c[6]];
    if (type === 'CHECK') {
      const expr = parseExpr(clauses.get(name) ?? '');
      if (expr) of(table).checks.push({ name, expr });
    } else if (type === 'FOREIGN KEY') {
      const ref = refs.find((r) => r[2] === name);
      const parentKey = ref ? String(ref[5]) : undefined;
      const parent = parentKey ? tableOf.get(parentKey) : undefined;
      if (!parent) continue;
      of(table).foreignKeys.push({
        name,
        columns: columnsOf(name),
        table: parent,
        refColumns: columnsOf(parentKey!),
        onUpdate: String(ref![7]) as ForeignKeySpec['onUpdate'] & string,
        onDelete: String(ref![8]) as ForeignKeySpec['onDelete'] & string,
      });
    }
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
