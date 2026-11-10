/**
 * Expressions: typed, by column name, and JSON-safe (`ExprNode`). Every expression is one of the engine's operations or
 * functions, by its engine name (`fn.div_float`, `agg.sum`); methods are short aliases only where an operation has one
 * meaning (`.eq` is `cmp_eq`, `.and` the logic node), as ADR 0023 decides. Relations (`rel.ts`), specs' CHECKs and
 * defaults (`spec.ts`) and DDL (`ddl.ts`) all build on them.
 */
import { AGGREGATE, type AggregateName, SCALAR, type ScalarName } from './functions.js';
import type { Collation, Value } from './spec.js';

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

// ---------------------------------------------------------------------------------------------------------------
// Typed expressions.

/** The TypeScript type of an engine plan type's values (`null` aside), as smaltts reads them (`date`, `datetime`: `Date`). */
export type TsOf<T extends string> = T extends 'int' | 'real' | 'num' ? number : T extends 'date' | 'datetime' ? Date : T extends 'text' | 'time' | 'duration' ? string : T extends 'bool' ? boolean : T extends 'blob' ? Uint8Array : Value | boolean;
export type Arg<T> = Expr<T> | T;
export type Truth = boolean | number | null;

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

export const toNode = (v: unknown): ExprNode =>
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


/** The columns of a row, as expressions. */
export type Cols<R> = { readonly [K in keyof R]: Expr<R[K]> };
