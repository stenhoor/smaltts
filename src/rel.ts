/**
 * Relations: plans as values.
 *
 * A `Rel<Row>` is an immutable, JSON-safe description of a relational plan that refers to columns by NAME (its IR,
 * `RelNode`). `compileRel` resolves the names against the tables' specs and produces the engine's positional
 * `PlanOp`. The IR is what smaltts stores as the source of its views, logs, diffs and caches; the engine never sees
 * it.
 *
 * The builder is pipeline-shaped (Calcite's RelBuilder, DataFusion's LogicalPlanBuilder), not query-shaped: every
 * method is one relational operation, applied in the order written.
 */
import * as P from 'smaltdb/plan';
import { type Collation, type StorageType, type TableSpec, type Value, planTypeOf } from './spec.js';

// ---------------------------------------------------------------------------------------------------------------
// The IR.

export type ExprNode =
  | { readonly k: 'col'; readonly name: string }
  | { readonly k: 'lit'; readonly value: Value }
  | { readonly k: 'param'; readonly name: string; readonly type: P.PlanType }
  | { readonly k: 'op'; readonly op: OpName; readonly args: readonly ExprNode[]; readonly collation?: Collation }
  | { readonly k: 'agg'; readonly fn: AggName; readonly args: readonly ExprNode[]; readonly distinct?: boolean };

export type RelNode =
  | { readonly r: 'scan'; readonly table: string }
  | { readonly r: 'values'; readonly columns: readonly { readonly name: string; readonly type: StorageType }[]; readonly rows: readonly (readonly Value[])[] }
  | { readonly r: 'function'; readonly name: string; readonly args: readonly Value[]; readonly named?: Readonly<Record<string, Value>>; readonly columns: readonly { readonly name: string; readonly type: StorageType }[] }
  | { readonly r: 'filter'; readonly input: RelNode; readonly pred: ExprNode }
  | { readonly r: 'select'; readonly input: RelNode; readonly fields: readonly (readonly [string, ExprNode])[] }
  | { readonly r: 'join'; readonly kind: 'inner' | 'left' | 'semi' | 'anti' | 'cross'; readonly left: RelNode; readonly right: RelNode; readonly on?: ExprNode; readonly prefix?: string }
  | { readonly r: 'aggregate'; readonly input: RelNode; readonly keys: readonly (readonly [string, ExprNode])[]; readonly aggs: readonly (readonly [string, ExprNode])[] }
  | { readonly r: 'sort'; readonly input: RelNode; readonly keys: readonly { readonly expr: ExprNode; readonly desc: boolean }[] }
  | { readonly r: 'limit'; readonly input: RelNode; readonly count: number; readonly offset?: number }
  | { readonly r: 'distinct'; readonly input: RelNode }
  | { readonly r: 'union'; readonly all: boolean; readonly inputs: readonly [RelNode, RelNode] };

// ---------------------------------------------------------------------------------------------------------------
// Operations: each smaltts operation names the engine operation that gives its meaning.

const OPS = {
  eq: { fn: 'sql.eq', type: () => 'int' },
  ne: { fn: 'sql.ne', type: () => 'int' },
  lt: { fn: 'sql.lt', type: () => 'int' },
  lte: { fn: 'sql.le', type: () => 'int' },
  gt: { fn: 'sql.gt', type: () => 'int' },
  gte: { fn: 'sql.ge', type: () => 'int' },
  add: { fn: 'sql.add', type: numeric },
  sub: { fn: 'sql.sub', type: numeric },
  mul: { fn: 'sql.mul', type: numeric },
  /** Float division, as TypeScript's `/`: 7 / 2 = 3.5 (the left side is converted to real first). */
  div: { fn: 'sql.div', type: () => 'real' },
  /** Integer division, truncating: 7 intDiv 2 = 3. */
  intDiv: { fn: 'sql.div', type: () => 'int' },
  mod: { fn: 'sql.mod', type: numeric },
  neg: { fn: 'sql.neg', type: numeric },
  concat: { fn: 'sql.concat', type: () => 'text' },
  like: { fn: 'sql.like', type: () => 'int' },
  in: { fn: 'sql.in_list', type: () => 'int' },
  and: { fn: '', type: () => 'int' },
  or: { fn: '', type: () => 'int' },
  not: { fn: '', type: () => 'int' },
  isNull: { fn: '', type: () => 'int' },
  isNotNull: { fn: '', type: () => 'int' },
  coalesce: { fn: 'coalesce', type: (ts) => ts.find((t) => t !== 'null') ?? 'null' },
  lower: { fn: 'lower', type: () => 'text' },
  upper: { fn: 'upper', type: () => 'text' },
  trim: { fn: 'trim', type: () => 'text' },
  length: { fn: 'length', type: () => 'int' },
  abs: { fn: 'abs', type: numeric },
  round: { fn: 'round', type: () => 'real' },
} satisfies Record<string, { fn: string; type: (args: P.PlanType[]) => P.PlanType }>;
export type OpName = keyof typeof OPS;

function numeric(ts: P.PlanType[]): P.PlanType {
  if (ts.every((t) => t === 'int')) return 'int';
  if (ts.some((t) => t === 'real') && ts.every((t) => t === 'int' || t === 'real')) return 'real';
  return 'num';
}

const AGGS = {
  count: (_: P.PlanType[]) => 'int',
  countDistinct: (_: P.PlanType[]) => 'int',
  sum: (ts: P.PlanType[]) => (ts[0] === 'int' ? 'int' : 'num'),
  total: (_: P.PlanType[]) => 'real',
  avg: (_: P.PlanType[]) => 'real',
  min: (ts: P.PlanType[]) => ts[0] ?? 'any',
  max: (ts: P.PlanType[]) => ts[0] ?? 'any',
} satisfies Record<string, (args: P.PlanType[]) => P.PlanType>;
export type AggName = keyof typeof AGGS;

// ---------------------------------------------------------------------------------------------------------------
// Typed expressions.

type Arg<T> = Expr<T> | T;

/** A typed expression over named columns. `T` is the TypeScript type of its values (with `null` when nullable). */
export class Expr<T> {
  declare readonly $type: T;
  constructor(readonly node: ExprNode) {}
  private op<R>(op: OpName, ...args: Arg<unknown>[]): Expr<R> {
    return new Expr<R>({ k: 'op', op, args: [this.node, ...args.map(toNode)] });
  }
  eq(other: Arg<T>): Expr<number> { return this.op('eq', other); }
  ne(other: Arg<T>): Expr<number> { return this.op('ne', other); }
  lt(other: Arg<T>): Expr<number> { return this.op('lt', other); }
  lte(other: Arg<T>): Expr<number> { return this.op('lte', other); }
  gt(other: Arg<T>): Expr<number> { return this.op('gt', other); }
  gte(other: Arg<T>): Expr<number> { return this.op('gte', other); }
  add(other: Arg<number | null>): Expr<T> { return this.op('add', other); }
  sub(other: Arg<number | null>): Expr<T> { return this.op('sub', other); }
  mul(other: Arg<number | null>): Expr<T> { return this.op('mul', other); }
  div(other: Arg<number | null>): Expr<number | null> { return this.op('div', other); }
  intDiv(other: Arg<number | null>): Expr<number | null> { return this.op('intDiv', other); }
  mod(other: Arg<number | null>): Expr<T> { return this.op('mod', other); }
  concat(other: Arg<string | null>): Expr<string> { return this.op('concat', other); }
  like(pattern: Arg<string>): Expr<number> { return this.op('like', pattern); }
  in(values: readonly Arg<T>[]): Expr<number> { return this.op('in', ...values); }
  and(other: Arg<number | null>): Expr<number> { return this.op('and', other); }
  or(other: Arg<number | null>): Expr<number> { return this.op('or', other); }
  not(): Expr<number> { return this.op('not'); }
  isNull(): Expr<number> { return this.op('isNull'); }
  isNotNull(): Expr<number> { return this.op('isNotNull'); }
  /** The value, or `fallback` where it is NULL. */
  orElse(fallback: Arg<NonNullable<T>>): Expr<NonNullable<T>> { return this.op('coalesce', fallback); }
  lower(): Expr<T> { return this.op('lower'); }
  upper(): Expr<T> { return this.op('upper'); }
  /** Compare text by this collation in the comparison this expression is part of. */
  collate(collation: Collation): Expr<T> {
    if (this.node.k !== 'op') throw new Error('collate() applies to a comparison');
    return new Expr<T>({ ...this.node, collation });
  }
}

const toNode = (v: unknown): ExprNode => (v instanceof Expr ? v.node : { k: 'lit', value: v as Value });

export const lit = <T extends Value>(value: T): Expr<T> => new Expr({ k: 'lit', value });
export const col = <T = Value>(name: string): Expr<T> => new Expr({ k: 'col', name });
export const and = (...preds: Expr<number | null>[]): Expr<number> => new Expr({ k: 'op', op: 'and', args: preds.map((p) => p.node) });
export const or = (...preds: Expr<number | null>[]): Expr<number> => new Expr({ k: 'op', op: 'or', args: preds.map((p) => p.node) });

/** Named parameters: values given when the plan runs. */
export const param = {
  int: (name: string): Expr<number> => new Expr({ k: 'param', name, type: 'int' }),
  real: (name: string): Expr<number> => new Expr({ k: 'param', name, type: 'real' }),
  text: (name: string): Expr<string> => new Expr({ k: 'param', name, type: 'text' }),
  any: (name: string): Expr<Value> => new Expr({ k: 'param', name, type: 'any' }),
};

/** Aggregates, for `Rel.aggregate`. */
export const agg = {
  count: (e?: Expr<unknown>): Expr<number> => new Expr({ k: 'agg', fn: 'count', args: e ? [e.node] : [] }),
  countDistinct: (e: Expr<unknown>): Expr<number> => new Expr({ k: 'agg', fn: 'countDistinct', args: [e.node] }),
  sum: <T extends number | null>(e: Expr<T>): Expr<number | null> => new Expr({ k: 'agg', fn: 'sum', args: [e.node] }),
  total: (e: Expr<number | null>): Expr<number> => new Expr({ k: 'agg', fn: 'total', args: [e.node] }),
  avg: (e: Expr<number | null>): Expr<number | null> => new Expr({ k: 'agg', fn: 'avg', args: [e.node] }),
  min: <T>(e: Expr<T>): Expr<T | null> => new Expr({ k: 'agg', fn: 'min', args: [e.node] }),
  max: <T>(e: Expr<T>): Expr<T | null> => new Expr({ k: 'agg', fn: 'max', args: [e.node] }),
};

// ---------------------------------------------------------------------------------------------------------------
// Typed relations.

type AnyRow = Record<string, unknown>;
/** The columns of a row, as expressions. */
export type Cols<R> = { readonly [K in keyof R]: Expr<R[K]> };
type Fields = Record<string, Expr<any>>;
type RowOfFields<F extends Fields> = { [K in keyof F]: F[K]['$type'] };
type Prefixed<R, P extends string> = { [K in keyof R & string as `${P}${K}`]: R[K] };
type Nullable<R> = { [K in keyof R]: R[K] | null };

function colsProxy<R>(): Cols<R> {
  return new Proxy({} as Cols<R>, { get: (_, name) => (typeof name === 'string' ? col(name) : undefined) });
}

export class Rel<Row extends AnyRow = AnyRow> {
  declare readonly $row: Row;
  constructor(readonly node: RelNode) {}

  /** Keep the rows where `pred` is true. */
  filter(pred: (r: Cols<Row>) => Expr<number | null>): Rel<Row> {
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
  join<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Expr<number | null>, options: { prefix?: Px } = {}): Rel<Row & Prefixed<S, Px>> {
    return this.joinOf('inner', right, on, options);
  }
  /** Join `right`, keeping rows of this relation without a match (the right columns are then NULL). */
  leftJoin<S extends AnyRow, Px extends string = ''>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<Prefixed<S, Px>>) => Expr<number | null>, options: { prefix?: Px } = {}): Rel<Row & Nullable<Prefixed<S, Px>>> {
    return this.joinOf('left', right, on, options);
  }
  /** The rows that have a match in `right`. */
  semiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Expr<number | null>): Rel<Row> {
    return this.joinOf('semi', right, on as never, {}) as never;
  }
  /** The rows that have no match in `right`. */
  antiJoin<S extends AnyRow>(right: Rel<S>, on: (l: Cols<Row>, r: Cols<S>) => Expr<number | null>): Rel<Row> {
    return this.joinOf('anti', right, on as never, {}) as never;
  }
  private joinOf(kind: 'inner' | 'left' | 'semi' | 'anti', right: Rel<any>, on: (l: any, r: any) => Expr<number | null>, options: { prefix?: string }): Rel<any> {
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

/** A table's rows. */
export function scan<Row extends AnyRow>(table: TableSpec<Row>): Rel<Row>;
export function scan(table: string): Rel;
export function scan(table: TableSpec<any> | string): Rel<any> {
  return new Rel({ r: 'scan', table: typeof table === 'string' ? table : table.name });
}

/** Rows given in JavaScript, with their column types. */
export function values<Row extends AnyRow>(columns: readonly { name: keyof Row & string; type: StorageType }[], rows: readonly Row[]): Rel<Row> {
  return new Rel({ r: 'values', columns, rows: rows.map((row) => columns.map((c) => (row[c.name] ?? null) as Value)) });
}

/** A table function from a plugin (`read_csv`, …), with the columns it gives. */
export function tableFunction<Row extends AnyRow = AnyRow>(name: string, args: readonly Value[], columns: readonly { name: string; type: StorageType }[], named?: Record<string, Value>): Rel<Row> {
  return new Rel({ r: 'function', name, args, columns, ...(named ? { named } : {}) });
}

export function relFromJSON<Row extends AnyRow = AnyRow>(node: RelNode): Rel<Row> {
  return new Rel(node);
}

// ---------------------------------------------------------------------------------------------------------------
// Compiling: names to positions.

/** What compiling needs of the catalog: a table's columns by name. */
export interface Resolver {
  table(name: string): TableSpec<any> | undefined;
  /** A smaltts view's relation: inlined where it is read (plans have no view reference: see docs/DESIGN.md, E3). */
  view?(name: string): RelNode | undefined;
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

function compile(n: RelNode, cat: Resolver, params: string[]): { plan: P.PlanOp; fields: Field[] } {
  switch (n.r) {
    case 'scan': {
      const t = cat.table(n.table);
      if (!t) {
        const view = cat.view?.(n.table);
        if (view) return compile(view, cat, params);
        throw new Error(`no table or smaltts view named ${n.table}`);
      }
      return { plan: P.scan(t.name, t.columns.map((_, i) => i)), fields: t.columns.map((c) => ({ name: c.name, type: planTypeOf(c.type), collation: c.collation ?? 'binary' })) };
    }
    case 'values': {
      const types = n.columns.map((c) => planTypeOf(c.type));
      return { plan: P.values(n.rows.map((row) => row.map((v) => P.lit(v))), types), fields: n.columns.map((c, i) => ({ name: c.name, type: types[i]!, collation: 'binary' })) };
    }
    case 'function': {
      const types = n.columns.map((c) => planTypeOf(c.type));
      const named = n.named ? Object.fromEntries(Object.entries(n.named).map(([k, v]) => [k, P.lit(v)])) : undefined;
      return { plan: { op: 'source', kind: 'function', name: n.name, args: n.args.map((v) => P.lit(v)), ...(named ? { named } : {}), types }, fields: n.columns.map((c, i) => ({ name: c.name, type: types[i]!, collation: 'binary' })) };
    }
    case 'filter': {
      const input = compile(n.input, cat, params);
      return { plan: P.filter(input.plan, expr(n.pred, [input.fields], params).e), fields: input.fields };
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
        const c = expr(node, [input.fields], params);
        fields.push({ name, type: c.type, collation: c.collation });
        exprs.push(c.e);
      }
      return { plan: P.project(input.plan, exprs), fields };
    }
    case 'join': {
      const left = compile(n.left, cat, params);
      const right = compile(n.right, cat, params);
      const rightFields = right.fields.map((f) => ({ ...f, name: (n.prefix ?? '') + f.name }));
      const on = n.on ? expr(n.on, [left.fields, rightFields], params).e : undefined;
      if (n.kind === 'semi' || n.kind === 'anti') return { plan: P.join(n.kind, left.plan, right.plan, on), fields: left.fields };
      const names = new Set(left.fields.map((f) => f.name.toLowerCase()));
      const clash = rightFields.find((f) => names.has(f.name.toLowerCase()));
      if (clash) throw new Error(`join: both sides have a column named ${clash.name}; give the right side a prefix`);
      return { plan: P.join(n.kind, left.plan, right.plan, on), fields: [...left.fields, ...rightFields] };
    }
    case 'aggregate': {
      const input = compile(n.input, cat, params);
      const keys = n.keys.map(([name, node]) => ({ name, ...expr(node, [input.fields], params) }));
      const aggs = n.aggs.map(([name, node]) => {
        if (node.k !== 'agg') throw new Error(`aggregate: ${name} is not an aggregate`);
        const args = node.args.map((a) => expr(a, [input.fields], params));
        const type = AGGS[node.fn](args.map((a) => a.type)) as P.PlanType;
        const fn = node.fn === 'countDistinct' ? 'count' : node.fn;
        return { name, type, call: P.agg(fn, args.map((a) => a.e), type, { star: node.fn === 'count' && args.length === 0, distinct: node.fn === 'countDistinct' || !!node.distinct }) };
      });
      return {
        plan: P.aggregate(input.plan, keys.map((k) => k.e), aggs.map((a) => a.call), { collations: keys.map((k) => k.collation) }),
        fields: [...keys.map((k) => ({ name: k.name, type: k.type, collation: k.collation })), ...aggs.map((a) => ({ name: a.name, type: a.type, collation: 'binary' as Collation }))],
      };
    }
    case 'sort': {
      const input = compile(n.input, cat, params);
      const keys = n.keys.map((k) => {
        const c = expr(k.expr, [input.fields], params);
        return k.desc ? P.desc(c.e, { collation: c.collation }) : P.asc(c.e, { collation: c.collation });
      });
      return { plan: P.sort(input.plan, keys), fields: input.fields };
    }
    case 'limit': {
      const input = compile(n.input, cat, params);
      return { plan: P.limit(input.plan, n.count, n.offset), fields: input.fields };
    }
    case 'distinct': {
      const input = compile(n.input, cat, params);
      return { plan: P.distinct(input.plan, input.fields.length, input.fields.map((f) => f.collation)), fields: input.fields };
    }
    case 'union': {
      const a = compile(n.inputs[0], cat, params);
      const b = compile(n.inputs[1], cat, params);
      const names = (fs: Field[]) => fs.map((f) => f.name.toLowerCase()).join(',');
      if (names(a.fields) !== names(b.fields)) throw new Error(`union: the inputs have different columns (${names(a.fields)} / ${names(b.fields)})`);
      return { plan: P.setop(n.all ? 'unionAll' : 'union', a.plan, b.plan, a.fields.length, a.fields.map((f) => f.collation)), fields: a.fields };
    }
  }
}

/** Compile an expression whose column names resolve against `scopes` (one per input of the owning operation). */
export function expr(n: ExprNode, scopes: readonly (readonly Field[])[], params: string[]): { e: P.PlanExpr; type: P.PlanType; collation: Collation } {
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
      const e = P.lit(n.value);
      return { e, type: (e as { type: P.PlanType }).type, collation: 'binary' };
    }
    case 'param': {
      let i = params.indexOf(n.name);
      if (i < 0) i = params.push(n.name) - 1;
      return { e: P.param(i, n.type), type: n.type, collation: 'binary' };
    }
    case 'agg':
      throw new Error('an aggregate is only allowed in aggregate()');
    case 'op': {
      const args = n.args.map((a) => expr(a, scopes, params));
      const es = args.map((a) => a.e);
      const textArg = args.find((a) => a.collation !== 'binary');
      const collation: Collation = n.collation ?? textArg?.collation ?? 'binary';
      switch (n.op) {
        case 'and':
          return { e: P.and(...es), type: 'int', collation: 'binary' };
        case 'or':
          return { e: P.or(...es), type: 'int', collation: 'binary' };
        case 'not':
          return { e: P.not(es[0]!), type: 'int', collation: 'binary' };
        case 'isNull':
          return { e: P.isNull(es[0]!), type: 'int', collation: 'binary' };
        case 'isNotNull':
          return { e: P.isNotNull(es[0]!), type: 'int', collation: 'binary' };
        case 'div': {
          const left = P.cast('sql.cast_real', es[0]!, 'real');
          return { e: P.call('sql.div', [left, es[1]!], 'real'), type: 'real', collation: 'binary' };
        }
      }
      const def = OPS[n.op];
      const type = def.type(args.map((a) => a.type)) as P.PlanType;
      const compares = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'like'].includes(n.op);
      return { e: P.call(def.fn, es, type, compares ? collation : undefined), type, collation: type === 'text' ? collation : 'binary' };
    }
  }
}
