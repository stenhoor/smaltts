/**
 * The table of signatures: TypeScript types for the engine's own operations (`OPERATIONS` in functions.ts), by their
 * engine names. `fn.<name>` takes its type from here; a function this table doesn't name is typed loosely (any
 * arguments, the engine's result type), so a new engine function is usable before smaltts types it. Types only: the
 * engine decides what each call means, and compiling checks the argument count against the catalog (`ARITY`).
 *
 * The TypeScript types are smaltts's reading of the engine's types (`TsOf` in expr.ts): numbers for `int`, `real` and
 * `num`, `Date` for `date` and `datetime`, text for `time` and `duration`, booleans for `bool`.
 */
import type { Arg, Expr, Truth } from './expr.js';
import type { OperationName } from './functions.js';

type Num = number | null;
type Text = string | null;
type Time = Date | null;
/** A `duration`, as smaltts reads one (text). */
type Duration = string | null;

type Binary<T, R> = (a: Arg<T>, b: Arg<T>) => Expr<R>;
type Compare = <T>(a: Arg<T>, b: Arg<T | null>) => Expr<boolean | null>;
type Convert<R> = (value: Arg<unknown>) => Expr<R | null>;
type Pattern = (value: Arg<Text>, pattern: Arg<Text>, escape?: Arg<string>) => Expr<boolean | null>;

export interface Signatures {
  /** Numbers, or a time plus a duration (datetime + duration is a datetime). */
  add: { (a: Arg<Num>, b: Arg<Num>): Expr<Num>; (a: Arg<Time>, b: Arg<Duration>): Expr<Time> };
  add_checked: Binary<Num, Num>;
  affinity_numeric: (value: Arg<unknown>) => Expr<unknown>;
  affinity_text: (value: Arg<unknown>) => Expr<unknown>;
  bit_and: Binary<Num, Num>;
  bit_not: (a: Arg<Num>) => Expr<Num>;
  bit_or: Binary<Num, Num>;
  cast_blob: Convert<Uint8Array>;
  cast_integer: Convert<number>;
  cast_integer_strict: Convert<number>;
  cast_numeric: Convert<number>;
  cast_real: Convert<number>;
  cast_real_strict: Convert<number>;
  cast_text: Convert<string>;
  cmp_eq: Compare;
  cmp_ge: Compare;
  cmp_gt: Compare;
  /** Equal, where NULL equals NULL: never NULL. */
  cmp_is: <T>(a: Arg<T>, b: Arg<T | null>) => Expr<boolean>;
  cmp_is_not: <T>(a: Arg<T>, b: Arg<T | null>) => Expr<boolean>;
  cmp_le: Compare;
  cmp_lt: Compare;
  cmp_ne: Compare;
  div_trunc: Binary<Num, Num>;
  glob: Pattern;
  in_list: <T>(value: Arg<T>, ...values: Arg<T>[]) => Expr<boolean | null>;
  like: Pattern;
  mod_trunc: Binary<Num, Num>;
  mul: Binary<Num, Num>;
  mul_checked: Binary<Num, Num>;
  /** A number, or a duration. */
  neg: { (a: Arg<Num>): Expr<Num>; (a: Arg<Duration>): Expr<Duration> };
  shift_left: Binary<Num, Num>;
  shift_right: Binary<Num, Num>;
  /** Numbers; two times give a duration; a time minus a duration is a time. */
  sub: { (a: Arg<Num>, b: Arg<Num>): Expr<Num>; (a: Arg<Time>, b: Arg<Time>): Expr<Duration>; (a: Arg<Time>, b: Arg<Duration>): Expr<Time> };
  sub_checked: Binary<Num, Num>;
  text_concat: (a: Arg<Text | number>, b: Arg<Text | number>) => Expr<Text>;
  truth_not: (a: Arg<Truth>) => Expr<boolean | null>;
}

/** The operations the table names, at run time: test/functions.test.ts checks it names every operation and no other. */
export const SIGNED: { readonly [K in keyof Signatures]: true } & { readonly [K in Exclude<OperationName, keyof Signatures>]: never } = {
  add: true,
  add_checked: true,
  affinity_numeric: true,
  affinity_text: true,
  bit_and: true,
  bit_not: true,
  bit_or: true,
  cast_blob: true,
  cast_integer: true,
  cast_integer_strict: true,
  cast_numeric: true,
  cast_real: true,
  cast_real_strict: true,
  cast_text: true,
  cmp_eq: true,
  cmp_ge: true,
  cmp_gt: true,
  cmp_is: true,
  cmp_is_not: true,
  cmp_le: true,
  cmp_lt: true,
  cmp_ne: true,
  div_trunc: true,
  glob: true,
  in_list: true,
  like: true,
  mod_trunc: true,
  mul: true,
  mul_checked: true,
  neg: true,
  shift_left: true,
  shift_right: true,
  sub: true,
  sub_checked: true,
  text_concat: true,
  truth_not: true,
};
