/**
 * The catalog: a live database read back as specs, so that what a database HAS and what a toolchain WANTS are the same
 * kind of value and can be compared (`diff`).
 *
 * It reads `information_schema` through plans (`source` operations on virtual tables), so it works the same on the
 * in-process engine and through the client. `information_schema` does not carry everything a spec can say (a
 * table's storage, expression and partial indexes, defaults as values): see the engine proposals in docs/DESIGN.md.
 */
import type * as plan from 'smaltdb/plan';
import type { Backend } from './backend.js';
import type { RelNode } from './rel.js';
import { type ColumnSpec, type IndexSpec, type KeySpec, type StorageType, type TableSpec, type Value, tableSpec } from './spec.js';

/** The `information_schema` tables smaltts reads, with their column types. */
const VIEWS = {
  tables: ['text', 'text', 'text', 'text', 'text'],
  columns: ['text', 'text', 'text', 'text', 'int', 'text', 'text', 'text', 'text', 'text', 'text'],
  table_constraints: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  key_column_usage: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'int', 'int'],
  statistics: ['text', 'text', 'text', 'int', 'text', 'int', 'text', 'text', 'text'],
  views: ['text', 'text', 'text', 'text', 'text', 'text', 'text'],
  materialized_views: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
} satisfies Record<string, plan.PlanType[]>;

async function read(db: Backend, name: keyof typeof VIEWS): Promise<Record<string, Value>[]> {
  const r = await db.run({ kind: 'query', plan: { op: 'source', kind: 'virtual', schema: 'information_schema', name, args: [], types: VIEWS[name] } });
  // The columns come back as column1…; their names are the view's, in order.
  const names = COLUMN_NAMES[name];
  return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null])));
}

const COLUMN_NAMES: Record<keyof typeof VIEWS, readonly string[]> = {
  tables: ['table_catalog', 'table_schema', 'table_name', 'table_type', 'is_insertable_into'],
  columns: ['table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'data_type', 'collation_name', 'is_identity', 'is_generated'],
  table_constraints: ['constraint_catalog', 'constraint_schema', 'constraint_name', 'table_catalog', 'table_schema', 'table_name', 'constraint_type', 'is_deferrable', 'initially_deferred'],
  key_column_usage: ['constraint_catalog', 'constraint_schema', 'constraint_name', 'table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'position_in_unique_constraint'],
  statistics: ['table_catalog', 'table_schema', 'table_name', 'non_unique', 'index_name', 'seq_in_index', 'column_name', 'collation', 'index_type'],
  views: ['table_catalog', 'table_schema', 'table_name', 'view_definition', 'check_option', 'is_updatable', 'is_insertable_into'],
  materialized_views: ['table_catalog', 'table_schema', 'table_name', 'view_definition', 'storage', 'location', 'refresh_mode', 'is_populated', 'last_refresh', 'is_fresh', 'last_refresh_error'],
};

const STORAGE: readonly StorageType[] = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'ANY'];
const isSystem = (name: string) => /^(smalt_|sqlite_)/i.test(name);

export interface Catalog {
  readonly tables: readonly TableSpec[];
  readonly views: readonly { readonly name: string; readonly materialized: boolean; readonly definition: string }[];
  /** A table, or a materialized view's stored rows (scannable like a table). */
  table(name: string): TableSpec | undefined;
  /** A smaltts view's relation. */
  view(name: string): RelNode | undefined;
}

/** Read the database's user tables and views as specs. */
export async function readCatalog(db: Backend): Promise<Catalog> {
  const [tables, columns, constraints, keyColumns, stats, views, mvs] = await Promise.all([
    read(db, 'tables'),
    read(db, 'columns'),
    read(db, 'table_constraints'),
    read(db, 'key_column_usage'),
    read(db, 'statistics'),
    read(db, 'views'),
    read(db, 'materialized_views'),
  ]);
  const mvNames = new Set(mvs.map((m) => String(m.table_name).toLowerCase()));
  const specs: TableSpec[] = [];
  const mvSpecs: TableSpec[] = [];
  for (const t of tables) {
    const name = String(t.table_name);
    if (t.table_schema !== 'main' || isSystem(name)) continue;
    const isMv = mvNames.has(name.toLowerCase());
    if (t.table_type !== 'BASE TABLE' && !isMv) continue;
    const cols: ColumnSpec[] = columns
      .filter((c) => c.table_name === name && c.table_schema === 'main')
      .sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position))
      .map((c) => {
        const type = String(c.data_type ?? 'ANY').toUpperCase() as StorageType;
        const collation = String(c.collation_name ?? 'BINARY').toLowerCase();
        return {
          name: String(c.column_name),
          type: STORAGE.includes(type) ? type : 'ANY',
          ...(c.is_nullable === 'NO' ? { notNull: true } : {}),
          ...(collation !== 'binary' ? { collation: collation as ColumnSpec['collation'] } : {}),
          ...(c.column_default !== null ? { default: parseDefault(String(c.column_default)) } : {}),
        };
      });
    if (isMv) {
      mvSpecs.push(tableSpec({ kind: 'table', name, columns: cols }));
      continue;
    }
    const keyOf = (constraint: string): KeySpec => ({
      columns: keyColumns.filter((k) => k.table_name === name && k.constraint_name === constraint).sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position)).map((k) => String(k.column_name)),
    });
    const own = constraints.filter((c) => c.table_name === name && c.table_schema === 'main');
    const pk = own.find((c) => c.constraint_type === 'PRIMARY KEY');
    const unique = own.filter((c) => c.constraint_type === 'UNIQUE').map((c) => keyOf(String(c.constraint_name)));
    const indexNames = [...new Set(stats.filter((s) => s.table_name === name && s.table_schema === 'main' && !isAutoIndex(String(s.index_name))).map((s) => String(s.index_name)))];
    const indexes: IndexSpec[] = indexNames.map((index) => {
      const parts = stats.filter((s) => s.table_name === name && s.index_name === index).sort((a, b) => Number(a.seq_in_index) - Number(b.seq_in_index));
      return { name: index, columns: parts.map((p) => ({ column: String(p.column_name) })), ...(parts[0]?.non_unique === 0 ? { unique: true } : {}) };
    });
    specs.push(
      tableSpec({
        kind: 'table',
        name,
        columns: cols,
        ...(pk ? { primaryKey: keyOf(String(pk.constraint_name)) } : {}),
        ...(unique.length ? { unique } : {}),
        ...(indexes.length ? { indexes } : {}),
      }),
    );
  }
  const allViews = [
    ...views.filter((v) => v.table_schema === 'main').map((v) => ({ name: String(v.table_name), materialized: false, definition: String(v.view_definition ?? '') })),
    ...mvs.filter((v) => v.table_schema === 'main').map((v) => ({ name: String(v.table_name), materialized: true, definition: String(v.view_definition ?? '') })),
  ];
  const find = (n: string) => specs.find((s) => s.name.toLowerCase() === n.toLowerCase()) ?? mvSpecs.find((s) => s.name.toLowerCase() === n.toLowerCase());
  const view = (n: string): RelNode | undefined => {
    const v = allViews.find((x) => !x.materialized && x.name.toLowerCase() === n.toLowerCase());
    if (!v) return undefined;
    try {
      // A smaltts view's definition is its relation's JSON; a view in another language is not readable here.
      const rel = JSON.parse(v.definition) as RelNode;
      return typeof rel === 'object' && rel !== null && 'r' in rel ? rel : undefined;
    } catch {
      return undefined;
    }
  };
  return { tables: specs, views: allViews, table: find, view };
}

/** Indexes the engine makes for PRIMARY KEY and UNIQUE constraints: part of the constraint, not separate objects. */
const isAutoIndex = (name: string) => /^(sqlite|smalt)_autoindex_/i.test(name);

function parseDefault(text: string): Value {
  if (/^null$/i.test(text)) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(text)) return Number(text);
  const quoted = /^'(.*)'$/s.exec(text) ?? /^"(.*)"$/s.exec(text);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  return text;
}
