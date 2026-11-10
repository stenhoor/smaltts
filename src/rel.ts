/**
 * Relations: plans as values.
 *
 * A `Rel<Row>` is an immutable, JSON-safe description of a relational plan that refers to columns by NAME (its IR,
 * `RelNode`). `compileRel` resolves the names against the tables' specs and produces the engine's positional
 * `PlanOp`. The IR is what smaltts stores as the source of its views; the engine never sees it.
 *
 * smaltts is thin (ADR 0023): every expression is one of the engine's operations or functions, by its engine name
 * (`fn.div_float`, `fn.add_checked`). Methods on expressions are short aliases only where an operation has one meaning
 * (`.eq` is `cmp_eq`, `.and` the logic node).
 */
import * as P from 'smaltdb/plan';
import { AGGREGATE, ARITY, SCALAR, type ScalarName } from './functions.js';
import { type Cols, type ExprNode, type Truth, Expr, toNode } from './expr.js';
import { type Collation, type StorageType, type TableSpec, type Value, columnPlanType } from './spec.js';

export { type AggOptions, type Arg, type Cols, type ExprNode, type OneColumn, type Truth, Expr, agg, and, caseWhen, col, exists, fn, lit, not, or, param, scalar } from './expr.js';

export interface ColumnType {
  readonly name: string;
  readonly type: StorageType;
  readonly planType?: string;
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti' | 'cross' | 'asof';

/** A window frame bound; `offset` (for `preceding` and `following`) counts rows, peer groups or a value's distance. */
export interface FrameBound {
  readonly kind: 'unboundedPreceding' | 'preceding' | 'currentRow' | 'following' | 'unboundedFollowing';
  readonly offset?: number;
}

/** A window frame: the engine's, with numbers for offsets. */
export interface Frame {
  readonly unit: 'ROWS' | 'RANGE' | 'GROUPS';
  readonly start: FrameBound;
  readonly end: FrameBound;
  readonly exclude?: 'NO OTHERS' | 'CURRENT ROW' | 'GROUP' | 'TIES';
}

/** A count or fraction: a number, or an expression over no columns (a parameter). */
export type Amount = number | ExprNode;

export type RelNode =
  | { readonly r: 'scan'; readonly table: string }
  | { readonly r: 'values'; readonly columns: readonly ColumnType[]; readonly rows: readonly (readonly (Value | boolean)[])[] }
  /** Values given as one array per column (typed arrays among them): for loads, not views, as typed arrays are not JSON. */
  | { readonly r: 'columns'; readonly columns: readonly ColumnType[]; readonly data: readonly P.ValueColumn[] }
  | { readonly r: 'function'; readonly name: string; readonly args: readonly Value[]; readonly named?: Readonly<Record<string, Value>>; readonly columns: readonly ColumnType[] }
  | { readonly r: 'filter'; readonly input: RelNode; readonly pred: ExprNode }
  | { readonly r: 'select'; readonly input: RelNode; readonly fields: readonly (readonly [string, ExprNode])[] }
  | {
      readonly r: 'join';
      readonly kind: JoinKind;
      readonly left: RelNode;
      readonly right: RelNode;
      readonly on?: ExprNode;
      readonly prefix?: string;
      readonly ordered?: true;
      readonly asof?: { readonly left: ExprNode; readonly right: ExprNode; readonly direction: 'backward' | 'forward' | 'nearest'; readonly tolerance?: ExprNode };
    }
  | { readonly r: 'aggregate'; readonly input: RelNode; readonly keys: readonly (readonly [string, ExprNode])[]; readonly aggs: readonly (readonly [string, ExprNode])[]; readonly ordered?: true }
  | { readonly r: 'sort'; readonly input: RelNode; readonly keys: readonly { readonly expr: ExprNode; readonly desc: boolean }[] }
  | { readonly r: 'limit'; readonly input: RelNode; readonly count: Amount; readonly offset?: Amount; readonly fromEnd?: true }
  | { readonly r: 'distinct'; readonly input: RelNode; readonly on?: readonly string[]; readonly keep?: 'first' | 'last'; readonly ordered?: true }
  | { readonly r: 'union'; readonly all: boolean; readonly inputs: readonly [RelNode, RelNode] }
  | { readonly r: 'setop'; readonly kind: 'intersect' | 'except'; readonly inputs: readonly [RelNode, RelNode] }
  | { readonly r: 'sample'; readonly input: RelNode; readonly count?: Amount; readonly fraction?: Amount; readonly replace: boolean; readonly seed: number }
  | { readonly r: 'explode'; readonly input: RelNode; readonly column: string; readonly position?: string; readonly emptyAsNull?: true; readonly keepNulls?: false }
  | {
      readonly r: 'pivot';
      readonly input: RelNode;
      readonly keys: readonly (readonly [string, ExprNode])[];
      readonly on: ExprNode;
      readonly values: readonly Value[];
      readonly aggs: readonly (readonly [string, ExprNode])[];
      readonly ordered?: true;
    }
  | {
      readonly r: 'window';
      readonly input: RelNode;
      readonly partition: readonly string[];
      readonly order: readonly { readonly expr: ExprNode; readonly desc: boolean }[];
      readonly frame?: Frame;
      readonly calls: readonly (readonly [string, ExprNode])[];
    }
  /** Recursion: `init`'s rows, then `step`'s over the rows the previous step gave (`working` with the same name). */
  | { readonly r: 'iterate'; readonly name: string; readonly init: RelNode; readonly step: RelNode; readonly distinct?: true }
  | { readonly r: 'working'; readonly name: string }
  | { readonly r: 'unpivot'; readonly input: RelNode; /** Absent: every column not unpivoted. */ readonly keep?: readonly string[]; readonly columns: readonly string[]; readonly name: string; readonly value: string };

// ---------------------------------------------------------------------------------------------------------------
// Typed relations.

type AnyRow = Record<string, unknown>;
type Fields = Record<string, Expr<any>>;
type RowOfFields<F extends Fields> = { [K in keyof F]: F[K]['$type'] };
type Prefixed<R, Px extends string> = { [K in keyof R & string as `${Px}${K}`]: R[K] };
type Nullable<R> = { [K in keyof R]: R[K] | null };
type Pred = Expr<Truth>;
type Names<Row> = keyof Row & string;
type ElementOf<T> = T extends readonly (infer E)[] ? E | null : unknown;

let scopes = 0;

/**
 * The columns a builder call hands its callbacks, and how it binds what they return. A reference is tagged with the
 * call's scope; binding removes the tag from the call's own references, and turns those inside a subquery into
 * correlated ones (`outer`: how many subqueries in). A relation built inside a callback binds its own references first,
 * so what remains tagged in it belongs to an enclosing call. The JSON that results has no tags.
 */
function scope<R>(): { cols: Cols<R>; bind: <T>(v: T) => T } {
  const id = ++scopes;
  const cols = new Proxy({} as Cols<R>, { get: (_, name) => (typeof name === 'string' ? new Expr({ k: 'col', name, scope: id }) : undefined) });
  return { cols, bind: (v) => bind(id, v, 0) };
}

function bind<T>(id: number, v: T, depth: number): T {
  if (Array.isArray(v)) return v.map((x) => bind(id, x, depth)) as T;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  const o = v as Record<string, unknown>;
  if (o.k === 'col' && o.scope === id) return (depth ? { k: 'col', name: o.name, outer: depth } : { k: 'col', name: o.name }) as T;
  const sub = o.k === 'exists' || o.k === 'scalar' || o.k === 'inRel';
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, bind(id, x, sub && k === 'rel' ? depth + 1 : depth)])) as T;
}

type SortKeys<Row> = readonly (`${Names<Row>}` | `-${Names<Row>}`)[];
const sortKeys = (keys: readonly string[]): { expr: ExprNode; desc: boolean }[] =>
  keys.map((k) => (k.startsWith('-') ? { expr: { k: 'col', name: k.slice(1) }, desc: true } : { expr: { k: 'col', name: k }, desc: false }));

const fieldsOf = (f: Fields): (readonly [string, ExprNode])[] => Object.entries(f).map(([n, e]) => [n, e.node] as const);
const amount = (v: number | Expr<number>): Amount => (typeof v === 'number' ? v : v.node);

export interface JoinOptions<Px extends string> {
  /** Renames the right side's columns (needed when names collide). */
  readonly prefix?: Px;
  /** Keep the left side's order, and for each left row its matches in the right side's order. */
  readonly ordered?: boolean;
}

export interface AsofOptions<Row, S, Px extends string> extends JoinOptions<Px> {
  /** `backward` (default): the largest right key at or below the left's; `forward`: the smallest at or above; `nearest`. */
  readonly direction?: 'backward' | 'forward' | 'nearest';
  /** The largest distance between the keys. */
  readonly tolerance?: number | Expr<unknown>;
  /** Only right rows this matches are candidates. */
  readonly on?: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred;
}

export class Rel<Row extends AnyRow = AnyRow> {
  declare readonly $row: Row;
  readonly node: RelNode;
  constructor(node: RelNode) {
    this.node = node;
  }

  /** Keep the rows where `pred` is true. */
  filter(pred: (r: Cols<Row>) => Pred): Rel<Row> {
    const s = scope<Row>();
    return new Rel({ r: 'filter', input: this.node, pred: s.bind(pred(s.cols).node) });
  }
  /** Compute a new set of columns. */
  select<F extends Fields>(fields: (r: Cols<Row>) => F): Rel<RowOfFields<F>> {
    const s = scope<Row>();
    return new Rel({ r: 'select', input: this.node, fields: s.bind(fieldsOf(fields(s.cols))) });
  }
  /** Keep every column and add (or replace) some. */
  extend<F extends Fields>(fields: (r: Cols<Row>) => F): Rel<Omit<Row, keyof F> & RowOfFields<F>> {
    const s = scope<Row>();
    return new Rel({ r: 'select', input: this.node, fields: [['*', { k: 'lit', value: null }], ...s.bind(fieldsOf(fields(s.cols)))] });
  }
  /** Keep only these columns, in this order. */
  pick<K extends Names<Row>>(...names: K[]): Rel<Pick<Row, K>> {
    return new Rel({ r: 'select', input: this.node, fields: names.map((n) => [n, { k: 'col', name: n }] as const) });
  }
  /** Join `right`. Its columns follow this one's; `prefix` renames them (needed when names collide). */
  join<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: JoinOptions<Px> = {}): Rel<Row & Prefixed<S, Px>> {
    return this.joinOf('inner', right, on, options);
  }
  /** Join `right`, keeping rows of this relation without a match (the right columns are then NULL). */
  leftJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: JoinOptions<Px> = {}): Rel<Row & Nullable<Prefixed<S, Px>>> {
    return this.joinOf('left', right, on, options);
  }
  /** Join `right`, keeping rows of `right` without a match (this relation's columns are then NULL). */
  rightJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: JoinOptions<Px> = {}): Rel<Nullable<Row> & Prefixed<S, Px>> {
    return this.joinOf('right', right, on, options);
  }
  /** Join `right`, keeping the rows of either side without a match. */
  fullJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: JoinOptions<Px> = {}): Rel<Nullable<Row> & Nullable<Prefixed<S, Px>>> {
    return this.joinOf('full', right, on, options);
  }
  /** Every row of this relation with every row of `right`. */
  crossJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, options: JoinOptions<Px> = {}): Rel<Row & Prefixed<S, Px>> {
    return this.joinOf('cross', right, undefined, options);
  }
  /** The rows that have a match in `right`. */
  semiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Pred): Rel<Row> {
    return this.joinOf('semi', right, on as never, {}) as never;
  }
  /** The rows that have no match in `right`. */
  antiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Pred): Rel<Row> {
    return this.joinOf('anti', right, on as never, {}) as never;
  }
  /**
   * Each row of this relation, in order, with the row of `right` whose key is nearest its own (`keys` gives the left
   * key and the right key), or NULLs when none is near enough.
   */
  asofJoin<S extends AnyRow, Px extends string = ''>(
    right: Rel<S>,
    keys: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => readonly [Expr<unknown>, Expr<unknown>],
    options: AsofOptions<Row, S, Px> = {},
  ): Rel<Row & Nullable<Prefixed<S, Px>>> {
    const s = scope<any>();
    const [l, r] = keys(s.cols, s.cols);
    const tolerance = options.tolerance === undefined ? undefined : toNode(options.tolerance);
    const asof = { left: s.bind(l.node), right: s.bind(r.node), direction: options.direction ?? 'backward', ...(tolerance ? { tolerance } : {}) } as const;
    return new Rel({ ...this.joinNode('asof', right, options.on, options), asof });
  }
  private joinOf(kind: JoinKind, right: Rel<any>, on: ((l: any, r: any) => Pred) | undefined, options: JoinOptions<string>): Rel<any> {
    return new Rel(this.joinNode(kind, right, on, options));
  }
  private joinNode(kind: JoinKind, right: Rel<any>, on: ((l: any, r: any) => Pred) | undefined, options: JoinOptions<string>): Extract<RelNode, { r: 'join' }> {
    // Both sides' columns are referenced by name; collisions are resolved (or rejected) when the plan is compiled.
    const s = scope<any>();
    const pred = on ? s.bind(on(s.cols, s.cols).node) : undefined;
    return {
      r: 'join',
      kind,
      left: this.node,
      right: right.node,
      ...(pred ? { on: pred } : {}),
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(options.ordered ? { ordered: true as const } : {}),
    };
  }
  /**
   * Group by `keys` and compute `aggs` per group (no keys: one row for all of them). `ordered`: the groups in the order
   * of their first row.
   */
  aggregate<K extends Fields, A extends Fields>(keys: (r: Cols<Row>) => K, aggs: (r: Cols<Row>) => A, options: { ordered?: boolean } = {}): Rel<RowOfFields<K> & RowOfFields<A>> {
    const s = scope<Row>();
    return new Rel({ r: 'aggregate', input: this.node, keys: s.bind(fieldsOf(keys(s.cols))), aggs: s.bind(fieldsOf(aggs(s.cols))), ...(options.ordered ? { ordered: true as const } : {}) });
  }
  /** Order rows; prefix a column with `-` for descending: `sort('-total', 'name')`. */
  sort(...keys: SortKeys<Row>): Rel<Row> {
    return new Rel({ r: 'sort', input: this.node, keys: sortKeys(keys) });
  }
  /**
   * Window functions and aggregates over each row's window: every column, then one per call. Rows are grouped by the
   * `partition` columns and ordered by `order` (as `sort`'s keys) within it; the frame defaults to the partition's rows
   * up to the current row and its peers (the whole partition without an order).
   */
  window<F extends Fields>(calls: (r: Cols<Row>) => F, options: { partition?: readonly Names<Row>[]; order?: SortKeys<Row>; frame?: Frame } = {}): Rel<Row & RowOfFields<F>> {
    const s = scope<Row>();
    return new Rel({
      r: 'window',
      input: this.node,
      partition: options.partition ?? [],
      order: sortKeys(options.order ?? []),
      ...(options.frame ? { frame: options.frame } : {}),
      calls: s.bind(fieldsOf(calls(s.cols))),
    });
  }
  /** The first `count` rows after `offset`; `fromEnd`: the last `count` rows before the last `offset`, in order. */
  limit(count: number | Expr<number>, offset?: number | Expr<number>, options: { fromEnd?: boolean } = {}): Rel<Row> {
    return new Rel({ r: 'limit', input: this.node, count: amount(count), ...(offset !== undefined ? { offset: amount(offset) } : {}), ...(options.fromEnd ? { fromEnd: true as const } : {}) });
  }
  /**
   * The distinct rows. `on`: the columns that decide which rows are duplicates (default: all); `keep`: which row of each
   * set to keep, by input order; `ordered`: the rows in the order of their first occurrence.
   */
  distinct(options: { on?: readonly Names<Row>[]; keep?: 'first' | 'last'; ordered?: boolean } = {}): Rel<Row> {
    return new Rel({
      r: 'distinct',
      input: this.node,
      ...(options.on ? { on: options.on } : {}),
      ...(options.keep ? { keep: options.keep } : {}),
      ...(options.ordered ? { ordered: true as const } : {}),
    });
  }
  union(other: Rel<Row>, options: { all?: boolean } = {}): Rel<Row> {
    return new Rel({ r: 'union', all: options.all ?? true, inputs: [this.node, other.node] });
  }
  /** The distinct rows that are also in `other`. */
  intersect(other: Rel<Row>): Rel<Row> {
    return new Rel({ r: 'setop', kind: 'intersect', inputs: [this.node, other.node] });
  }
  /** The distinct rows that are not in `other`. */
  except(other: Rel<Row>): Rel<Row> {
    return new Rel({ r: 'setop', kind: 'except', inputs: [this.node, other.node] });
  }
  /**
   * Rows drawn at random, fixed by `seed`: `count` of them or a `fraction` of all. Without `replace` they keep their
   * order; with it a row may be drawn more than once, in the order drawn.
   */
  sample(size: { count: number | Expr<number> } | { fraction: number | Expr<number> }, options: { replace?: boolean; seed?: number } = {}): Rel<Row> {
    return new Rel({
      r: 'sample',
      input: this.node,
      ...('count' in size ? { count: amount(size.count) } : { fraction: amount(size.fraction) }),
      replace: options.replace ?? false,
      seed: options.seed ?? 0,
    });
  }
  /**
   * One row per element of the list column `column`, which takes the element's value. An empty list gives no row
   * (one with NULL with `emptyAsNull`), a NULL list one row with NULL (none with `keepNulls: false`). `position` names
   * a last column with the element's position, from 0.
   */
  explode<K extends Names<Row>, Pos extends string = never>(
    column: K,
    options: { position?: Pos; emptyAsNull?: boolean; keepNulls?: boolean } = {},
  ): Rel<Omit<Row, K> & { [P in K]: ElementOf<Row[K]> } & { [P in Pos]: number }> {
    return new Rel({
      r: 'explode',
      input: this.node,
      column,
      ...(options.position ? { position: options.position } : {}),
      ...(options.emptyAsNull ? { emptyAsNull: true as const } : {}),
      ...(options.keepNulls === false ? { keepNulls: false as const } : {}),
    });
  }
  /**
   * Values of `on` as columns: one row per group of `keys`, then for each of `values` and each of `aggs` the aggregate
   * over the group's rows whose `on` is that value. A column is named by its value (`${value}_${agg}` with more than
   * one aggregate).
   */
  pivot<K extends Fields>(options: {
    keys: (r: Cols<Row>) => K;
    on: (r: Cols<Row>) => Expr<unknown>;
    values: readonly Value[];
    aggs: (r: Cols<Row>) => Fields;
    ordered?: boolean;
  }): Rel<RowOfFields<K> & AnyRow> {
    const s = scope<Row>();
    return new Rel({
      r: 'pivot',
      input: this.node,
      keys: s.bind(fieldsOf(options.keys(s.cols))),
      on: s.bind(options.on(s.cols).node),
      values: options.values,
      aggs: s.bind(fieldsOf(options.aggs(s.cols))),
      ...(options.ordered ? { ordered: true as const } : {}),
    });
  }
  /**
   * `columns` as rows: each row gives one row per column, with the `keep` columns (default: the others), the column's
   * name (in `name`, default `name`) and its value (in `value`, default `value`).
   */
  unpivot<C extends Names<Row>, Kp extends Names<Row> = Exclude<Names<Row>, C>, N extends string = 'name', V extends string = 'value'>(
    columns: readonly C[],
    options: { keep?: readonly Kp[]; name?: N; value?: V } = {},
  ): Rel<Pick<Row, Kp> & { [P in N]: string } & { [P in V]: Row[C] }> {
    return new Rel({ r: 'unpivot', input: this.node, ...(options.keep ? { keep: options.keep } : {}), columns, name: options.name ?? 'name', value: options.value ?? 'value' });
  }
  /** The IR as JSON: what smaltts stores as a view's source. */
  toJSON(): RelNode {
    return this.node;
  }
}

/** A table's rows, or a view's. */
export function scan<Row extends AnyRow>(table: TableSpec<Row>): Rel<Row>;
export function scan(table: string): Rel;
export function scan(table: TableSpec<any> | string): Rel<any> {
  return new Rel({ r: 'scan', table: typeof table === 'string' ? table : table.name });
}

/** Rows given in JavaScript, with their column types. */
export function values<Row extends AnyRow>(columns: readonly (ColumnType & { name: keyof Row & string })[], rows: readonly Row[]): Rel<Row> {
  return new Rel({ r: 'values', columns, rows: rows.map((row) => columns.map((c) => (row[c.name] ?? null) as Value | boolean)) });
}

/**
 * Rows given as one array per column (typed arrays, arrays of values, or either with a null bitmap `{ data, nulls }`),
 * with their column types: the engine's `values` from columns. For loads and queries; a view can't store typed arrays.
 */
export function fromColumns<Row extends AnyRow = AnyRow>(columns: readonly ColumnType[], data: readonly P.ValueColumn[]): Rel<Row> {
  if (data.length !== columns.length) throw new Error(`fromColumns: ${columns.length} columns, ${data.length} arrays`);
  return new Rel({ r: 'columns', columns, data });
}

/** A table function from a plugin (`read_csv`, …), with the columns it gives. */
export function tableFunction<Row extends AnyRow = AnyRow>(name: string, args: readonly Value[], columns: readonly ColumnType[], named?: Record<string, Value>): Rel<Row> {
  return new Rel({ r: 'function', name, args, columns, ...(named ? { named } : {}) });
}

/**
 * Recursion: `init`'s rows, then `step`'s, applied to the rows the previous step gave, until a step gives none.
 * `distinct` drops rows given before (and so ends cycles). Each step's rows have `init`'s columns.
 */
export function iterate<Row extends AnyRow>(init: Rel<Row>, step: (previous: Rel<Row>) => Rel<Row>, options: { distinct?: boolean; name?: string } = {}): Rel<Row> {
  const name = options.name ?? 'iterate';
  return new Rel({ r: 'iterate', name, init: init.node, step: step(new Rel({ r: 'working', name })).node, ...(options.distinct ? { distinct: true as const } : {}) });
}

export function relFromJSON<Row extends AnyRow = AnyRow>(node: RelNode): Rel<Row> {
  return new Rel(node);
}

// ---------------------------------------------------------------------------------------------------------------
// Compiling: names to positions.

/** What compiling needs of the catalog. */
export interface Resolver {
  /** A table's (or materialized view's) columns by name. */
  table(name: string): TableSpec<any> | undefined;
  /** A smaltts view's relation, inlined where it is read. */
  view?(name: string): RelNode | undefined;
  /** A view in another language that declares its columns: read by name, its columns typed `any`. */
  foreignView?(name: string): readonly string[] | undefined;
  /** The engine's result type of a function for these argument types (the catalog's `resultType`). */
  resultType?(name: string, args: readonly P.PlanType[]): P.PlanType | undefined;
}

export interface Field {
  readonly name: string;
  readonly type: P.PlanType;
  readonly collation: Collation;
}

export interface Compiled {
  readonly plan: P.PlanOp;
  readonly fields: readonly Field[];
  /** Parameter names by position. */
  readonly params: readonly string[];
}

/** Compile a relation to the engine's plan. */
export function compileRel(rel: Rel<any> | RelNode, resolver: Resolver): Compiled {
  const ctx = context(resolver, []);
  const out = compile(rel instanceof Rel ? rel.node : rel, ctx);
  return { ...out, params: ctx.params };
}

/** What compiling carries down the tree. */
interface Ctx {
  readonly cat: Resolver;
  readonly params: string[];
  /** The scopes of the operations a subquery is nested in, innermost first: what an outer column reference reads. */
  readonly outer: readonly (readonly (readonly Field[])[])[];
  /** The open `iterate`s, by name: their ids and their rows' fields. */
  readonly working: ReadonlyMap<string, { readonly id: number; readonly fields: readonly Field[] }>;
  readonly ids: { n: number };
}

const context = (cat: Resolver, params: string[]): Ctx => ({ cat, params, outer: [], working: new Map(), ids: { n: 0 } });

/** Where a plan node came from, given back on the engine's errors (ADR 0016 §10). */
const origin = (call: string): { readonly origin: P.PlanOrigin } => ({ origin: { smaltts: call } });

function compile(n: RelNode, ctx: Ctx): { plan: P.PlanOp; fields: Field[] } {
  const cat = ctx.cat;
  const at = (plan: P.PlanOp, call: string): P.PlanOp => ({ ...plan, ...origin(call) }) as P.PlanOp;
  switch (n.r) {
    case 'scan': {
      const t = cat.table(n.table);
      if (t) return { plan: at(P.scan(t.name, t.columns.map((_, i) => i)), 'scan'), fields: t.columns.map((c) => ({ name: c.name, type: columnPlanType(c), collation: c.collation ?? 'binary' })) };
      const view = cat.view?.(n.table);
      if (view) return compile(view, ctx);
      const names = cat.foreignView?.(n.table);
      if (names) return { plan: at(P.scan(n.table, names.map((_, i) => i)), 'scan'), fields: names.map((name) => ({ name, type: 'any', collation: 'binary' })) };
      throw new Error(`scan: no table or view named ${n.table}`);
    }
    case 'values': {
      const types = n.columns.map(columnPlanType);
      return { plan: at(P.values(n.rows.map((row) => row.map((v, i) => literal(v, types[i]))), types), 'values'), fields: n.columns.map((c, i) => ({ name: c.name, type: types[i]!, collation: 'binary' })) };
    }
    case 'function': {
      const types = n.columns.map(columnPlanType);
      const named = n.named ? Object.fromEntries(Object.entries(n.named).map(([k, v]) => [k, P.lit(v)])) : undefined;
      return { plan: at({ op: 'source', kind: 'function', name: n.name, args: n.args.map((v) => P.lit(v)), ...(named ? { named } : {}), types }, 'tableFunction'), fields: n.columns.map((c, i) => ({ name: c.name, type: types[i]!, collation: 'binary' })) };
    }
    case 'filter': {
      const input = compile(n.input, ctx);
      return { plan: at(P.filter(input.plan, exprIn(n.pred, [input.fields], ctx).e), 'filter'), fields: input.fields };
    }
    case 'select': {
      const input = compile(n.input, ctx);
      const fields: Field[] = [];
      const exprs: P.PlanExpr[] = [];
      const star = n.fields[0]?.[0] === '*';
      const computed = star ? n.fields.slice(1) : n.fields;
      const replaced = new Set(computed.map(([name]) => name.toLowerCase()));
      if (star) {
        input.fields.forEach((f, i) => {
          if (replaced.has(f.name.toLowerCase())) return;
          fields.push(f);
          exprs.push(P.col(0, i, f.type, f.collation));
        });
      }
      for (const [name, node] of computed) {
        const c = exprIn(node, [input.fields], ctx);
        fields.push({ name, type: c.type, collation: c.collation });
        exprs.push(c.e);
      }
      return { plan: at(P.project(input.plan, exprs), star ? 'extend' : 'select'), fields };
    }
    case 'columns': {
      const types = n.columns.map(columnPlanType);
      return { plan: at(P.fromColumns(n.data, types), 'fromColumns'), fields: n.columns.map((c, i) => ({ name: c.name, type: types[i]!, collation: 'binary' })) };
    }
    case 'join': {
      const left = compile(n.left, ctx);
      const right = compile(n.right, ctx);
      const rightFields = right.fields.map((f) => ({ ...f, name: (n.prefix ?? '') + f.name }));
      const scopes = [left.fields, rightFields];
      const on = n.on ? exprIn(n.on, scopes, ctx).e : undefined;
      const call = JOIN_CALL[n.kind];
      let plan: P.PlanOp = P.join(n.kind, left.plan, right.plan, on, { ordered: !!n.ordered });
      if (n.asof) {
        const tolerance = n.asof.tolerance ? exprIn(n.asof.tolerance, [], ctx).e : undefined;
        plan = P.asofJoin(left.plan, right.plan, exprIn(n.asof.left, scopes, ctx).e, exprIn(n.asof.right, scopes, ctx).e, { direction: n.asof.direction, ...(tolerance ? { tolerance } : {}), ...(on ? { on } : {}) });
        if (n.ordered) plan = { ...plan, ordered: true } as P.PlanOp;
      }
      if (n.kind === 'semi' || n.kind === 'anti') return { plan: at(plan, call), fields: left.fields };
      const names = new Set(left.fields.map((f) => f.name.toLowerCase()));
      const clash = rightFields.find((f) => names.has(f.name.toLowerCase()));
      if (clash) throw new Error(`${call}: both sides have a column named ${clash.name}; give the right side a prefix`);
      return { plan: at(plan, call), fields: [...left.fields, ...rightFields] };
    }
    case 'aggregate': {
      const input = compile(n.input, ctx);
      const keys = n.keys.map(([name, node]) => ({ name, ...exprIn(node, [input.fields], ctx) }));
      const aggs = n.aggs.map(([name, node]) => ({ name, ...aggCall('aggregate', name, node, [input.fields], ctx) }));
      return {
        plan: at(P.aggregate(input.plan, keys.map((k) => k.e), aggs.map((a) => a.call), { collations: keys.map((k) => k.collation), ...(n.ordered ? { ordered: 'first' as const } : {}) }), 'aggregate'),
        fields: [...keys.map((k) => ({ name: k.name, type: k.type, collation: k.collation })), ...aggs.map((a) => ({ name: a.name, type: a.type, collation: 'binary' as Collation }))],
      };
    }
    case 'sort': {
      const input = compile(n.input, ctx);
      return { plan: at(P.sort(input.plan, n.keys.map((k) => sortKey(k, [input.fields], ctx))), 'sort'), fields: input.fields };
    }
    case 'limit': {
      const input = compile(n.input, ctx);
      const count = typeof n.count === 'number' ? n.count : exprIn(n.count, [], ctx).e;
      const offset = n.offset === undefined || typeof n.offset === 'number' ? n.offset : exprIn(n.offset, [], ctx).e;
      return { plan: at(P.limit(input.plan, count, offset, { fromEnd: !!n.fromEnd }), 'limit'), fields: input.fields };
    }
    case 'distinct': {
      const input = compile(n.input, ctx);
      const on = n.on?.map((name) => fieldIndex(input.fields, name, 'distinct'));
      const options = { ...(n.ordered ? { ordered: 'first' as const } : {}), ...(on ? { on } : {}), ...(n.keep ? { keep: n.keep } : {}) };
      return { plan: at(P.distinct(input.plan, input.fields.length, input.fields.map((f) => f.collation), options), 'distinct'), fields: input.fields };
    }
    case 'union':
    case 'setop': {
      const kind = n.r === 'union' ? (n.all ? 'unionAll' : 'union') : n.kind;
      const call = n.r === 'union' ? 'union' : n.kind;
      const a = compile(n.inputs[0], ctx);
      const b = compile(n.inputs[1], ctx);
      const names = (fs: Field[]) => fs.map((f) => f.name.toLowerCase()).join(',');
      if (names(a.fields) !== names(b.fields)) throw new Error(`${call}: the inputs have different columns (${names(a.fields)} / ${names(b.fields)})`);
      return { plan: at(P.setop(kind, a.plan, b.plan, a.fields.length, a.fields.map((f) => f.collation)), call), fields: a.fields };
    }
    case 'sample': {
      const input = compile(n.input, ctx);
      const size = (v: Amount) => (typeof v === 'number' ? v : exprIn(v, [], ctx).e);
      const plan = P.sample(input.plan, n.count !== undefined ? { count: size(n.count) } : { fraction: size(n.fraction!) }, { replace: n.replace, seed: n.seed });
      return { plan: at(plan, 'sample'), fields: input.fields };
    }
    case 'explode': {
      const input = compile(n.input, ctx);
      const i = fieldIndex(input.fields, n.column, 'explode');
      const type = input.fields[i]!.type;
      const element = /^list<(.*)>$/.exec(type)?.[1];
      if (element === undefined) throw new Error(`explode: ${n.column} is ${type}, not a list`);
      const fields = input.fields.map((f, j) => (j === i ? { ...f, type: element as P.PlanType } : f));
      if (n.position) fields.push({ name: n.position, type: 'int', collation: 'binary' });
      const plan = P.explode(input.plan, i, type, { position: !!n.position, emptyAsNull: !!n.emptyAsNull, ...(n.keepNulls === false ? { keepNulls: false } : {}) });
      return { plan: at(plan, 'explode'), fields };
    }
    case 'pivot': {
      const input = compile(n.input, ctx);
      const scopes = [input.fields];
      const keys = n.keys.map(([name, node]) => ({ name, ...exprIn(node, scopes, ctx) }));
      const on = exprIn(n.on, scopes, ctx);
      const aggs = n.aggs.map(([name, node]) => ({ name, ...aggCall('pivot', name, node, scopes, ctx) }));
      const fields: Field[] = keys.map((k) => ({ name: k.name, type: k.type, collation: k.collation }));
      for (const v of n.values) for (const a of aggs) fields.push({ name: aggs.length === 1 ? String(v) : `${String(v)}_${a.name}`, type: a.type, collation: 'binary' });
      const plan = P.pivot(input.plan, keys.map((k) => k.e), on.e, n.values, aggs.map((a) => a.call), { collations: keys.map((k) => k.collation), collation: on.collation, ...(n.ordered ? { ordered: 'first' as const } : {}) });
      return { plan: at(plan, 'pivot'), fields };
    }
    case 'window': {
      const input = compile(n.input, ctx);
      const scopes = [input.fields];
      const partition = n.partition.map((name) => exprIn({ k: 'col', name }, scopes, ctx));
      const order = n.order.map((k) => sortKey(k, scopes, ctx));
      const calls = n.calls.map(([name, node]) => ({ name, ...windowCall(name, node, scopes, ctx) }));
      const bound = (b: FrameBound): P.FrameBound => (b.offset === undefined ? { kind: b.kind } : { kind: b.kind, offset: P.lit(b.offset) });
      const frame = n.frame ? P.frame(n.frame.unit, bound(n.frame.start), bound(n.frame.end), n.frame.exclude) : undefined;
      const plan = P.window(input.plan, calls.map((c) => c.call), { partition: partition.map((p) => p.e), collations: partition.map((p) => p.collation), order, ...(frame ? { frame } : {}) });
      return { plan: at(plan, 'window'), fields: [...input.fields, ...calls.map((c) => ({ name: c.name, type: c.type, collation: 'binary' as Collation }))] };
    }
    case 'iterate': {
      const init = compile(n.init, ctx);
      const id = ctx.ids.n++;
      const working = new Map(ctx.working).set(n.name, { id, fields: init.fields });
      const step = compile(n.step, { ...ctx, working });
      const names = (fs: readonly Field[]) => fs.map((f) => f.name.toLowerCase()).join(',');
      if (names(init.fields) !== names(step.fields)) throw new Error(`iterate: the step's columns (${names(step.fields)}) are not the initial rows' (${names(init.fields)})`);
      const plan = P.iterate(id, n.name, init.plan, [step.plan], n.distinct ? { distinct: true, collations: init.fields.map((f) => f.collation) } : {});
      return { plan: at(plan, 'iterate'), fields: init.fields };
    }
    case 'working': {
      const w = ctx.working.get(n.name);
      if (!w) throw new Error(`iterate: ${n.name}'s previous rows are read outside its step`);
      return { plan: at(P.working(w.id, w.fields.map((f) => f.type)), 'iterate'), fields: [...w.fields] };
    }
    case 'unpivot': {
      const input = compile(n.input, ctx);
      const columns = n.columns.map((name) => fieldIndex(input.fields, name, 'unpivot'));
      const keep = n.keep ? n.keep.map((name) => fieldIndex(input.fields, name, 'unpivot')) : input.fields.map((_, i) => i).filter((i) => !columns.includes(i));
      const types = new Set(columns.map((i) => input.fields[i]!.type));
      const type: P.PlanType = types.size === 1 ? [...types][0]! : 'any';
      const fields: Field[] = [...keep.map((i) => input.fields[i]!), { name: n.name, type: 'text', collation: 'binary' }, { name: n.value, type, collation: 'binary' }];
      return { plan: at(P.unpivot(input.plan, keep, columns, columns.map((i) => input.fields[i]!.name), type), 'unpivot'), fields };
    }
  }
}

const JOIN_CALL: Record<JoinKind, string> = { inner: 'join', left: 'leftJoin', right: 'rightJoin', full: 'fullJoin', semi: 'semiJoin', anti: 'antiJoin', cross: 'crossJoin', asof: 'asofJoin' };

function fieldIndex(fields: readonly Field[], name: string, call: string): number {
  const i = fields.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new Error(`${call}: no column named ${name} (columns: ${fields.map((f) => f.name).join(', ')})`);
  return i;
}

/** Refuses a call with an argument count the engine's catalog doesn't allow, naming the call. */
function arity(call: string, name: string, given: number): void {
  const [min, max] = ARITY[name] ?? [0, null];
  if (given >= min && (max === null || given <= max)) return;
  const takes = max === null ? `at least ${min}` : min === max ? `${min}` : `${min} to ${max}`;
  throw new Error(`${call}: takes ${takes} argument${takes === '1' ? '' : 's'}, not ${given}`);
}

function sortKey(k: { readonly expr: ExprNode; readonly desc: boolean }, scopes: readonly (readonly Field[])[], ctx: Ctx): P.SortKey {
  const c = exprIn(k.expr, scopes, ctx);
  return k.desc ? P.desc(c.e, { collation: c.collation }) : P.asc(c.e, { collation: c.collation });
}

/** A call of `window`: a window function, or an aggregate over the frame. */
function windowCall(name: string, node: ExprNode, scopes: readonly (readonly Field[])[], ctx: Ctx): { type: P.PlanType; call: P.WindowCall } {
  if (node.k !== 'agg') throw new Error(`window: ${name} is not a window function or aggregate`);
  const def = AGGREGATE[node.name as keyof typeof AGGREGATE];
  if (!def) throw new Error(`window: no window function or aggregate named ${node.name}`);
  if (node.distinct) throw new Error(`window: agg.${node.name} can't be distinct in a window`);
  arity(`window: agg.${node.name}`, node.name, node.args.length);
  const args = node.args.map((a) => exprIn(a, scopes, ctx));
  const type = (ctx.cat.resultType?.(node.name, args.map((a) => a.type)) ?? def.result) as P.PlanType;
  const filter = node.filter ? exprIn(node.filter, scopes, ctx).e : undefined;
  return { type, call: P.windowCall(node.name, args.map((a) => a.e), type, { star: node.name === 'count' && args.length === 0, ...(filter ? { filter } : {}), ...(node.ignoreNulls ? { ignoreNulls: true } : {}) }) };
}

/** An aggregate call of `aggregate` or `pivot`. */
function aggCall(call: string, name: string, node: ExprNode, scopes: readonly (readonly Field[])[], ctx: Ctx): { type: P.PlanType; call: P.AggCall } {
  const cat = ctx.cat;
  if (node.k !== 'agg') throw new Error(`${call}: ${name} is not an aggregate`);
  const def = AGGREGATE[node.name as keyof typeof AGGREGATE];
  if (!def) throw new Error(`${call}: no aggregate named ${node.name}`);
  if (def.kind !== 'aggregate') throw new Error(`${call}: agg.${node.name} is a window function; use it in window()`);
  arity(`${call}: agg.${node.name}`, node.name, node.args.length);
  const args = node.args.map((a) => exprIn(a, scopes, ctx));
  const type = (cat.resultType?.(node.name, args.map((a) => a.type)) ?? def.result) as P.PlanType;
  const filter = node.filter ? exprIn(node.filter, scopes, ctx).e : undefined;
  return { type, call: P.agg(node.name, args.map((a) => a.e), type, { star: node.name === 'count' && args.length === 0, distinct: !!node.distinct, ...(filter ? { filter } : {}) }) };
}

/** A literal: a JavaScript boolean is a `bool` (1 / 0, ADR 0018); `type` is the column's, where one is known. */
function literal(v: Value | boolean, type?: P.PlanType, date?: boolean): P.PlanExpr {
  if (date && typeof v === 'string') return dateLiteral(v, type);
  if (typeof v === 'boolean') return P.lit(v ? 1 : 0, 'bool');
  if (type === 'bool' && (v === 0 || v === 1)) return P.lit(v, 'bool');
  return P.lit(v);
}

const MS_PER_DAY = 86_400_000;

/** A JavaScript `Date` (as ISO text) as a `date` (days since 1970-01-01) or, by default, a `datetime` (µs). */
function dateLiteral(iso: string, type?: P.PlanType): P.PlanExpr {
  const ms = Date.parse(iso);
  if (type === 'date') return P.lit(Math.floor(ms / MS_PER_DAY), 'date');
  return P.lit(ms * 1000, 'datetime');
}

/** Functions whose `collation` says how they compare text. */
const COMPARES = new Set(['cmp_eq', 'cmp_ne', 'cmp_lt', 'cmp_le', 'cmp_gt', 'cmp_ge', 'cmp_is', 'cmp_is_not', 'in_list', 'like', 'glob']);

/** Compile an expression whose column names resolve against `scopes` (one per input of the owning operation). */
export function expr(n: ExprNode, scopes: readonly (readonly Field[])[], params: string[], cat: Pick<Resolver, 'resultType'> = {}): Typed {
  return exprIn(n, scopes, context({ table: () => undefined, ...cat }, params));
}

type Typed = { e: P.PlanExpr; type: P.PlanType; collation: Collation };

function exprIn(n: ExprNode, scopes: readonly (readonly Field[])[], ctx: Ctx): Typed {
  const cat = ctx.cat;
  switch (n.k) {
    case 'col': {
      // A correlated reference reads the scopes of the operation `outer` subqueries out, at that depth.
      const depth = n.outer ?? 0;
      const at = depth ? ctx.outer[depth - 1] : scopes;
      if (!at) throw new Error(`no enclosing relation ${depth} subqueries out for column ${n.name}`);
      for (let input = 0; input < at.length; input++) {
        const index = at[input]!.findIndex((f) => f.name.toLowerCase() === n.name.toLowerCase());
        if (index >= 0) {
          const f = at[input]![index]!;
          return { e: P.col(input, index, f.type, f.collation, depth), type: f.type, collation: f.collation };
        }
      }
      throw new Error(`no column named ${n.name} (columns: ${at.flat().map((f) => f.name).join(', ')})`);
    }
    case 'case': {
      const whens = n.whens.map((w) => ({ when: exprIn(w.when, scopes, ctx), then: exprIn(w.then, scopes, ctx) }));
      const otherwise = n.else ? exprIn(n.else, scopes, ctx) : undefined;
      const type = [...whens.map((w) => w.then.type), otherwise?.type].find((t) => t && t !== 'null') ?? 'null';
      const e = P.caseWhen(whens.map((w) => ({ when: w.when.e, then: w.then.e })), type, otherwise?.e);
      return { e: { ...e, ...origin('caseWhen') }, type, collation: whens.find((w) => w.then.collation !== 'binary')?.then.collation ?? 'binary' };
    }
    case 'exists':
    case 'scalar':
    case 'inRel': {
      const sub = compile(n.rel, { ...ctx, outer: [scopes, ...ctx.outer] });
      if (n.k === 'exists') return { e: { ...P.exists(sub.plan), ...origin('exists') }, type: 'int', collation: 'binary' };
      if (sub.fields.length !== 1) throw new Error(`${n.k === 'scalar' ? 'scalar' : 'in'}: the subquery has ${sub.fields.length} columns, not one`);
      const f = sub.fields[0]!;
      if (n.k === 'scalar') return { e: { ...P.scalar(sub.plan, f.type, f.collation), ...origin('scalar') }, type: f.type, collation: f.collation };
      const probe = exprIn(n.probe, scopes, ctx);
      const collation = probe.collation !== 'binary' ? probe.collation : f.collation;
      return { e: { ...P.inPlan(probe.e, sub.plan, collation), ...origin('in') }, type: 'int', collation: 'binary' };
    }
    case 'lit': {
      const e = literal(n.value, undefined, n.date);
      return { e, type: (e as { type: P.PlanType }).type, collation: 'binary' };
    }
    case 'param': {
      let i = ctx.params.indexOf(n.name);
      if (i < 0) i = ctx.params.push(n.name) - 1;
      return { e: P.param(i, n.type), type: n.type, collation: 'binary' };
    }
    case 'agg':
      throw new Error(`agg.${n.name} is only allowed in aggregate()`);
    case 'and':
    case 'or': {
      const args = n.args.map((a) => exprIn(a, scopes, ctx).e);
      return { e: { ...(n.k === 'and' ? P.and(...args) : P.or(...args)), ...origin(n.k) }, type: 'bool', collation: 'binary' };
    }
    case 'not':
      return { e: { ...P.not(exprIn(n.arg, scopes, ctx).e), ...origin('not') }, type: 'bool', collation: 'binary' };
    case 'isNull': {
      const arg = exprIn(n.arg, scopes, ctx).e;
      return { e: { ...(n.not ? P.isNotNull(arg) : P.isNull(arg)), ...origin(n.not ? 'isNotNull' : 'isNull') }, type: 'bool', collation: 'binary' };
    }
    case 'fn': {
      if (!(n.name in SCALAR)) throw new Error(`fn.${n.name}: the engine has no such function`);
      arity(`fn.${n.name}`, n.name, n.args.length);
      // A Date literal takes the temporal type of what it is compared or combined with (a date counts days).
      const isDate = (a: ExprNode) => a.k === 'lit' && a.date === true;
      const others = n.args.map((a) => (isDate(a) ? null : exprIn(a, scopes, ctx)));
      const temporal = others.find((a) => a && (a.type === 'date' || a.type === 'datetime'))?.type;
      const args = n.args.map((a, i) => others[i] ?? { e: literal((a as { value: string }).value, temporal, true), type: temporal ?? 'datetime', collation: 'binary' as Collation });
      const textArg = args.find((a) => a.collation !== 'binary');
      const collation: Collation = n.collation ?? textArg?.collation ?? 'binary';
      const type = (cat.resultType?.(n.name, args.map((a) => a.type)) ?? SCALAR[n.name as ScalarName]) as P.PlanType;
      const compares = COMPARES.has(n.name);
      const e = { ...P.call(n.name, args.map((a) => a.e), type, compares ? collation : undefined), ...origin(`fn.${n.name}`) } as P.PlanExpr;
      return { e, type, collation: type === 'text' ? collation : 'binary' };
    }
  }
}
