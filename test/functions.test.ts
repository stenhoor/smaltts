/** The generated function table (src/functions.ts) is the engine's: names, kinds and result types. */
import { Database } from 'smaltdb/engine';
import { expect, test } from 'vitest';
import { AGGREGATE, ARITY, OPERATIONS, SCALAR } from '../src/functions.js';
import { SIGNED } from '../src/signatures.js';

test('fn and agg list exactly the engine catalog functions', () => {
  const fns = Database.openMemory().catalog.functions();
  const scalar = Object.fromEntries(fns.filter((f) => f.kind === 'scalar').map((f) => [f.name, f.result]));
  const aggregate = Object.fromEntries(fns.filter((f) => f.kind !== 'scalar').map((f) => [f.name, { kind: f.kind, result: f.result }]));
  // A difference means the engine changed: regenerate src/functions.ts from db.catalog.functions().
  expect({ ...SCALAR }).toEqual(scalar);
  expect(JSON.parse(JSON.stringify(AGGREGATE))).toEqual(aggregate);
});

test('the argument counts and the operations are the catalog\'s', () => {
  const fns = Database.openMemory().catalog.functions();
  expect(ARITY).toEqual(Object.fromEntries(fns.map((f) => [f.name, [f.minArgs, f.maxArgs]])));
  expect([...OPERATIONS].sort()).toEqual(fns.filter((f) => f.operation).map((f) => f.name).sort());
});

test('the table of signatures names every operation, and nothing else', () => {
  expect(Object.keys(SIGNED).sort()).toEqual([...OPERATIONS].sort());
});
