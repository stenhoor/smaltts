/**
 * Milestone 4: saved change sets (gate A: live diff, and saved change sets as well). Files are made the way CI would
 * make them: by diffing a development database against each version of the schema, saving the change set with that
 * schema, and applying it there before the next.
 */
import { describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import * as P from 'smaltdb/plan';
import { type NamedFile, type SchemaSpec, attach, changeSetFile, int, parseChangeSetFile, real, scan, table, text } from '../src/index.js';

const v1: SchemaSpec = { tables: [table('orders', { id: int().primaryKey(), total: real().notNull() })] };
const v2: SchemaSpec = { tables: [table('orders', { id: int().primaryKey(), total: real().notNull(), note: text() }, { indexes: [{ name: 'orders_total', columns: [{ column: 'total' }] }] })] };
const v3: SchemaSpec = {
  tables: [
    table('orders', { id: int().primaryKey(), amount: real().notNull().renamedFrom('total'), note: text() }, { indexes: [{ name: 'orders_total', columns: [{ column: 'amount' }] }] }),
    table('customers', { id: int().primaryKey(), name: text() }),
  ],
};

/** The files CI would save for v1, v2 and v3, named so they sort in order. */
async function saved(): Promise<NamedFile[]> {
  const dev = attach(Database.openMemory());
  const files: NamedFile[] = [];
  for (const [i, v] of [v1, v2, v3].entries()) {
    const changes = await dev.diff(v);
    files.push({ name: `000${i + 1}.json`, text: JSON.stringify(changeSetFile(changes, v)) });
    await dev.apply(changes);
  }
  return files;
}

const shape = async (db: ReturnType<typeof attach>) => JSON.stringify((await db.catalog({ fresh: true })).tables.filter((t) => t.name !== 'smaltts_history'));

group('replaying saved change sets', () => {
  test('two databases at different versions reach the same catalog by replaying the same files', async () => {
    const files = await saved();
    const older = attach(Database.openMemory());
    expect((await older.migrateFiles(files.slice(0, 1))).applied).toEqual(['0001.json']);
    await older.load(v1.tables[0]!, [{ total: 5 }]);
    const fresh = attach(Database.openMemory());

    const a = await older.migrateFiles(files);
    const b = await fresh.migrateFiles(files);
    expect([a.skipped, a.applied]).toEqual([['0001.json'], ['0002.json', '0003.json']]);
    expect([b.skipped, b.applied]).toEqual([[], ['0001.json', '0002.json', '0003.json']]);
    expect(a.drift.steps).toEqual([]);
    expect(b.drift.steps).toEqual([]);
    expect(await shape(older)).toBe(await shape(fresh));
    // The rows survive, under the renamed column.
    expect(await older.rows(scan('orders').pick('amount'))).toEqual([{ amount: 5 }]);
    // Replaying again does nothing.
    expect((await fresh.migrateFiles(files)).applied).toEqual([]);
  });

  test('the history records each file by name and checksum', async () => {
    const files = await saved();
    const db = Database.openMemory();
    await attach(db).migrateFiles(files);
    const rows = db.queryPlan(P.scan('smaltts_history', [4, 5])).rows as unknown[][];
    expect(rows.map((r) => r[0])).toEqual(['0001.json', '0002.json', '0003.json']);
    expect(rows.map((r) => r[1])).toEqual(files.map((f) => parseChangeSetFile(f.text).checksum));
  });

  test('files run in name order, whatever order they are given in', async () => {
    const files = await saved();
    const db = attach(Database.openMemory());
    expect((await db.migrateFiles([...files].reverse())).applied).toEqual(['0001.json', '0002.json', '0003.json']);
  });
});

group('refusals', () => {
  test('a file edited after it was saved', async () => {
    const files = await saved();
    const edited = files[1]!.text.replace('"note"', '"memo"');
    expect(() => parseChangeSetFile(edited, '0002.json')).toThrow(/^0002.json: edited after it was saved/);
    await expect(attach(Database.openMemory()).migrateFiles([files[0]!, { name: '0002.json', text: edited }])).rejects.toThrow(/edited after it was saved/);
  });

  test('a file that is not a change-set file', () => {
    expect(() => parseChangeSetFile('{"steps": []}', 'x.json')).toThrow(/^x.json: not a smaltts change-set file/);
    expect(() => parseChangeSetFile('nope', 'x.json')).toThrow(/^x.json: not JSON/);
  });

  test('a file changed since it was applied (saved again under the same name)', async () => {
    const files = await saved();
    const db = attach(Database.openMemory());
    await db.migrateFiles(files.slice(0, 1));
    const other = changeSetFile(await attach(Database.openMemory()).diff(v2), v2);
    await expect(db.migrateFiles([{ name: '0001.json', text: JSON.stringify(other) }])).rejects.toThrow(/^0001.json: changed since it was applied/);
  });

  test('a file added before one already applied', async () => {
    const files = await saved();
    const db = attach(Database.openMemory());
    await db.migrateFiles(files.slice(0, 2));
    const late = { name: '0001a.json', text: files[2]!.text };
    await expect(db.migrateFiles([files[0]!, late, files[1]!])).rejects.toThrow(/^0001a.json: not applied, but the later 0002.json is: a file was added out of order/);
  });

  test('a database that drifted from the history', async () => {
    const files = await saved();
    const db = attach(Database.openMemory());
    await db.migrateFiles(files.slice(0, 1));
    await db.migrate({ tables: [...v1.tables, table('extra', { id: int().primaryKey() })] });
    await expect(db.migrateFiles(files)).rejects.toThrow(/^0002.json: the database has drifted from the history \(it doesn't have 0001.json's schema\): dropTable extra/);
  });

  test('a policy can refuse what a file does', async () => {
    const files = await saved();
    const db = attach(Database.openMemory());
    await expect(db.migrateFiles(files, { maxImpact: 'metadata' })).rejects.toThrow(/the policy refuses/);
  });
});

test('a history table from before milestone 4 gains the file columns', async () => {
  const db = Database.openMemory();
  const old = { name: 'smaltts_history', storage: 'row' as const, keys: [{ kind: 'primaryKey' as const, columns: [{ column: 0, desc: false, collation: 'binary' as const }] }], checks: [], foreignKeys: [] };
  const col = (name: string, type: 'INTEGER' | 'TEXT', notNull: boolean) => ({ name, declaredType: type, type, notNull, collation: 'binary' as const });
  db.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: { ...old, columns: [col('id', 'INTEGER', true), col('checksum', 'TEXT', true), col('label', 'TEXT', false), col('steps', 'TEXT', true)] } as never } });
  const files = await saved();
  expect((await attach(db).migrateFiles(files)).applied).toHaveLength(3);
  expect(db.catalog.table('smaltts_history')!.columns.map((c) => c.name)).toEqual(['id', 'checksum', 'label', 'steps', 'file', 'file_checksum']);
});
