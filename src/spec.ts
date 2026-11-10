/**
 * Schema specs: the desired state of database objects as plain, JSON-safe data.
 *
 * A spec is the one description of a table that every part of smaltts reads: the typed builders (`table()`) produce
 * one, the catalog reader (`catalog.ts`) reads one back from a database, the differ compares two of them, and the
 * engine receives one as a `TableDef`. Specs built at run time (from a file header, another database, a config file)
 * and specs written in code are the same objects; only the second carries a row type.
 */
import type * as plan from 'smaltdb/plan';

/** How the engine stores a column's values (smaltdb tables are strict). */
export type StorageType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC' | 'ANY' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'TIME' | 'DURATION' | 'LIST' | 'STRUCT';
export type Collation = 'binary' | 'nocase' | 'rtrim';
export type Value = number | bigint | string | Uint8Array | null;

export interface ColumnSpec {
  readonly name: string;
  readonly type: StorageType;
  readonly notNull?: boolean;
  readonly collation?: Collation;
  /** A constant default. */
  readonly default?: Value;
  /** The column's previous name: the differ renames it instead of dropping one column and adding another. */
  readonly renamedFrom?: string;
}

export interface KeySpec {
  readonly columns: readonly string[];
  readonly name?: string;
}

export interface IndexSpec {
  readonly name: string;
  readonly columns: readonly { readonly column: string; readonly desc?: boolean; readonly collation?: Collation }[];
  readonly unique?: boolean;
}

export interface ForeignKeySpec {
  readonly columns: readonly string[];
  readonly table: string;
  readonly refColumns?: readonly string[];
  readonly onDelete?: plan.FkAction;
  readonly onUpdate?: plan.FkAction;
}

/** A table's desired state. `Row` is its row type when it is known at compile time. */
export interface TableSpec<Row = Record<string, Value>> {
  readonly kind: 'table';
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey?: KeySpec;
  readonly unique?: readonly KeySpec[];
  readonly indexes?: readonly IndexSpec[];
  readonly foreignKeys?: readonly ForeignKeySpec[];
  readonly storage?: 'row' | 'columnar';
  /** The table's previous name: the differ renames it instead of dropping one table and creating another. */
  readonly renamedFrom?: string;
  /** Phantom: the row type. Never present at run time. */
  readonly $row?: Row;
}

/** A desired schema: the set of objects a toolchain manages. Objects not in it are left alone unless asked. */
export interface SchemaSpec {
  readonly tables: readonly TableSpec<any>[];
}

// ---------------------------------------------------------------------------------------------------------------
// Typed column builders: `table('t', { id: int().primaryKey(), name: text().notNull() })`.

/** A column under construction; `T` is its TypeScript value type, `N` whether it may be NULL. */
export class ColumnBuilder<T, N extends boolean = true, D extends boolean = false> {
  /** Phantom fields carrying the column's types. */
  declare readonly $type: T;
  declare readonly $nullable: N;
  declare readonly $hasDefault: D;
  readonly spec: Omit<ColumnSpec, 'name'>;
  readonly flags: { readonly primaryKey?: boolean; readonly unique?: boolean; readonly index?: boolean };
  constructor(spec: Omit<ColumnSpec, 'name'>, flags: { readonly primaryKey?: boolean; readonly unique?: boolean; readonly index?: boolean } = {}) {
    this.spec = spec;
    this.flags = flags;
  }
  notNull(): ColumnBuilder<T, false, D> {
    return new ColumnBuilder({ ...this.spec, notNull: true }, this.flags);
  }
  /** The primary key (an INTEGER primary key is the table's rowid, assigned when not given). */
  primaryKey(): ColumnBuilder<T, false, D> {
    return new ColumnBuilder({ ...this.spec, notNull: true }, { ...this.flags, primaryKey: true });
  }
  unique(): ColumnBuilder<T, N, D> {
    return new ColumnBuilder(this.spec, { ...this.flags, unique: true });
  }
  /** An index on this column alone, named `<table>_<column>`. */
  indexed(): ColumnBuilder<T, N, D> {
    return new ColumnBuilder(this.spec, { ...this.flags, index: true });
  }
  collate(collation: Collation): ColumnBuilder<T, N, D> {
    return new ColumnBuilder({ ...this.spec, collation }, this.flags);
  }
  default(value: T & Value): ColumnBuilder<T, N, true> {
    return new ColumnBuilder({ ...this.spec, default: value }, this.flags);
  }
  renamedFrom(previous: string): ColumnBuilder<T, N, D> {
    return new ColumnBuilder({ ...this.spec, renamedFrom: previous }, this.flags);
  }
}

export const int = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'INTEGER' });
export const real = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'REAL' });
export const numeric = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'NUMERIC' });
export const text = (): ColumnBuilder<string> => new ColumnBuilder({ type: 'TEXT' });
export const blob = (): ColumnBuilder<Uint8Array> => new ColumnBuilder({ type: 'BLOB' });
export const any = (): ColumnBuilder<Value> => new ColumnBuilder({ type: 'ANY' });

type Columns = Record<string, ColumnBuilder<any, boolean, boolean>>;
type ValueOf<C> = C extends ColumnBuilder<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never;
/** The row type of a set of column builders. */
export type RowOf<C extends Columns> = { [K in keyof C]: ValueOf<C[K]> };
/** Columns an insert may leave out: nullable, defaulted, or an INTEGER primary key. */
type OptionalKeys<C extends Columns> = { [K in keyof C]: C[K] extends ColumnBuilder<any, infer N, infer D> ? (N extends true ? K : D extends true ? K : never) : never }[keyof C];
export type InsertOf<C extends Columns> = { [K in Exclude<keyof C, OptionalKeys<C>>]: ValueOf<C[K]> } & { [K in OptionalKeys<C>]?: ValueOf<C[K]> };

export interface TableOptions {
  readonly renamedFrom?: string;
  readonly storage?: 'row' | 'columnar';
  readonly primaryKey?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly indexes?: readonly IndexSpec[];
  readonly foreignKeys?: readonly ForeignKeySpec[];
}

/** A table declared in code: a spec whose row type is inferred from its columns. */
export function table<const C extends Columns>(name: string, columns: C, options: TableOptions = {}): TableSpec<RowOf<C>> & { readonly $insert?: InsertOf<C> } {
  const entries = Object.entries(columns);
  const pk = entries.filter(([, c]) => c.flags.primaryKey).map(([n]) => n);
  if (pk.length > 1) throw new Error(`table ${name}: more than one column is marked primaryKey(); give options.primaryKey instead`);
  const primaryKey = options.primaryKey ?? (pk.length ? pk : undefined);
  const unique = [...entries.filter(([, c]) => c.flags.unique).map(([n]) => [n]), ...(options.unique ?? [])];
  const indexes = [...entries.filter(([, c]) => c.flags.index).map(([n]) => ({ name: `${name}_${n}`, columns: [{ column: n }] })), ...(options.indexes ?? [])];
  return tableSpec({
    kind: 'table',
    name,
    columns: entries.map(([n, c]) => ({ name: n, ...c.spec })),
    ...(primaryKey ? { primaryKey: { columns: primaryKey } } : {}),
    ...(unique.length ? { unique: unique.map((columns) => ({ columns })) } : {}),
    ...(indexes.length ? { indexes } : {}),
    ...(options.foreignKeys?.length ? { foreignKeys: options.foreignKeys } : {}),
    ...(options.storage && options.storage !== 'row' ? { storage: options.storage } : {}),
    ...(options.renamedFrom ? { renamedFrom: options.renamedFrom } : {}),
  });
}

/** A table spec from run-time data (JSON, a catalog, a file's header), checked. Its rows are untyped. */
export function tableSpec<Row = Record<string, Value>>(spec: Omit<TableSpec, '$row'>): TableSpec<Row> {
  const names = new Set<string>();
  for (const c of spec.columns) {
    const key = c.name.toLowerCase();
    if (names.has(key)) throw new Error(`table ${spec.name}: column ${c.name} appears twice`);
    names.add(key);
  }
  const known = (cols: readonly string[], what: string) => {
    for (const c of cols) if (!names.has(c.toLowerCase())) throw new Error(`table ${spec.name}: ${what} names unknown column ${c}`);
  };
  if (spec.primaryKey) known(spec.primaryKey.columns, 'the primary key');
  for (const u of spec.unique ?? []) known(u.columns, 'a unique key');
  for (const i of spec.indexes ?? []) known(i.columns.map((c) => c.column), `index ${i.name}`);
  for (const f of spec.foreignKeys ?? []) known(f.columns, 'a foreign key');
  return spec as TableSpec<Row>;
}

/** Infer a table spec from sample rows (a file, an API response): the run-time front door for discovered schemas. */
export function inferTable(name: string, rows: readonly Record<string, unknown>[], options: { primaryKey?: readonly string[] } = {}): TableSpec {
  const types = new Map<string, StorageType | null>();
  const nullable = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const t: StorageType | null = v === null || v === undefined ? null : typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v)) ? 'INTEGER' : typeof v === 'number' ? 'REAL' : typeof v === 'boolean' ? 'INTEGER' : v instanceof Uint8Array ? 'BLOB' : 'TEXT';
      if (t === null) nullable.add(k);
      const prev = types.get(k);
      if (prev === undefined || prev === null) types.set(k, t);
      else if (t !== null && prev !== t) types.set(k, prev === 'INTEGER' && t === 'REAL' ? 'REAL' : prev === 'REAL' && t === 'INTEGER' ? 'REAL' : 'ANY');
    }
  }
  for (const row of rows) for (const k of types.keys()) if (!(k in row)) nullable.add(k);
  return tableSpec({
    kind: 'table',
    name,
    columns: [...types].map(([n, t]) => ({ name: n, type: t ?? 'ANY', ...(!nullable.has(n) && options.primaryKey?.includes(n) ? { notNull: true } : {}) })),
    ...(options.primaryKey ? { primaryKey: { columns: options.primaryKey } } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Specs as engine definitions.

// LIST and STRUCT need their element types for a precise plan type: milestone 2 (specs with the engine's types).
const PLAN_TYPE: Record<StorageType, plan.PlanType> = { INTEGER: 'int', REAL: 'real', NUMERIC: 'num', TEXT: 'text', BLOB: 'blob', ANY: 'any', BOOLEAN: 'bool', DATE: 'date', DATETIME: 'datetime', TIME: 'time', DURATION: 'duration', LIST: 'any', STRUCT: 'any' };
export const planTypeOf = (t: StorageType): plan.PlanType => PLAN_TYPE[t];

export function columnIndex(spec: TableSpec<any>, name: string): number {
  const i = spec.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new Error(`table ${spec.name} has no column ${name}`);
  return i;
}

function columnDef(c: ColumnSpec): plan.ColumnDef {
  return {
    name: c.name,
    declaredType: c.type,
    type: c.type,
    notNull: c.notNull ?? false,
    collation: c.collation ?? 'binary',
    ...(c.default !== undefined ? { default: { text: literalText(c.default), expr: { k: 'lit', value: c.default, type: litType(c.default) }, value: c.default } } : {}),
  };
}

export function toColumnDef(c: ColumnSpec): plan.ColumnDef {
  return columnDef(c);
}

const litType = (v: Value): plan.PlanType => (v === null ? 'null' : typeof v === 'string' ? 'text' : v instanceof Uint8Array ? 'blob' : typeof v === 'bigint' || Number.isInteger(v) ? 'int' : 'real');
const literalText = (v: Value): string => (v === null ? 'NULL' : typeof v === 'string' ? JSON.stringify(v) : v instanceof Uint8Array ? `blob(${v.length})` : String(v));

/** The engine's `TableDef` for a spec. */
export function toTableDef(spec: TableSpec<any>): plan.TableDef {
  const key = (k: KeySpec, kind: 'primaryKey' | 'unique'): plan.KeyDef => ({
    kind,
    columns: k.columns.map((c) => ({ column: columnIndex(spec, c), desc: false, collation: spec.columns[columnIndex(spec, c)]!.collation ?? 'binary' })),
    ...(k.name ? { name: k.name } : {}),
  });
  return {
    name: spec.name,
    storage: spec.storage ?? 'row',
    columns: spec.columns.map(columnDef),
    keys: [...(spec.primaryKey ? [key(spec.primaryKey, 'primaryKey')] : []), ...(spec.unique ?? []).map((u) => key(u, 'unique'))],
    checks: [],
    foreignKeys: (spec.foreignKeys ?? []).map((f) => ({
      columns: f.columns.map((c) => columnIndex(spec, c)),
      table: f.table,
      ...(f.refColumns ? { refColumns: f.refColumns } : {}),
      onDelete: f.onDelete ?? 'NO ACTION',
      onUpdate: f.onUpdate ?? 'NO ACTION',
      deferrable: false,
      isDeferrable: false,
    })),
  };
}

/** The engine's `IndexDef` for an index of a spec. */
export function toIndexDef(spec: TableSpec<any>, index: IndexSpec): plan.IndexDef {
  return {
    name: index.name,
    table: spec.name,
    unique: index.unique ?? false,
    columns: index.columns.map((c) => {
      const i = columnIndex(spec, c.column);
      return { column: i, desc: c.desc ?? false, collation: c.collation ?? spec.columns[i]!.collation ?? 'binary' };
    }),
  };
}
