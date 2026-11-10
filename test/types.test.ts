/** Milestone 2: the engine's types in specs, values in and out, and inference (smaltdb ADRs 0018–0020). */
import { beforeAll, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { attach, bool, date, datetime, duration, inferTable, int, list, param, real, scan, struct, table, text, time } from '../src/index.js';
import { registerSmaltts } from '../src/language.js';

beforeAll(() => registerSmaltts());

const events = table('events', {
  id: int().primaryKey(),
  ok: bool().notNull(),
  day: date(),
  at: datetime(),
  clock: time(),
  took: duration(),
  tags: list(text()),
  point: struct({ x: real(), y: real() }),
  history: list(struct({ d: date(), ok: bool() })),
});

const at = new Date('2026-11-10T12:30:00.250Z');
const day = new Date('2026-11-10T00:00:00.000Z');

async function loaded() {
  const db = attach(Database.openMemory());
  await db.migrate({ tables: [events] });
  await db.load(events, [
    { ok: true, day, at, clock: '12:30:00', took: null, tags: ['a', 'b'], point: { x: 1.5, y: -2 }, history: [{ d: day, ok: false }] },
    { ok: false, day: null, at: null, clock: null, took: null, tags: [], point: null, history: null },
  ]);
  return db;
}

test('every type round-trips through a load and a read, as JavaScript values', async () => {
  const db = await loaded();
  const rows = await db.rows(scan(events).sort('id'));
  expect(rows[0]).toEqual({ id: 1, ok: true, day, at, clock: '12:30:00', took: null, tags: ['a', 'b'], point: { x: 1.5, y: -2 }, history: [{ d: '2026-11-10', ok: false }] });
  expect(rows[1]).toEqual({ id: 2, ok: false, day: null, at: null, clock: null, took: null, tags: [], point: null, history: null });
  const first: { ok: boolean; day: Date | null; tags: (string | null)[] | null; point: { x: number | null; y: number | null } | null } = rows[0]!;
  expect(first.day).toBeInstanceOf(Date);
});

test('dates and times read as the engine text with { temporal: "text" }', async () => {
  const db = await loaded();
  const [row] = await db.rows(scan(events).filter((e) => e.id.eq(1)).pick('day', 'at'), {}, { temporal: 'text' });
  const typed: { day: string | null; at: string | null } = row!;
  expect(typed).toEqual({ day: '2026-11-10', at: '2026-11-10 12:30:00.250' });
});

test('a Date compares with date and datetime columns by their own units', async () => {
  const db = await loaded();
  expect(await db.rows(scan(events).filter((e) => e.day.eq(day)).pick('id'))).toEqual([{ id: 1 }]);
  expect(await db.rows(scan(events).filter((e) => e.at.gt(new Date('2026-11-10T12:00:00Z'))).pick('id'))).toEqual([{ id: 1 }]);
  expect(await db.rows(scan(events).filter((e) => e.at.lt(param.datetime('t'))).pick('id'), { t: new Date('2026-11-11T00:00:00Z') })).toEqual([{ id: 1 }]);
});

test('the catalog reads every type back: diffing against the database finds nothing', async () => {
  const db = await loaded();
  expect((await db.diff({ tables: [events] })).steps).toEqual([]);
  const read = (await db.catalog({ fresh: true })).table('events')!;
  expect(read.columns.map((c) => [c.name, c.type, c.planType])).toEqual([
    ['id', 'INTEGER', undefined], ['ok', 'BOOLEAN', undefined], ['day', 'DATE', undefined], ['at', 'DATETIME', undefined],
    ['clock', 'TIME', undefined], ['took', 'DURATION', undefined], ['tags', 'LIST', 'list<text>'],
    ['point', 'STRUCT', 'struct<x real, y real>'], ['history', 'LIST', 'list<struct<d date, ok bool>>'],
  ]);
});

test('changing a list element type is a rebuild', async () => {
  const db = await loaded();
  const changed = table('events', { ...Object.fromEntries([]), id: int().primaryKey(), ok: bool().notNull(), day: date(), at: datetime(), clock: time(), took: duration(), tags: list(int()), point: struct({ x: real(), y: real() }), history: list(struct({ d: date(), ok: bool() })) });
  const steps = (await db.diff({ tables: [changed] })).steps;
  expect(steps.map((s) => [s.action, s.reason])).toEqual([['rebuildTable', 'tags: type list<text> → list<int>']]);
});

test('inferTable recognises booleans, Dates, lists and structs', () => {
  const spec = inferTable('t', [{ ok: true, at, tags: ['a'], point: { x: 1, y: 2.5 }, n: 1 }, { ok: null, at: null, tags: [], point: null, n: 2.5 }]);
  expect(spec.columns.map((c) => [c.name, c.type, c.planType])).toEqual([
    ['ok', 'BOOLEAN', undefined], ['at', 'DATETIME', undefined], ['tags', 'LIST', 'list<text>'], ['point', 'STRUCT', 'struct<x int, y real>'], ['n', 'REAL', undefined],
  ]);
});
