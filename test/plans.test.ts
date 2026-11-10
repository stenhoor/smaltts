/**
 * Milestone 5: each plan operation through smaltts and through the raw plan API. Each case compiles a relation,
 * checks that its plan is the one the raw builders give (with smaltts's `origin` fields removed: no extra nodes), and
 * runs both, expecting the same rows.
 */
import { beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import * as P from 'smaltdb/plan';
import { type Rel, agg, attach, fn, fromColumns, int, list, param, real, scan, table, text, values } from '../src/index.js';
import type { SmaltDb } from '../src/index.js';

const t = table('t', { id: int().primaryKey(), g: text(), x: int(), y: real() });
const u = table('u', { id: int().primaryKey(), tid: int(), w: text() });
const l = table('l', { id: int().primaryKey(), tags: list(text()) });

let engine: Database;
let db: SmaltDb;

beforeAll(async () => {
  engine = Database.openMemory();
  db = attach(engine);
  await db.migrate({ tables: [t, u, l] });
  await db.load(t, [
    { id: 1, g: 'a', x: 10, y: 1.5 },
    { id: 2, g: 'a', x: 20, y: null },
    { id: 3, g: 'b', x: 30, y: 2.5 },
    { id: 4, g: 'b', x: null, y: 3.5 },
    { id: 5, g: 'c', x: 50, y: 4.5 },
  ]);
  await db.load(u, [
    { id: 1, tid: 1, w: 'p' },
    { id: 2, tid: 1, w: 'q' },
    { id: 3, tid: 3, w: 'r' },
    { id: 4, tid: 9, w: 's' },
  ]);
  await db.load(l, [
    { id: 1, tags: ['a', 'b'] },
    { id: 2, tags: [] },
    { id: 3, tags: null },
  ]);
});

/** A plan without smaltts's `origin` fields. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'origin').map(([k, x]) => [k, strip(x)]));
  return v;
}

/** Compile and run `rel`, check its plan is `raw` and that both give the same rows; returns smaltts's rows. */
async function same(rel: Rel<any>, raw: P.PlanOp, params: Record<string, unknown> = {}, rawParams: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  const c = await db.compile(rel);
  expect(strip(c.plan)).toEqual(raw);
  const mine = await db.rows(rel, params as never);
  const theirs = (await engine.queryPlanAsync({ kind: 'query', plan: raw }, rawParams as never)) as { rows: unknown[][] };
  expect(mine.map((r) => c.fields.map((f) => r[f.name]))).toEqual(theirs.rows);
  return mine;
}

// The tables' columns, as the raw builders reference them.
const T = { id: P.col(0, 0, 'int'), g: P.col(0, 1, 'text'), x: P.col(0, 2, 'int'), y: P.col(0, 3, 'real') };
const tScan = P.scan('t', [0, 1, 2, 3]);
const uScan = P.scan('u', [0, 1, 2]);
const eq = (a: P.PlanExpr, b: P.PlanExpr) => P.call('cmp_eq', [a, b], 'bool', 'binary');

group('joins', () => {
  const on = eq(T.id, P.col(1, 1, 'int'));

  test('rightJoin keeps the right rows without a match; this side is NULL', async () => {
    const rows = await same(
      scan(t).rightJoin(scan(u), (a, b) => a.id.eq(b.u_tid), { prefix: 'u_' }),
      P.join('right', tScan, uScan, on),
    );
    expect(rows.find((r) => r.u_w === 's')).toMatchObject({ id: null, u_tid: 9 });
  });

  test('fullJoin keeps the rows of either side without a match', async () => {
    const rows = await same(scan(t).fullJoin(scan(u), (a, b) => a.id.eq(b.u_tid), { prefix: 'u_' }), P.join('full', tScan, uScan, on));
    expect(rows).toHaveLength(3 + 3 + 1); // three matches, t's 2, 4, 5 alone, u's 4 alone
  });

  test('crossJoin gives every pair', async () => {
    const rows = await same(scan(t).crossJoin(scan(u), { prefix: 'u_' }), P.join('cross', tScan, uScan));
    expect(rows).toHaveLength(20);
  });

  test('ordered keeps the left order and each left row its matches in the right order', async () => {
    await same(scan(t).join(scan(u), (a, b) => a.id.eq(b.u_tid), { prefix: 'u_', ordered: true }), P.join('inner', tScan, uScan, on, { ordered: true }));
  });

  test('asofJoin takes the nearest right key at or below the left key, within the tolerance', async () => {
    const rows = await same(
      scan(t).pick('id', 'x').asofJoin(scan(u).pick('tid', 'w'), (a, b) => [a.id, b.tid], { tolerance: 1 }),
      P.asofJoin(P.project(tScan, [T.id, T.x]), P.project(uScan, [P.col(0, 1, 'int'), P.col(0, 2, 'text')]), P.col(0, 0, 'int'), P.col(1, 0, 'int'), { direction: 'backward', tolerance: P.lit(1) }),
    );
    // id 2 takes tid 1 (distance 1; of the two rows with key 1, the first); id 5 finds nothing within 1 of it.
    expect(rows.map((r) => [r.id, r.w])).toEqual([[1, 'p'], [2, 'p'], [3, 'r'], [4, 'r'], [5, null]]);
  });
});

group('aggregate, distinct, limit', () => {
  test('aggregate with ordered gives the groups in the order of their first row', async () => {
    const rel = scan(t).sort('-id').aggregate((r) => ({ g: r.g }), (r) => ({ n: agg.count() }), { ordered: true });
    const raw = P.aggregate(P.sort(tScan, [P.desc(T.id)]), [T.g], [P.agg('count', [], 'int', { star: true })], { collations: ['binary'], ordered: 'first' });
    expect((await same(rel, raw)).map((r) => r.g)).toEqual(['c', 'b', 'a']);
  });

  test('distinct on a column keeps the last row of each set', async () => {
    const rows = await same(scan(t).distinct({ on: ['g'], keep: 'last' }), P.distinct(tScan, 4, ['binary', 'binary', 'binary', 'binary'], { on: [1], keep: 'last' }));
    expect(rows.map((r) => r.id)).toEqual([2, 4, 5]);
  });

  test('distinct with ordered keeps the order of first occurrence', async () => {
    const rel = scan(t).sort('-id').pick('g').distinct({ ordered: true });
    const raw = P.distinct(P.project(P.sort(tScan, [P.desc(T.id)]), [T.g]), 1, ['binary'], { ordered: 'first' });
    expect((await same(rel, raw)).map((r) => r.g)).toEqual(['c', 'b', 'a']);
  });

  test('limit fromEnd gives the last rows, in order', async () => {
    const rows = await same(scan(t).limit(2, 1, { fromEnd: true }), P.limit(tScan, 2, 1, { fromEnd: true }));
    expect(rows.map((r) => r.id)).toEqual([3, 4]);
  });

  test('limit takes a parameter', async () => {
    const rows = await same(scan(t).limit(param.int('n')), P.limit(tScan, P.param(0, 'int')), { n: 2 }, [2]);
    expect(rows).toHaveLength(2);
  });
});

group('set operations', () => {
  const a = () => scan(t).filter((r) => r.id.lte(3)).pick('g');
  const b = () => scan(t).filter((r) => r.id.gte(3)).pick('g');
  const rawA = P.project(P.filter(tScan, P.call('cmp_le', [T.id, P.lit(3)], 'bool', 'binary')), [T.g]);
  const rawB = P.project(P.filter(tScan, P.call('cmp_ge', [T.id, P.lit(3)], 'bool', 'binary')), [T.g]);

  test('intersect', async () => {
    expect((await same(a().intersect(b()), P.setop('intersect', rawA, rawB, 1))).map((r) => r.g)).toEqual(['b']);
  });

  test('except', async () => {
    expect((await same(a().except(b()), P.setop('except', rawA, rawB, 1))).map((r) => r.g)).toEqual(['a']);
  });

  test('inputs with different columns are refused, naming the call', async () => {
    await expect(db.compile(scan(t).pick('g').except(scan(t).pick('id') as never))).rejects.toThrow(/^except: the inputs have different columns/);
  });
});

group('sample, explode, pivot, unpivot', () => {
  test('sample draws the same rows for the same seed', async () => {
    const rows = await same(scan(t).sample({ count: 3 }, { seed: 7 }), P.sample(tScan, { count: 3 }, { seed: 7 }));
    expect(rows).toHaveLength(3);
    await same(scan(t).sample({ fraction: 0.5 }, { replace: true, seed: 1 }), P.sample(tScan, { fraction: 0.5 }, { replace: true, seed: 1 }));
  });

  test('explode gives one row per element, typed by the element', async () => {
    const lScan = P.scan('l', [0, 1]);
    const rows = await same(scan(l).explode('tags', { position: 'pos' }), P.explode(lScan, 1, 'list<text>', { position: true }));
    expect(rows).toEqual([
      { id: 1, tags: 'a', pos: 0 },
      { id: 1, tags: 'b', pos: 1 },
      { id: 3, tags: null, pos: 0 },
    ]);
    const c = await db.compile(scan(l).explode('tags'));
    expect(c.fields.map((f) => f.type)).toEqual(['int', 'text']);
    await same(scan(l).explode('tags', { emptyAsNull: true, keepNulls: false }), P.explode(lScan, 1, 'list<text>', { emptyAsNull: true, keepNulls: false }));
  });

  test('explode refuses a column that is not a list', async () => {
    await expect(db.compile(scan(t).explode('g'))).rejects.toThrow(/^explode: g is text, not a list/);
  });

  test('pivot: one row per key, a column per value', async () => {
    const rel = scan(t).pivot({ keys: (r) => ({ g: r.g }), on: (r) => r.g, values: ['a', 'b'], aggs: (r) => ({ total: agg.sum(r.x) }) });
    const raw = P.pivot(tScan, [T.g], T.g, ['a', 'b'], [P.agg('sum', [T.x], 'int')], { collations: ['binary'], collation: 'binary' });
    const rows = await same(rel, raw);
    expect(rows.find((r) => r.g === 'a')).toEqual({ g: 'a', a: 30, b: null });
  });

  test('pivot with two aggregates names columns value_agg', async () => {
    const c = await db.compile(scan(t).pivot({ keys: () => ({}), on: (r) => r.g, values: ['a'], aggs: (r) => ({ n: agg.count(), s: agg.sum(r.x) }) }));
    expect(c.fields.map((f) => f.name)).toEqual(['a_n', 'a_s']);
  });

  test('unpivot: each column a row, with its name and value; the other columns kept', async () => {
    const rel = scan(t).pick('id', 'x', 'y').unpivot(['x', 'y']);
    const raw = P.unpivot(P.project(tScan, [T.id, T.x, T.y]), [0], [1, 2], ['x', 'y'], 'any');
    const rows = await same(rel, raw);
    expect(rows.slice(0, 2)).toEqual([{ id: 1, name: 'x', value: 10 }, { id: 1, name: 'y', value: 1.5 }]);
    const typed = await db.compile(scan(t).unpivot(['id', 'x'], { keep: ['g'], name: 'col', value: 'v' }));
    expect(typed.fields.map((f) => `${f.name} ${f.type}`)).toEqual(['g text', 'col text', 'v int']);
  });
});

group('sources', () => {
  test('fromColumns: typed arrays and arrays of values', async () => {
    const rel = fromColumns<{ n: number; s: string }>([{ name: 'n', type: 'INTEGER' }, { name: 's', type: 'TEXT' }], [new Int32Array([1, 2]), ['x', 'y']]);
    const raw = P.fromColumns([new Int32Array([1, 2]), ['x', 'y']], ['int', 'text']);
    expect(await same(rel, raw)).toEqual([{ n: 1, s: 'x' }, { n: 2, s: 'y' }]);
  });

  test('values are unchanged', async () => {
    const rel = values<{ n: number }>([{ name: 'n', type: 'INTEGER' }], [{ n: 1 }]).extend((r) => ({ m: fn.add(r.n, 1) }));
    expect(await db.rows(rel)).toEqual([{ n: 1, m: 2 }]);
  });
});
