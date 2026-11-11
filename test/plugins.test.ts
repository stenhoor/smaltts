/**
 * Milestone 9: connections and external tables as specs, and plugins typed by descriptors (DESIGN.md section 14,
 * decision 14). Parquet is read through @smaltdb/parquet, with @smaltdb/external for file locations and connections:
 * both pinned for tests only (packed.json); smaltts's own code imports neither.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';
import parquet from '@smaltdb/parquet';
import { attach, connection, date, definePlugin, externalTable, int, methods, real, scan, table, text } from '../src/index.js';
import { registerSmaltts } from '../src/language.js';

beforeAll(() => registerSmaltts());

const PARQUET = readFileSync(new URL('./fixtures/types.parquet', import.meta.url));

async function fresh() {
  const raw = Database.openMemory({ plugins: [external, parquet] });
  await registerFile(raw as never, 'types.parquet', PARQUET);
  await registerFile(raw as never, 'copy.parquet', PARQUET);
  return { raw, db: attach(raw) };
}

const typesFile = externalTable('typed', { location: 'file:types.parquet' });
const target = table('numbers', { id: int().primaryKey(), i32: int(), s: text(), d: date(), f64: real() });

group('Parquet into a table, both declared as specs (the done-when)', () => {
  test('migrate creates the external table and the table; load copies the rows', async () => {
    const { db } = await fresh();
    const { changes } = await db.migrate({ tables: [target], externals: [typesFile] });
    expect(changes.steps.map((s) => `${s.action} ${s.object}`)).toEqual(['createExternalTable typed', 'createTable numbers']);
    const cat = await db.catalog({ fresh: true });
    expect(cat.externals.map((x) => [x.name, x.options])).toEqual([['typed', { location: 'file:types.parquet' }]]);
    expect(cat.externals[0]!.columns.map((c) => c.name).slice(0, 3)).toEqual(['i32', 'i64', 'u8']);
    await db.load(target, scan('typed').filter((r) => r.i32.isNotNull()).select((r) => ({ id: r.i32, i32: r.i32, s: r.s, d: r.d, f64: r.f64 })));
    expect(await db.rows(scan(target).sort('id'))).toEqual([
      { id: -2, i32: -2, s: null, d: null, f64: 2.5 },
      { id: 1, i32: 1, s: 'héllo', d: new Date('2024-02-29T00:00:00Z'), f64: 3.141592653589793 },
    ]);
    // Applied again, nothing changes.
    expect((await db.diff({ tables: [target], externals: [typesFile] })).steps).toEqual([]);
  });
});

group('connections and external tables in change sets', () => {
  const web = connection('web', { type: 'https', url: 'https://data.example.org/' });

  test('create, leave alone, make again when the options change, drop with prune', async () => {
    const { db } = await fresh();
    await db.migrate({ tables: [], connections: [web], externals: [typesFile] });
    expect((await db.diff({ tables: [], connections: [web], externals: [typesFile] })).steps).toEqual([]);
    // Left out of the desired schema: left alone, with a note; with prune, dropped.
    const left = await db.diff({ tables: [], connections: [], externals: [] });
    expect(left.steps).toEqual([]);
    expect(left.diagnostics.map((d) => `${d.level} ${d.object}`)).toEqual(['info web', 'info typed']);
    // Options that change make the object again.
    const moved = externalTable('typed', { location: 'file:copy.parquet' });
    const changes = await db.diff({ tables: [], externals: [moved] });
    expect(changes.steps.map((s) => `${s.action} ${s.object}: ${s.reason}`)).toEqual(['replaceExternalTable typed: its options change']);
    expect(changes.dataLoss).toBe('none');
    await db.apply(changes);
    expect((await db.catalog({ fresh: true })).externals[0]!.options).toEqual({ location: 'file:copy.parquet' });
    const pruned = await db.diff({ tables: [], connections: [], externals: [] }, { prune: true });
    expect(pruned.steps.map((s) => `${s.action} ${s.object}`)).toEqual(['dropExternalTable typed', 'dropConnection web']);
    await db.apply(pruned, { allowDataLoss: 'certain' });
    const cat = await db.catalog({ fresh: true });
    expect([cat.connections, cat.externals]).toEqual([[], []]);
  });

  test('a connection that changes is made again with the external tables that read through it', async () => {
    const { db } = await fresh();
    const viaWeb = externalTable('remote', { location: 'file:types.parquet', connection: web });
    await db.migrate({ tables: [], connections: [web], externals: [viaWeb] });
    expect((await db.catalog({ fresh: true })).externals[0]!.options).toEqual({ location: 'file:types.parquet', connection: 'web' });
    const moved = connection('web', { type: 'https', url: 'https://mirror.example.org/' });
    const changes = await db.diff({ tables: [], connections: [moved], externals: [viaWeb] });
    expect(changes.steps.map((s) => `${s.action} ${s.object}`)).toEqual(['replaceConnection web']);
    expect(changes.steps[0]!.statements.map((s) => (s as { op: { op: string } }).op.op)).toEqual(['drop', 'drop', 'createConnection', 'createExternalTable']);
    await db.apply(changes);
    const cat = await db.catalog({ fresh: true });
    expect(cat.connections[0]!.options.url).toBe('https://mirror.example.org/');
    expect(cat.externals.map((x) => x.name)).toEqual(['remote']);
  });

  test('an external table that reads through an undeclared connection is an error', async () => {
    const { db } = await fresh();
    const changes = await db.diff({ tables: [], externals: [externalTable('remote', { location: 'file:types.parquet', connection: 'nowhere' })] });
    expect(changes.diagnostics.map((d) => `${d.level} ${d.object}: ${d.message}`)).toEqual(['error remote: reads through connection nowhere, which is neither in the database nor in the desired schema']);
  });

  test('declared columns are part of the spec: a change makes the table again', async () => {
    const { db } = await fresh();
    const declared = externalTable('typed', { location: 'file:types.parquet' }, { i32: int(), i64: int() });
    await db.migrate({ tables: [], externals: [declared] });
    expect((await db.catalog({ fresh: true })).externals[0]!.columns.map((c) => c.name)).toEqual(['i32', 'i64']);
    expect((await db.diff({ tables: [], externals: [declared] })).steps).toEqual([]);
    const other = externalTable('typed', { location: 'file:types.parquet' }, { i32: int(), f64: real() });
    expect((await db.diff({ tables: [], externals: [other] })).steps.map((s) => `${s.action}: ${s.reason}`)).toEqual(['replaceExternalTable: its columns change']);
  });
});

group('plugins typed by descriptors', () => {
  const pq = definePlugin({ name: '@smaltdb/parquet', tableFunctions: ['read_parquet'] });

  test("a descriptor's table function is a typed relation", async () => {
    const { db } = await fresh();
    const rel = pq.tableFunctions.read_parquet('file:types.parquet', { i32: int(), i64: int(), u8: int(), f32: real(), f64: real(), b: int(), s: text() });
    const rows = await db.rows(rel.filter((r) => r.i32.eq(1)).select((r) => ({ i32: r.i32, s: r.s })));
    expect(rows).toEqual([{ i32: 1, s: 'héllo' }]);
  });

  test("a descriptor's methods type db.plugin(descriptor).call", async () => {
    const { db } = await fresh();
    const io = definePlugin({ name: '@smaltdb/nothing', methods: methods<{ ping(n: number): number }>() });
    // Typed: `call('ping', 'x')` and `call('pong')` are type errors. The engine has no such plugin here.
    await expect(db.plugin(io).call('ping', 1)).rejects.toThrow();
    expect(db.plugin('@smaltdb/parquet')).toBeDefined();
  });
});
