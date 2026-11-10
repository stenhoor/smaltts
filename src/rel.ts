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
import { AGGREGATE, type AggregateName, SCALAR, type ScalarName } from './functions.js';
import { type Collation, type StorageType, type TableSpec, type Value, columnPlanType } from './spec.js';

// ---------------------------------------------------------------------------------------------------------------
// The IR.

export type ExprNode =
  | { readonly k: 'col'; readonly name: string }
  /** A literal; `date: true` marks a JavaScript `Date`, kept as ISO text and typed by what it is compared with. */
  | { readonly k: 'lit'; readonly value: Value | boolean; readonly date?: true }
  | { readonly k: 'param'; readonly name: string; readonly type: P.PlanType }
  | { readonly k: 'fn'; readonly name: string; readonly args: readonly ExprNode[]; readonly collation?: Collation }
  | { readonly k: 'and' | 'or'; readonly args: readonly ExprNode[] }
  | { readonly k: 'not'; readonly arg: ExprNode }
  | { readonly k: 'isNull'; readonly arg: ExprNode; readonly not: boolean }
  | { readonly k: 'agg'; readonly name: string; readonly args: readonly ExprNode[]; readonly distinct?: boolean; readonly filter?: ExprNode };

/** A column of a source given in the plan: its name, storage type and, for a list or struct, its full plan type. */
export interface ColumnType {
  readonly name: string;
  readonly type: StorageType;
  readonly planType?: string;
}

export type RelNode =
  | { readonly r: 'scan'; readonly table: string }
  | { readonly r: 'values'; readonly columns: readonly ColumnType[]; readonly rows: readonly (readonly (Value | boolean)[])[] }
  | { readonly r: 'function'; readonly name: string; readonly args: readonly Value[]; readonly named?: Readonly<Record<string, Value>>; readonly columns: readonly ColumnType[] }
  | { readonly r: 'filter'; readonly input: RelNode; readonly pred: ExprNode }
  | { readonly r: 'select'; readonly input: RelNode; readonly fields: readonly (readonly [string, ExprNode])[] }
  | { readonly r: 'join'; readonly kind: 'inner' | 'left' | 'semi' | 'anti' | 'cross'; readonly left: RelNode; readonly right: RelNode; readonly on?: ExprNode; readonly prefix?: string }
  | { readonly r: 'aggregate'; readonly input: RelNode; readonly keys: readonly (readonly [string, ExprNode])[]; readonly aggs: readonly (readonly [string, ExprNode])[] }
  | { readonly r: 'sort'; readonly input: RelNode; readonly keys: readonly { readonly expr: ExprNode; readonly desc: boolean }[] }
  | { readonly r: 'limit'; readonly input: RelNode; readonly count: number; readonly offset?: number }
  | { readonly r: 'distinct'; readonly input: RelNode }
  | { readonly r: 'union'; readonly all: boolean; readonly inputs: readonly [RelNode, RelNode] };

// ---------------------------------------------------------------------------------------------------------------
// Typed expressions.

/** The TypeScript type of an engine plan type's values (`null` aside), as smaltts reads them (`date`, `datetime`: `Date`). */
type TsOf<T extends string> = T extends 'int' | 'real' | 'num' ? number : T extends 'date' | 'datetime' ? Date : T extends 'text' | 'time' | 'duration' ? string : T extends 'bool' ? boolean : T extends 'blob' ? Uint8Array : Value | boolean;
type Arg<T> = Expr<T> | T;
type Truth = boolean | number | null;

/** A typed expression over named columns. `T` is the TypeScript type of its values (with `null` when nullable). */
export class Expr<T> {
  declare readonly $type: T;
  readonly node: ExprNode;
  constructor(node: ExprNode) {
    this.node = node;
  }
  private call<R>(name: string, ...args: Arg<unknown>[]): Expr<R> {
    return new Expr<R>({ k: 'fn', name, args: [this.node, ...args.map(toNode)] });
  }
  /** `cmp_eq`: equal (NULL if either side is NULL). */
  eq(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_eq', other); }
  /** `cmp_ne` */
  ne(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_ne', other); }
  /** `cmp_lt` */
  lt(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_lt', other); }
  /** `cmp_le` */
  lte(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_le', other); }
  /** `cmp_gt` */
  gt(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_gt', other); }
  /** `cmp_ge` */
  gte(other: Arg<T>): Expr<boolean | null> { return this.call('cmp_ge', other); }
  /** `cmp_is`: equal, where NULL equals NULL; never NULL. */
  is(other: Arg<T | null>): Expr<boolean> { return this.call('cmp_is', other); }
  /** `cmp_is_not` */
  isNot(other: Arg<T | null>): Expr<boolean> { return this.call('cmp_is_not', other); }
  /** `in_list` */
  in(values: readonly Arg<T>[]): Expr<boolean | null> { return this.call('in_list', ...values); }
  /** `like` */
  like(pattern: Arg<string>): Expr<boolean | null> { return this.call('like', pattern); }
  /** `glob` */
  glob(pattern: Arg<string>): Expr<boolean | null> { return this.call('glob', pattern); }
  /** The logic node `and`. */
  and(other: Arg<Truth>): Expr<boolean | null> { return new Expr({ k: 'and', args: [this.node, toNode(other)] }); }
  /** The logic node `or`. */
  or(other: Arg<Truth>): Expr<boolean | null> { return new Expr({ k: 'or', args: [this.node, toNode(other)] }); }
  /** The logic node `not`. */
  not(): Expr<boolean | null> { return new Expr({ k: 'not', arg: this.node }); }
  /** The `isNull` node: never NULL. */
  isNull(): Expr<boolean> { return new Expr({ k: 'isNull', arg: this.node, not: false }); }
  isNotNull(): Expr<boolean> { return new Expr({ k: 'isNull', arg: this.node, not: true }); }
  /** `coalesce`: the value, or `fallback` where it is NULL. */
  orElse(fallback: Arg<NonNullable<T>>): Expr<NonNullable<T>> { return this.call('coalesce', fallback); }
  /** The collation a comparison compares text by. */
  collate(collation: Collation): Expr<T> {
    if (this.node.k !== 'fn') throw new Error('collate() applies to a comparison');
    return new Expr<T>({ ...this.node, collation });
  }
}

const toNode = (v: unknown): ExprNode =>
  v instanceof Expr ? v.node : v instanceof Date ? { k: 'lit', value: v.toISOString(), date: true } : { k: 'lit', value: v as Value | boolean };

export const lit = <T extends Value | boolean | Date>(value: T): Expr<T> => new Expr(toNode(value));
export const col = <T = Value>(name: string): Expr<T> => new Expr({ k: 'col', name });
export const and = (...preds: Arg<Truth>[]): Expr<boolean | null> => new Expr({ k: 'and', args: preds.map(toNode) });
export const or = (...preds: Arg<Truth>[]): Expr<boolean | null> => new Expr({ k: 'or', args: preds.map(toNode) });
export const not = (pred: Arg<Truth>): Expr<boolean | null> => new Expr({ k: 'not', arg: toNode(pred) });

/** Every engine operation and scalar function, by its engine name: `fn.div_float(o.total, 2)`. */
export const fn: { readonly [K in ScalarName]: (...args: Arg<any>[]) => Expr<TsOf<(typeof SCALAR)[K]> | null> } = new Proxy({} as never, {
  get: (_, name) => (typeof name === 'string' && name in SCALAR ? (...args: unknown[]) => new Expr({ k: 'fn', name, args: args.map(toNode) }) : undefined),
});

/** Named parameters: values given when the plan runs. */
export const param = {
  int: (name: string): Expr<number> => new Expr({ k: 'param', name, type: 'int' }),
  real: (name: string): Expr<number> => new Expr({ k: 'param', name, type: 'real' }),
  text: (name: string): Expr<string> => new Expr({ k: 'param', name, type: 'text' }),
  bool: (name: string): Expr<boolean> => new Expr({ k: 'param', name, type: 'bool' }),
  date: (name: string): Expr<Date> => new Expr({ k: 'param', name, type: 'date' }),
  datetime: (name: string): Expr<Date> => new Expr({ k: 'param', name, type: 'datetime' }),
  any: (name: string): Expr<Value> => new Expr({ k: 'param', name, type: 'any' }),
};

/**
 * Every engine aggregate, by its engine name, for `Rel.aggregate`: `agg.sum(o.total)`, `agg.count()` (rows),
 * `agg.count(e, { distinct: true })`.
 */
export const agg: { readonly [K in AggregateName]: (...args: (Arg<any> | AggOptions)[]) => Expr<TsOf<(typeof AGGREGATE)[K]['result']> | null> } = new Proxy({} as never, {
  get: (_, name) =>
    typeof name === 'string' && name in AGGREGATE
      ? (...args: unknown[]) => {
          const last = args[args.length - 1];
          const options = last && typeof last === 'object' && !(last instanceof Expr) && !(last instanceof Uint8Array) ? (args.pop() as AggOptions) : {};
          return new Expr({ k: 'agg', name, args: args.map(toNode), ...(options.distinct ? { distinct: true } : {}), ...(options.filter ? { filter: options.filter.node } : {}) });
        }
      : undefined,
});

export interface AggOptions {
  readonly distinct?: boolean;
  /** Only the rows where this is true count. */
  readonly filter?: Expr<Truth>;
}

// ---------------------------------------------------------------------------------------------------------------
// Typed relations.

type AnyRow = Record<string, unknown>;
/** The columns of a row, as expressions. */
export type Cols<R> = { readonly [K in keyof R]: Expr<R[K]> };
type Fields = Record<string, Expr<any>>;
type RowOfFields<F extends Fields> = { [K in keyof F]: F[K]['$type'] };
type Prefixed<R, Px extends string> = { [K in keyof R & string as `${Px}${K}`]: R[K] };
type Nullable<R> = { [K in keyof R]: R[K] | null };
type Pred = Expr<Truth>;

function colsProxy<R>(): Cols<R> {
  return new Proxy({} as Cols<R>, { get: (_, name) => (typeof name === 'string' ? col(name) : undefined) });
}

export class Rel<Row extends AnyRow = AnyRow> {
  declare readonly $row: Row;
  readonly node: RelNode;
  constructor(node: RelNode) {
    this.node = node;
  }

  /** Keep the rows where `pred` is true. */
  filter(pred: (r: Cols<Row>) => Pred): Rel<Row> {
    return new Rel({ r: 'filter', input: this.node, pred: pred(colsProxy<Row>()).node });
  }
  /** Compute a new set of columns. */
  select<F extends Fields>(fields: (r: Cols<Row>) => F): Rel<RowOfFields<F>> {
    return new Rel({ r: 'select', input: this.node, fields: Object.entries(fields(colsProxy<Row>())).map(([n, e]) => [n, e.node] as const) });
  }
  /** Keep every column and add (or replace) some. */
  extend<F extends Fields>(fields: (r: Cols<Row>) => F): Rel<Omit<Row, keyof F> & RowOfFields<F>> {
    return new Rel({ r: 'select', input: this.node, fields: [['*', { k: 'lit', value: null }], ...Object.entries(fields(colsProxy<Row>())).map(([n, e]) => [n, e.node] as const)] });
  }
  /** Keep only these columns, in this order. */
  pick<K extends keyof Row & string>(...names: K[]): Rel<Pick<Row, K>> {
    return new Rel({ r: 'select', input: this.node, fields: names.map((n) => [n, { k: 'col', name: n }] as const) });
  }
  /** Join `right`. Its columns follow this one's; `prefix` renames them (needed when names collide). */
  join<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: { prefix?: Px } = {}): Rel<Row & Prefixed<S, Px>> {
    return this.joinOf('inner', right, on, options);
  }
  /** Join `right`, keeping rows of this relation without a match (the right columns are then NULL). */
  leftJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Pred, options: { prefix?: Px } = {}): Rel<Row & Nullable<Prefixed<S, Px>>> {
    return this.joinOf('left', right, on, options);
  }
  /** The rows that have a match in `right`. */
  semiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Pred): Rel<Row> {
    return this.joinOf('semi', right, on as never, {}) as never;
  }
  /** The rows that have no match in `right`. */
  antiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Pred): Rel<Row> {
    return this.joinOf('anti', right, on as never, {}) as never;
  }
  private joinOf(kind: 'inner' | 'left' | 'semi' | 'anti', right: Rel<any>, on: (l: any, r: any) => Pred, options: { prefix?: string }): Rel<any> {
    // Both sides' columns are referenced by name; collisions are resolved (or rejected) when the plan is compiled.
    const pred = on(colsProxy(), colsProxy()).node;
    return new Rel({ r: 'join', kind, left: this.node, right: right.node, on: pred, ...(options.prefix ? { prefix: options.prefix } : {}) });
  }
  /** Group by `keys` and compute `aggs` per group (no keys: one row for all of them). */
  aggregate<K extends Fields, A extends Fields>(keys: (r: Cols<Row>) => K, aggs: (r: Cols<Row>) => A): Rel<RowOfFields<K> & RowOfFields<A>> {
    const c = colsProxy<Row>();
    return new Rel({ r: 'aggregate', input: this.node, keys: Object.entries(keys(c)).map(([n, e]) => [n, e.node] as const), aggs: Object.entries(aggs(c)).map(([n, e]) => [n, e.node] as const) });
  }
  /** Order rows; prefix a column with `-` for descending: `sort('-total', 'name')`. */
  sort(...keys: (`${keyof Row & string}` | `-${keyof Row & string}`)[]): Rel<Row> {
    return new Rel({ r: 'sort', input: this.node, keys: keys.map((k) => (k.startsWith('-') ? { expr: { k: 'col', name: k.slice(1) }, desc: true } : { expr: { k: 'col', name: k }, desc: false })) });
  }
  limit(count: number, offset?: number): Rel<Row> {
    return new Rel({ r: 'limit', input: this.node, count, ...(offset !== undefined ? { offset } : {}) });
  }
  distinct(): Rel<Row> {
    return new Rel({ r: 'distinct', input: this.node });
  }
  union(other: Rel<Row>, options: { all?: boolean } = {}): Rel<Row> {
    return new Rel({ r: 'union', all: options.all ?? true, inputs: [this.node, other.node] });
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

/** A table function from a plugin (`read_csv`, …), with the columns it gives. */
export function tableFunction<Row extends AnyRow = AnyRow>(name: string, args: readonly Value[], columns: readonly ColumnType[], named?: Record<string, Value>): Rel<Row> {
  return new Rel({ r: 'function', name, args, columns, ...(named ? { named } : {}) });
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
  const params: string[] = [];
  const out = compile(rel instanceof Rel ? rel.node : rel, resolver, params);
  return { ...out, params };
}

/** Where a plan node came from, given back on the engine's errors (ADR 0016 §10). */
const origin = (call: string): { readonly origin: P.PlanOrigin } => ({ origin: { smaltts: call } });

function compile(n: RelNode, cat: Resolver, params: string[]): { plan: P.PlanOp; fields: Field[] } {
  const at = (plan: P.PlanOp, call: string): P.PlanOp => ({ ...plan, ...origin(call) }) as P.PlanOp;
  switch (n.r) {
    case 'scan': {
      const t = cat.table(n.table);
      if (t) return { plan: at(P.scan(t.name, t.columns.map((_, i) => i)), 'scan'), fields: t.columns.map((c) => ({ name: c.name, type: columnPlanType(c), collation: c.collation ?? 'binary' })) };
      const view = cat.view?.(n.table);
      if (view) return compile(view, cat, params);
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
      const input = compile(n.input, cat, params);
      return { plan: at(P.filter(input.plan, expr(n.pred, [input.fields], params, cat).e), 'filter'), fields: input.fields };
    }
    case 'select': {
      const input = compile(n.input, cat, params);
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
        const c = expr(node, [input.fields], params, cat);
        fields.push({ name, type: c.type, collation: c.collation });
        exprs.push(c.e);
      }
      return { plan: at(P.project(input.plan, exprs), star ? 'extend' : 'select'), fields };
    }
    case 'join': {
      const left = compile(n.left, cat, params);
      const right = compile(n.right, cat, params);
      const rightFields = right.fields.map((f) => ({ ...f, name: (n.prefix ?? '') + f.name }));
      const on = n.on ? expr(n.on, [left.fields, rightFields], params, cat).e : undefined;
      if (n.kind === 'semi' || n.kind === 'anti') return { plan: at(P.join(n.kind, left.plan, right.plan, on), `${n.kind}Join`), fields: left.fields };
      const names = new Set(left.fields.map((f) => f.name.toLowerCase()));
      const clash = rightFields.find((f) => names.has(f.name.toLowerCase()));
      if (clash) throw new Error(`join: both sides have a column named ${clash.name}; give the right side a prefix`);
      return { plan: at(P.join(n.kind, left.plan, right.plan, on), n.kind === 'left' ? 'leftJoin' : 'join'), fields: [...left.fields, ...rightFields] };
    }
    case 'aggregate': {
      const input = compile(n.input, cat, params);
      const keys = n.keys.map(([name, node]) => ({ name, ...expr(node, [input.fields], params, cat) }));
      const aggs = n.aggs.map(([name, node]) => {
        if (node.k !== 'agg') throw new Error(`aggregate: ${name} is not an aggregate`);
        const args = node.args.map((a) => expr(a, [input.fields], params, cat));
        const def = AGGREGATE[node.name as keyof typeof AGGREGATE];
        if (!def) throw new Error(`aggregate: no aggregate named ${node.name}`);
        const type = (cat.resultType?.(node.name, args.map((a) => a.type)) ?? def.result) as P.PlanType;
        const filter = node.filter ? expr(node.filter, [input.fields], params, cat).e : undefined;
        return { name, type, call: P.agg(node.name, args.map((a) => a.e), type, { star: node.name === 'count' && args.length === 0, distinct: !!node.distinct, ...(filter ? { filter } : {}) }) };
      });
      return {
        plan: at(P.aggregate(input.plan, keys.map((k) => k.e), aggs.map((a) => a.call), { collations: keys.map((k) => k.collation) }), 'aggregate'),
        fields: [...keys.map((k) => ({ name: k.name, type: k.type, collation: k.collation })), ...aggs.map((a) => ({ name: a.name, type: a.type, collation: 'binary' as Collation }))],
      };
    }
    case 'sort': {
      const input = compile(n.input, cat, params);
      const keys = n.keys.map((k) => {
        const c = expr(k.expr, [input.fields], params, cat);
        return k.desc ? P.desc(c.e, { collation: c.collation }) : P.asc(c.e, { collation: c.collation });
      });
      return { plan: at(P.sort(input.plan, keys), 'sort'), fields: input.fields };
    }
    case 'limit': {
      const input = compile(n.input, cat, params);
      return { plan: at(P.limit(input.plan, n.count, n.offset), 'limit'), fields: input.fields };
    }
    case 'distinct': {
      const input = compile(n.input, cat, params);
      return { plan: at(P.distinct(input.plan, input.fields.length, input.fields.map((f) => f.collation)), 'distinct'), fields: input.fields };
    }
    case 'union': {
      const a = compile(n.inputs[0], cat, params);
      const b = compile(n.inputs[1], cat, params);
      const names = (fs: Field[]) => fs.map((f) => f.name.toLowerCase()).join(',');
      if (names(a.fields) !== names(b.fields)) throw new Error(`union: the inputs have different columns (${names(a.fields)} / ${names(b.fields)})`);
      return { plan: at(P.setop(n.all ? 'unionAll' : 'union', a.plan, b.plan, a.fields.length, a.fields.map((f) => f.collation)), 'union'), fields: a.fields };
    }
  }
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
export function expr(n: ExprNode, scopes: readonly (readonly Field[])[], params: string[], cat: Pick<Resolver, 'resultType'> = {}): { e: P.PlanExpr; type: P.PlanType; collation: Collation } {
  switch (n.k) {
    case 'col': {
      for (let input = 0; input < scopes.length; input++) {
        const index = scopes[input]!.findIndex((f) => f.name.toLowerCase() === n.name.toLowerCase());
        if (index >= 0) {
          const f = scopes[input]![index]!;
          return { e: P.col(input, index, f.type, f.collation), type: f.type, collation: f.collation };
        }
      }
      throw new Error(`no column named ${n.name} (columns: ${scopes.flat().map((f) => f.name).join(', ')})`);
    }
    case 'lit': {
      const e = literal(n.value, undefined, n.date);
      return { e, type: (e as { type: P.PlanType }).type, collation: 'binary' };
    }
    case 'param': {
      let i = params.indexOf(n.name);
      if (i < 0) i = params.push(n.name) - 1;
      return { e: P.param(i, n.type), type: n.type, collation: 'binary' };
    }
    case 'agg':
      throw new Error(`agg.${n.name} is only allowed in aggregate()`);
    case 'and':
    case 'or': {
      const args = n.args.map((a) => expr(a, scopes, params, cat).e);
      return { e: { ...(n.k === 'and' ? P.and(...args) : P.or(...args)), ...origin(n.k) }, type: 'bool', collation: 'binary' };
    }
    case 'not':
      return { e: { ...P.not(expr(n.arg, scopes, params, cat).e), ...origin('not') }, type: 'bool', collation: 'binary' };
    case 'isNull': {
      const arg = expr(n.arg, scopes, params, cat).e;
      return { e: { ...(n.not ? P.isNotNull(arg) : P.isNull(arg)), ...origin(n.not ? 'isNotNull' : 'isNull') }, type: 'bool', collation: 'binary' };
    }
    case 'fn': {
      if (!(n.name in SCALAR)) throw new Error(`fn.${n.name}: the engine has no such function`);
      // A Date literal takes the temporal type of what it is compared or combined with (a date counts days).
      const isDate = (a: ExprNode) => a.k === 'lit' && a.date === true;
      const others = n.args.map((a) => (isDate(a) ? null : expr(a, scopes, params, cat)));
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
