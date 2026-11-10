/**
 * Schema specs: the desired state of database objects as plain, JSON-safe data.
 *
 * A spec is the one description of a table that every part of smaltts reads: the typed builders (`table()`) produce
 * one, the catalog reader (`catalog.ts`) reads one back from a database, the differ compares two of them, and the
 * engine receives one as a `TableDef`. Specs built at run time (from a file header, another database, a config file)
 * and specs written in code are the same objects; only the second carries a row type.
 */
import type * as plan from 'smaltdb/plan';
import { type Cols, type ExprNode, type Truth, Expr } from './expr.js';

/** How the engine stores a column's values (smaltdb tables are strict). */
export type StorageType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC' | 'ANY' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'TIME' | 'DURATION' | 'LIST' | 'STRUCT';
export type Collation = 'binary' | 'nocase' | 'rtrim';
export type Value = number | bigint | string | Uint8Array | null;

export interface ColumnSpec {
  readonly name: string;
  readonly type: StorageType;
  /** The full plan type of a `LIST` or `STRUCT` column: `list<int>`, `struct<x real, y real>`. */
  readonly planType?: string;
  readonly notNull?: boolean;
  readonly collation?: Collation;
  /** A constant default. */
  readonly default?: Value;
  /** A computed default: an expression over no columns (`fn.random()`), evaluated for each row written. */
  readonly defaultExpr?: ExprNode;
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
  readonly name?: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly refColumns?: readonly string[];
  readonly onDelete?: plan.FkAction;
  readonly onUpdate?: plan.FkAction;
}

/** A CHECK constraint: a predicate over the row, by column name. */
export interface CheckSpec {
  readonly name?: string;
  readonly expr: ExprNode;
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
  readonly checks?: readonly CheckSpec[];
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

/** What a column builder carries beyond its spec: keys, an index, CHECKs and a foreign key, placed by `table()`. */
interface BuilderFlags {
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly index?: boolean;
  readonly checks?: readonly CheckSpec[];
  readonly references?: { readonly table: string; readonly column?: string; readonly onDelete?: plan.FkAction; readonly onUpdate?: plan.FkAction; readonly name?: string };
}

/** The name a column CHECK uses for its own column until `table()` knows it. */
const SELF = '$column';

/** An expression with column `from` renamed to `to`. */
function renameCol(n: ExprNode, from: string, to: string): ExprNode {
  switch (n.k) {
    case 'col':
      return n.name === from ? { ...n, name: to } : n;
    case 'fn':
    case 'and':
    case 'or':
      return { ...n, args: n.args.map((a) => renameCol(a, from, to)) };
    case 'agg':
      return { ...n, args: n.args.map((a) => renameCol(a, from, to)) };
    case 'not':
    case 'isNull':
      return { ...n, arg: renameCol(n.arg, from, to) };
    default:
      return n;
  }
}

/** A column under construction; `T` is its TypeScript value type, `N` whether it may be NULL. */
export class ColumnBuilder<T, N extends boolean = true, D extends boolean = false> {
  /** Phantom fields carrying the column's types. */
  declare readonly $type: T;
  declare readonly $nullable: N;
  declare readonly $hasDefault: D;
  readonly spec: Omit<ColumnSpec, 'name'>;
  readonly flags: BuilderFlags;
  constructor(spec: Omit<ColumnSpec, 'name'>, flags: BuilderFlags = {}) {
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
  /** A computed default: an expression over no columns, evaluated for each row written (`fn.random()`). */
  defaultExpr(expr: Expr<T | null>): ColumnBuilder<T, N, true> {
    const { default: _constant, ...rest } = this.spec;
    return new ColumnBuilder({ ...rest, defaultExpr: expr.node }, this.flags);
  }
  /** A CHECK on this column: `pred` receives the column (`int().check((n) => n.gte(0))`). */
  check(pred: (column: Expr<T>) => Expr<Truth>, name?: string): ColumnBuilder<T, N, D> {
    const check: CheckSpec = { ...(name ? { name } : {}), expr: pred(new Expr({ k: 'col', name: SELF })).node };
    return new ColumnBuilder(this.spec, { ...this.flags, checks: [...(this.flags.checks ?? []), check] });
  }
  /** A foreign key from this column to `column` of `table` (absent: its primary key). */
  references(table: TableSpec<any> | string, column?: string, actions: { onDelete?: plan.FkAction; onUpdate?: plan.FkAction; name?: string } = {}): ColumnBuilder<T, N, D> {
    return new ColumnBuilder(this.spec, { ...this.flags, references: { table: typeof table === 'string' ? table : table.name, ...(column ? { column } : {}), ...actions } });
  }
}

export const int = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'INTEGER' });
export const real = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'REAL' });
export const numeric = (): ColumnBuilder<number> => new ColumnBuilder({ type: 'NUMERIC' });
export const text = (): ColumnBuilder<string> => new ColumnBuilder({ type: 'TEXT' });
export const blob = (): ColumnBuilder<Uint8Array> => new ColumnBuilder({ type: 'BLOB' });
export const any = (): ColumnBuilder<Value> => new ColumnBuilder({ type: 'ANY' });
/** `BOOLEAN`: `true` / `false` (smaltdb ADR 0018). */
export const bool = (): ColumnBuilder<boolean> => new ColumnBuilder({ type: 'BOOLEAN' });
/** `DATE`: a calendar day, read as a `Date` at midnight UTC (smaltdb ADR 0019). */
export const date = (): ColumnBuilder<Date> => new ColumnBuilder({ type: 'DATE' });
/** `DATETIME`: µs, no zone in the type; read as a `Date`, which holds ms (smaltdb ADR 0019). */
export const datetime = (): ColumnBuilder<Date> => new ColumnBuilder({ type: 'DATETIME' });
/** `TIME`: a time of day, read as its text (`12:30:00`). */
export const time = (): ColumnBuilder<string> => new ColumnBuilder({ type: 'TIME' });
/** `DURATION`: µs, read as its ISO 8601 text (`PT1H30M`). */
export const duration = (): ColumnBuilder<string> => new ColumnBuilder({ type: 'DURATION' });

/** The plan type of a column builder's values. */
const planTypeOfBuilder = (b: ColumnBuilder<any, boolean, boolean>): string => b.spec.planType ?? PLAN_TYPE[b.spec.type];

/** `LIST`: a list of `inner`'s values, read as an array (smaltdb ADR 0020). */
export function list<B extends ColumnBuilder<any, boolean, boolean>>(inner: B): ColumnBuilder<ValueOf<B>[]> {
  return new ColumnBuilder({ type: 'LIST', planType: `list<${planTypeOfBuilder(inner)}>` });
}

/** `STRUCT`: named fields in this order, read as an object (smaltdb ADR 0020). */
export function struct<const F extends Columns>(fields: F): ColumnBuilder<RowOf<F>> {
  const parts = Object.entries(fields).map(([name, b]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`struct: field name ${JSON.stringify(name)} must be an identifier`);
    return `${name} ${planTypeOfBuilder(b)}`;
  });
  return new ColumnBuilder({ type: 'STRUCT', planType: `struct<${parts.join(', ')}>` });
}

type Columns = Record<string, ColumnBuilder<any, boolean, boolean>>;
type ValueOf<C> = C extends ColumnBuilder<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never;
/** The row type of a set of column builders. */
export type RowOf<C extends Columns> = { [K in keyof C]: ValueOf<C[K]> };
/** Columns an insert may leave out: nullable, defaulted, or an INTEGER primary key. */
type OptionalKeys<C extends Columns> = { [K in keyof C]: C[K] extends ColumnBuilder<any, infer N, infer D> ? (N extends true ? K : D extends true ? K : never) : never }[keyof C];
export type InsertOf<C extends Columns> = { [K in Exclude<keyof C, OptionalKeys<C>>]: ValueOf<C[K]> } & { [K in OptionalKeys<C>]?: ValueOf<C[K]> };

export interface TableOptions<Row = Record<string, unknown>> {
  /** CHECKs over the row: a list, or named (`{ positive: r.total.gte(0) }`). */
  readonly checks?: (row: Cols<Row>) => readonly Expr<Truth>[] | Readonly<Record<string, Expr<Truth>>>;
  readonly renamedFrom?: string;
  readonly storage?: 'row' | 'columnar';
  readonly primaryKey?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly indexes?: readonly IndexSpec[];
  readonly foreignKeys?: readonly ForeignKeySpec[];
}

/** A table declared in code: a spec whose row type is inferred from its columns. */
export function table<const C extends Columns>(name: string, columns: C, options: TableOptions<RowOf<C>> = {}): TableSpec<RowOf<C>> & { readonly $insert?: InsertOf<C> } {
  const entries = Object.entries(columns);
  const pk = entries.filter(([, c]) => c.flags.primaryKey).map(([n]) => n);
  if (pk.length > 1) throw new Error(`table ${name}: more than one column is marked primaryKey(); give options.primaryKey instead`);
  const primaryKey = options.primaryKey ?? (pk.length ? pk : undefined);
  const unique = [...entries.filter(([, c]) => c.flags.unique).map(([n]) => [n]), ...(options.unique ?? [])];
  const indexes = [...entries.filter(([, c]) => c.flags.index).map(([n]) => ({ name: `${name}_${n}`, columns: [{ column: n }] })), ...(options.indexes ?? [])];
  const columnChecks = entries.flatMap(([n, c]) => (c.flags.checks ?? []).map((k) => ({ ...k, expr: renameCol(k.expr, SELF, n) })));
  const given = options.checks?.(new Proxy({}, { get: (_, p) => (typeof p === 'string' ? new Expr({ k: 'col', name: p }) : undefined) }) as Cols<RowOf<C>>);
  const tableChecks: CheckSpec[] = !given ? [] : Array.isArray(given) ? given.map((e) => ({ expr: e.node })) : Object.entries(given as Record<string, Expr<Truth>>).map(([n, e]) => ({ name: n, expr: e.node }));
  const checks = [...columnChecks, ...tableChecks];
  const foreignKeys: ForeignKeySpec[] = [
    ...entries.flatMap(([n, c]): ForeignKeySpec[] => {
      const r = c.flags.references;
      if (!r) return [];
      return [{ ...(r.name ? { name: r.name } : {}), columns: [n], table: r.table, ...(r.column ? { refColumns: [r.column] } : {}), ...(r.onDelete ? { onDelete: r.onDelete } : {}), ...(r.onUpdate ? { onUpdate: r.onUpdate } : {}) }];
    }),
    ...(options.foreignKeys ?? []),
  ];
  return tableSpec({
    kind: 'table',
    name,
    columns: entries.map(([n, c]) => ({ name: n, ...c.spec })),
    ...(primaryKey ? { primaryKey: { columns: primaryKey } } : {}),
    ...(unique.length ? { unique: unique.map((columns) => ({ columns })) } : {}),
    ...(indexes.length ? { indexes } : {}),
    ...(foreignKeys.length ? { foreignKeys } : {}),
    ...(checks.length ? { checks } : {}),
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
  const types = new Map<string, Inferred | null>();
  const nullable = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const t = inferValue(v);
      if (t === null) nullable.add(k);
      types.set(k, widen(types.get(k) ?? null, t));
    }
  }
  for (const row of rows) for (const k of types.keys()) if (!(k in row)) nullable.add(k);
  return tableSpec({
    kind: 'table',
    name,
    columns: [...types].map(([n, t]) => ({
      name: n,
      type: t?.storage ?? 'ANY',
      ...(t && (t.storage === 'LIST' || t.storage === 'STRUCT') ? { planType: t.plan } : {}),
      ...(!nullable.has(n) && options.primaryKey?.includes(n) ? { notNull: true } : {}),
    })),
    ...(options.primaryKey ? { primaryKey: { columns: options.primaryKey } } : {}),
  });
}

/** A value's storage and plan types, as inferred from JavaScript data. */
interface Inferred {
  readonly storage: StorageType;
  readonly plan: string;
  /** An empty list: a list, but nothing is known of its elements. */
  readonly empty?: true;
}

const ANY: Inferred = { storage: 'ANY', plan: 'any' };

/** The type of one JavaScript value; null for NULL (no information). A `Date` is a `datetime`. */
function inferValue(v: unknown): Inferred | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return { storage: 'BOOLEAN', plan: 'bool' };
  if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) return { storage: 'INTEGER', plan: 'int' };
  if (typeof v === 'number') return { storage: 'REAL', plan: 'real' };
  if (typeof v === 'string') return { storage: 'TEXT', plan: 'text' };
  if (v instanceof Uint8Array) return { storage: 'BLOB', plan: 'blob' };
  if (v instanceof Date) return { storage: 'DATETIME', plan: 'datetime' };
  if (Array.isArray(v)) {
    const inner = v.reduce<Inferred | null>((t, e) => widen(t, inferValue(e)), null);
    return inner ? { storage: 'LIST', plan: `list<${inner.plan}>` } : { storage: 'LIST', plan: 'list<any>', empty: true };
  }
  if (typeof v === 'object') {
    const fields = Object.entries(v as Record<string, unknown>);
    if (fields.every(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
      return { storage: 'STRUCT', plan: `struct<${fields.map(([k, e]) => `${k} ${(inferValue(e) ?? ANY).plan}`).join(', ')}>` };
    }
  }
  return ANY;
}

/** The type that holds values of both: equal types stay, int and real widen to real, anything else is `ANY`. */
function widen(a: Inferred | null, b: Inferred | null): Inferred | null {
  if (a === null) return b;
  if (b === null || a.plan === b.plan) return a;
  if (a.empty && b.storage === 'LIST') return b;
  if (b.empty && a.storage === 'LIST') return a;
  const numbers = new Set([a.plan, b.plan]);
  if (numbers.size === 2 && numbers.has('int') && numbers.has('real')) return { storage: 'REAL', plan: 'real' };
  return ANY;
}

// ---------------------------------------------------------------------------------------------------------------
// Specs as engine definitions.

// LIST and STRUCT need their element types for a precise plan type: milestone 2 (specs with the engine's types).
const PLAN_TYPE: Record<StorageType, plan.PlanType> = { INTEGER: 'int', REAL: 'real', NUMERIC: 'num', TEXT: 'text', BLOB: 'blob', ANY: 'any', BOOLEAN: 'bool', DATE: 'date', DATETIME: 'datetime', TIME: 'time', DURATION: 'duration', LIST: 'any', STRUCT: 'any' };
export const planTypeOf = (t: StorageType): plan.PlanType => PLAN_TYPE[t];
/** A column's plan type: its storage type's, or the full type of a list or struct. */
export const columnPlanType = (c: ColumnSpec): plan.PlanType => (c.planType ?? PLAN_TYPE[c.type]) as plan.PlanType;

export function columnIndex(spec: TableSpec<any>, name: string): number {
  const i = spec.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new Error(`table ${spec.name} has no column ${name}`);
  return i;
}
