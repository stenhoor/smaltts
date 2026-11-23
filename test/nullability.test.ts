/**
 * The owner's decisions on smaltts#29 (2026-11-23), held at compile time: `npm run typecheck` fails if a type here
 * changes. For `fn.*`, nullability follows the arguments (an operation's result is non-null when all its arguments are),
 * except `div_trunc` and `mod_trunc`. The comparison methods keep a nullable result for now, so smaltty's checker keeps
 * checking their arguments, until it checks overloads. Arguments typed as numbers take a `bigint`. Aggregates,
 * `agg.count()` included, stay nullable.
 */
import { expect, test } from 'vitest';
import { type Expr, agg, col, fn } from '../src/index.js';

type Equal<X, Y> = (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false;
const is = <T extends true>(): T | undefined => undefined;

const n = col<number>('n');
const maybe = col<number | null>('maybe');
const s = col<string>('s');

test('an operation is non-null when all its arguments are', () => {
  is<Equal<ReturnType<typeof addNonNull>, Expr<number>>>();
  is<Equal<ReturnType<typeof addNullable>, Expr<number | null>>>();
  is<Equal<ReturnType<typeof concat>, Expr<string>>>();
  is<Equal<ReturnType<typeof cast>, Expr<number>>>();
  is<Equal<ReturnType<typeof notTrue>, Expr<boolean>>>();
  expect(addNonNull().node).toEqual({ k: 'fn', name: 'add', args: [{ k: 'col', name: 'n' }, { k: 'lit', value: 1 }] });
});

test('division stays nullable: the engine gives NULL on division by zero', () => {
  is<Equal<ReturnType<typeof divide>, Expr<number | null>>>();
  is<Equal<ReturnType<typeof remainder>, Expr<number | null>>>();
});

test('fn.cmp_* follows the rule; the comparison methods stay nullable for now', () => {
  is<Equal<ReturnType<typeof cmpLt>, Expr<boolean>>>();
  is<Equal<ReturnType<typeof cmpLtNullable>, Expr<boolean | null>>>();
  is<Equal<ReturnType<typeof inListFn>, Expr<boolean>>>();
  is<Equal<ReturnType<typeof likeFn>, Expr<boolean>>>();
  is<Equal<ReturnType<typeof methodLt>, Expr<boolean | null>>>();
  is<Equal<ReturnType<typeof inList>, Expr<boolean | null>>>();
  is<Equal<ReturnType<typeof liked>, Expr<boolean | null>>>();
});

test('arguments typed as numbers take a bigint', () => {
  is<Equal<ReturnType<typeof addBig>, Expr<number>>>();
  expect(addBig().node).toEqual({ k: 'fn', name: 'add', args: [{ k: 'col', name: 'n' }, { k: 'lit', value: 9223372036854775807n }] });
  expect(n.eq(1n).node).toEqual({ k: 'fn', name: 'cmp_eq', args: [{ k: 'col', name: 'n' }, { k: 'lit', value: 1n }] });
});

test('aggregates stay nullable, counts too', () => {
  is<Equal<ReturnType<typeof count>, Expr<number | null>>>();
  is<Equal<ReturnType<typeof sum>, Expr<number | null>>>();
});

function addNonNull() { return fn.add(n, 1); }
function addNullable() { return fn.add(maybe, 1); }
function addBig() { return fn.add(n, 9223372036854775807n); }
function concat() { return fn.text_concat(s, 1); }
function cast() { return fn.cast_integer(s); }
function notTrue() { return fn.truth_not(true); }
function divide() { return fn.div_trunc(n, 2); }
function remainder() { return fn.mod_trunc(n, 2); }
function cmpLt() { return fn.cmp_lt(n, 5); }
function methodLt() { return n.lt(5); }
function cmpLtNullable() { return fn.cmp_lt(maybe, 5); }
function inListFn() { return fn.in_list(n, 1, 2); }
function inList() { return n.in([1, 2]); }
function likeFn() { return fn.like(s, 'a%'); }
function liked() { return s.like('a%'); }
function count() { return agg.count(); }
function sum() { return agg.sum(n); }
