/** Milestone 3: every spec field's change gives the expected step and class; conversions are exact where lossless. */
import { describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { type ColumnBuilder, type TableSpec, attach, blob, bool, date, datetime, duration, fn, int, numeric, real, scan, table, text, time } from '../src/index.js';

const parent = table('parent', { id: int().primaryKey() });
const base = (extra: Record<string, ColumnBuilder<any, boolean, boolean>> = {}, options: Parameters<typeof table>[2] = {}) =>
  table('t', { id: int().primaryKey(), a: int(), b: text().notNull(), ...extra }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }], ...options });

async function steps(from: TableSpec<any>, to: TableSpec<any>, rows: Record<string, unknown>[] = [{ a: 1, b: 'x' }]) {
  const db = attach(Database.openMemory());
  await db.migrate({ tables: [parent, from] });
  await db.load(parent, [{ id: 1 }]);
  if (rows.length) await db.load(from, rows);
  const changes = await db.diff({ tables: [parent, to] });
  return { db, changes, classes: changes.steps.map((s) => `${s.action} ${s.impact} ${s.dataLoss}`) };
}

group('every spec field', () => {
  const cases: [string, TableSpec<any>, string[]][] = [
    ['add a nullable column', base({ c: real() }), ['addColumn instant none']],
    ['add a NOT NULL column with a default', base({ c: int().notNull().default(0) }), ['addColumn instant none']],
    ['add a NOT NULL column without a default', base({ c: int().notNull() }), ['rebuildTable rewrite possible']],
    ['drop a column', table('t', { id: int().primaryKey(), a: int() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['dropColumn rewrite certain']],
    ['rename a column', table('t', { id: int().primaryKey(), a: int(), bee: text().notNull().renamedFrom('b') }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['renameColumn metadata none']],
    ['rename a primary key column', table('t', { key: int().primaryKey().renamedFrom('id'), a: int(), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['renameColumn metadata none']],
    ['rename the table', table('t2', { id: int().primaryKey(), a: int(), b: text().notNull() }, { renamedFrom: 't', indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['renameTable metadata none']],
    ['a lossless type change', table('t', { id: int().primaryKey(), a: numeric(), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['a lossy type change', table('t', { id: int().primaryKey(), a: real(), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite possible']],
    ['nullable to NOT NULL', table('t', { id: int().primaryKey(), a: int().notNull(), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite possible']],
    ['NOT NULL to nullable', table('t', { id: int().primaryKey(), a: int(), b: text() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['a collation', table('t', { id: int().primaryKey(), a: int(), b: text().notNull().collate('nocase') }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['a default', table('t', { id: int().primaryKey(), a: int().default(3), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['a computed default', table('t', { id: int().primaryKey(), a: int().defaultExpr(fn.abs(-1)), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['the primary key', table('t', { id: int(), a: int(), b: text().notNull() }, { primaryKey: ['b'], indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['a unique key', base({}, { unique: [['b']] }), ['rebuildTable rewrite none']],
    ['a CHECK', base({}, { checks: (r) => [r.a.gte(0)] }), ['rebuildTable rewrite none']],
    ['a foreign key', table('t', { id: int().primaryKey(), a: int().references(parent), b: text().notNull() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['the column order', table('t', { id: int().primaryKey(), b: text().notNull(), a: int() }, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }] }), ['rebuildTable rewrite none']],
    ['storage', table('t', { id: int().primaryKey(), a: int(), b: text().notNull() }, { storage: 'columnar' }), ['rebuildTable rewrite none']],
    ['add an index', base({}, { indexes: [{ name: 't_a', columns: [{ column: 'a' }] }, { name: 't_b', columns: [{ column: 'b' }] }] }), ['createIndex build none']],
    ['drop an index', table('t', { id: int().primaryKey(), a: int(), b: text().notNull() }), ['dropIndex metadata none']],
    ['change an index', base({}, { indexes: [{ name: 't_a', columns: [{ column: 'a', desc: true }] }] }), ['dropIndex metadata none', 'createIndex build none']],
  ];
  for (const [name, to, expected] of cases) {
    test(`${name}: ${expected.join(', ')}; applied, the database matches`, async () => {
      const { db, changes, classes } = await steps(base(), to);
      expect(classes).toEqual(expected);
      await db.apply(changes, { allowDataLoss: 'certain' }).catch((e: Error) => {
        // Adding a NOT NULL column with no default to a table with rows fails, and changes nothing.
        if (name !== 'add a NOT NULL column without a default') throw e;
      });
      if (name !== 'add a NOT NULL column without a default') expect((await db.diff({ tables: [parent, to] })).steps).toEqual([]);
    });
  }
});

group('the conversion table, on real values', () => {
  const cases: [string, ColumnBuilder<any, boolean, boolean>, unknown, ColumnBuilder<any, boolean, boolean>, unknown][] = [
    ['INTEGER to NUMERIC', int(), 7, numeric(), 7],
    ['INTEGER to TEXT', int(), 9007199254740993n, text(), '9007199254740993'],
    ['REAL to TEXT', real(), 1.5, text(), '1.5'],
    ['BOOLEAN to INTEGER', bool(), true, int(), 1],
    ['BOOLEAN to TEXT', bool(), false, text(), '0'],
    ['DATE to DATETIME', date(), new Date('2026-11-10T00:00:00Z'), datetime(), '2026-11-10 00:00:00'],
    ['DATE to TEXT', date(), new Date('2026-11-10T00:00:00Z'), text(), '2026-11-10'],
    ['DATETIME to TEXT', datetime(), new Date('2026-11-10T12:30:00.250Z'), text(), '2026-11-10 12:30:00.250'],
    ['TIME to TEXT', time(), '12:30:00', text(), '12:30:00'],
    ['TEXT to BLOB', text(), 'ab', blob(), new Uint8Array([97, 98])],
  ];
  for (const [name, from, value, to, expected] of cases) {
    test(`${name} is lossless and exact`, async () => {
      const db = attach(Database.openMemory());
      const t0 = table('c', { id: int().primaryKey(), v: from });
      const t1 = table('c', { id: int().primaryKey(), v: to });
      await db.migrate({ tables: [t0] });
      await db.load(t0, [{ v: value }]);
      const changes = await db.diff({ tables: [t1] });
      expect(changes.steps.map((s) => s.dataLoss)).toEqual(['none']);
      await db.apply(changes);
      expect((await db.rows(scan(t1).pick('v'), {}, { temporal: 'text' }))[0]!.v).toEqual(expected);
    });
  }

  test('a duration converts to its text', async () => {
    const db = attach(Database.openMemory());
    await db.migrate({ tables: [table('c', { id: int().primaryKey(), v: duration() })] });
    await db.load('c', [{ v: 5_400_000_000 as never }]);
    await db.migrate({ tables: [table('c', { id: int().primaryKey(), v: text() })] });
    expect(await db.rows(scan('c').pick('v'))).toEqual([{ v: 'PT1H30M' }]);
  });

  test('a pair with no conversion is an error, and apply refuses it', async () => {
    const db = attach(Database.openMemory());
    await db.migrate({ tables: [table('c', { id: int().primaryKey(), v: date() })] });
    const changes = await db.diff({ tables: [table('c', { id: int().primaryKey(), v: duration() })] });
    expect(changes.diagnostics).toEqual([{ level: 'error', object: 'c.v', message: expect.stringContaining('no conversion from DATE to DURATION') }]);
    await expect(db.apply(changes, { allowDataLoss: 'certain' })).rejects.toThrow(/has errors/);
  });
});

test('columnar tables round-trip too', async () => {
  const db = attach(Database.openMemory());
  const facts = table('facts', { id: int().primaryKey(), region: text().notNull(), amount: real() }, { storage: 'columnar' });
  await db.migrate({ tables: [facts] });
  await db.load(facts, [{ region: 'north', amount: 1.5 }]);
  expect((await db.diff({ tables: [facts] })).steps).toEqual([]);
  expect(await db.rows(scan(facts).pick('region', 'amount'))).toEqual([{ region: 'north', amount: 1.5 }]);
  // A swap load and a rebuild work on columnar tables, though the engine cannot rename them (finding F4).
  await db.load(facts, [{ region: 'south', amount: 2 }], { mode: 'swap' });
  expect(await db.rows(scan(facts).pick('region'))).toEqual([{ region: 'south' }]);
  const wider = table('facts', { id: int().primaryKey(), region: text().notNull(), amount: text() }, { storage: 'columnar' });
  await db.migrate({ tables: [wider] });
  expect(await db.rows(scan(wider).pick('amount'))).toEqual([{ amount: '2.0' }]);
  expect((await db.diff({ tables: [wider] })).steps).toEqual([]);
});
