/**
 * Milestone 6: views and their interfaces (DESIGN.md section 8.1, smaltdb ADR 0027). Every view made now has an
 * interface the engine holds: the columns it gave when it was made. Views made before interfaces reflect what they
 * read (made here with `grandfather`). Renames run through the engine, which asks smaltts to edit each view's source.
 */
import { beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { agg, attach, bool, exists, int, iterate, list, real, renameColumnIn, scan, table, tablesOf, text } from '../src/index.js';
import { registerSmaltts } from '../src/language.js';

beforeAll(() => registerSmaltts());

const t = table('t', { id: int().primaryKey(), g: text(), x: int() });
const u = table('u', { id: int().primaryKey(), tid: int() });

async function fresh() {
  const db = attach(Database.openMemory());
  await db.migrate({ tables: [t, u] });
  await db.load(t, [{ id: 1, g: 'a', x: 10 }, { id: 2, g: 'b', x: 20 }]);
  await db.load(u, [{ id: 7, tid: 1 }]);
  return db;
}

/**
 * A database whose view `name` was made before interfaces (smaltdb ADR 0027: grandfathered): it reflects what it reads.
 * Made by removing the interface the engine captured, as an engine before interfaces stored the view.
 */
async function grandfathered(name: string, rel: Parameters<Awaited<ReturnType<typeof fresh>>['createView']>[1]) {
  const raw = Database.openMemory();
  const db = attach(raw);
  await db.migrate({ tables: [t, u] });
  await db.load(t, [{ id: 1, g: 'a', x: 10 }, { id: 2, g: 'b', x: 20 }]);
  await db.load(u, [{ id: 7, tid: 1 }]);
  await db.createView(name, rel);
  // Its stored definition as such an engine wrote it (no interface, not pending), and the view as it was read.
  const engine = raw as unknown as { getView(n: string): { interface?: unknown; pending?: boolean }; writeDefinition(key: string, def: object): void; schemaVersion: number };
  raw.queryPlan({ kind: 'transaction', action: 'begin', mode: 'deferred' } as never);
  engine.writeDefinition(name.toLowerCase(), { kind: 'view', language: 'smaltts' });
  raw.queryPlan({ kind: 'transaction', action: 'commit' } as never);
  delete engine.getView(name).interface;
  delete engine.getView(name).pending;
  engine.schemaVersion++;
  return db;
}

const tWith = (columns: Record<string, ReturnType<typeof int>>) => table('t', { id: int().primaryKey(), ...columns });
const columnsOf = async (db: Awaited<ReturnType<typeof fresh>>, view: string) => Object.keys((await db.rows(scan(view)))[0] ?? {});

group('a rename underneath', () => {
  test('a view keeps its interface: a column it passes through keeps the name it had', async () => {
    const db = await fresh();
    await db.createView('v', scan(t));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), u] });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a', x: 10 }, { id: 2, g: 'b', x: 20 }]);
  });

  test('a view made before interfaces reflects: a column it passes through takes the new name', async () => {
    const db = await grandfathered('v', scan(t));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), u] });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, grp: 'a', x: 10 }, { id: 2, grp: 'b', x: 20 }]);
  });

  test('a view: a column it names itself keeps its name', async () => {
    const db = await fresh();
    await db.createView('v', scan(t).select((r) => ({ g: r.g, double: r.x })));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), u] });
    expect(await db.rows(scan('v'))).toEqual([{ g: 'a', double: 10 }, { g: 'b', double: 20 }]);
  });

  test('an interface view: it reads the new name; its output does not change', async () => {
    const db = await fresh();
    await db.createView('v', scan(t), { columns: ['id', 'g'] });
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), u] });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a' }, { id: 2, g: 'b' }]);
  });

  test('only the renamed table\'s column: a column of the same name in a joined table is untouched', async () => {
    const db = await fresh();
    await db.createView('v', scan(t).join(scan(u), (a, b) => a.id.eq(b.u_tid), { prefix: 'u_' }).pick('id', 'u_id'));
    await db.migrate({ tables: [t, table('u', { uid: int().primaryKey().renamedFrom('id'), tid: int() })] });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, u_id: 7 }]);
    const rel = (await db.catalog({ fresh: true })).view('v')!;
    expect(JSON.stringify(rel)).toContain('"name":"u_uid"');
    expect(JSON.stringify(rel)).not.toContain('"name":"uid"');
  });

  test('a rename read in a window, an explode and a correlated subquery', async () => {
    const db = await fresh();
    const tags = table('tags', { id: int().primaryKey(), tags: list(text()) });
    await db.migrate({ tables: [t, u, tags] });
    await db.load(tags, [{ id: 1, tags: ['p', 'q'] }]);
    await db.createView('w', scan(t).window((r) => ({ total: agg.sum(r.x) }), { partition: ['g'], order: ['id'] }));
    await db.createView('e', scan(tags).explode('tags'));
    await db.createView('s', scan(t).filter((r) => exists(scan(u).filter((x) => x.tid.eq(r.id)))).pick('id'));
    await db.migrate({
      tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), table('u', { id: int().primaryKey(), parent: int().renamedFrom('tid') }), table('tags', { id: int().primaryKey(), labels: list(text()).renamedFrom('tags') })],
    });
    expect((await db.rows(scan('w'))).map((r) => r.total)).toEqual([10, 20]);
    // The view keeps the name it gave the column (its interface).
    expect((await db.rows(scan('e'))).map((r) => r.tags)).toEqual(['p', 'q']);
    expect(await db.rows(scan('s'))).toEqual([{ id: 1 }]);
  });

  test('a table read only in a subquery is renamed in the view', async () => {
    const db = await fresh();
    await db.createView('s', scan(t).filter((r) => exists(scan(u).filter((x) => x.tid.eq(r.id)))).pick('id'));
    await db.migrate({ tables: [t, table('links', { id: int().primaryKey(), tid: int() }, { renamedFrom: 'u' })] });
    expect(await db.rows(scan('s'))).toEqual([{ id: 1 }]);
  });
});

group('a column added underneath', () => {
  test('a view that reads the table in full keeps the columns it had', async () => {
    const db = await fresh();
    await db.createView('v', scan(t));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), g: text(), x: int(), y: int() }), u] });
    expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x']);
  });

  test('a view made before interfaces that reads the table in full gains the column', async () => {
    const db = await grandfathered('v', scan(t));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), g: text(), x: int(), y: int() }), u] });
    expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x', 'y']);
  });

  test('an interface view does not change', async () => {
    const db = await fresh();
    await db.createView('v', scan(t), { columns: true });
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), g: text(), x: int(), y: int() }), u] });
    expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x']);
  });

  test('an interface materialized view refreshes as before', async () => {
    const db = await fresh();
    await db.createView('m', scan(t), { columns: ['g', 'id'], materialized: true });
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), g: text(), x: int(), y: int() }), u] });
    await db.refresh('m');
    expect(await db.rows(scan('m'))).toEqual([{ g: 'a', id: 1 }, { g: 'b', id: 2 }]);
  });
});

group('a column dropped underneath', () => {
  test('the engine refuses to drop a column a view reads, of either kind', async () => {
    for (const columns of [undefined, ['id', 'g'] as const]) {
      const db = await fresh();
      await db.createView('v', scan(t).pick('id', 'g'), columns ? { columns } : {});
      await expect(db.migrate({ tables: [table('t', { id: int().primaryKey(), x: int() }), u] })).rejects.toThrow();
      expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a' }, { id: 2, g: 'b' }]);
    }
  });
});

group('declaring an interface', () => {
  test('the catalog lists a view\'s declared columns; a reflecting view has none', async () => {
    const db = await fresh();
    await db.createView('i', scan(t), { columns: ['x', 'id'] });
    await db.createView('r', scan(t));
    await db.createView('m', scan(t), { columns: true, materialized: true, storage: 'columnar' });
    const views = (await db.catalog({ fresh: true })).views;
    expect(views.find((v) => v.name === 'i')).toMatchObject({ columns: ['x', 'id'], materialized: false });
    expect(views.find((v) => v.name === 'r')?.columns).toBeUndefined();
    expect(views.find((v) => v.name === 'm')).toMatchObject({ columns: ['id', 'g', 'x'], materialized: true, storage: 'columnar' });
    expect(await db.rows(scan('i'))).toEqual([{ x: 10, id: 1 }, { x: 20, id: 2 }]);
  });

  test('a column the relation does not have, or one listed twice, is refused', async () => {
    const db = await fresh();
    await expect(db.createView('v', scan(t), { columns: ['id', 'nope'] })).rejects.toThrow(/^createView v: no column named nope/);
    await expect(db.createView('v', scan(t), { columns: ['id', 'ID'] })).rejects.toThrow(/^createView v: a column is listed twice/);
  });

  test('dropView', async () => {
    const db = await fresh();
    await db.createView('v', scan(t));
    await db.dropView('v');
    expect((await db.catalog({ fresh: true })).views).toEqual([]);
    await db.dropView('v', { ifExists: true });
  });
});

group('the relation edits, as functions', () => {
  test('tablesOf reads subqueries and recursion', () => {
    const rel = iterate(scan(t).pick('id'), (prev) => prev.filter((r) => exists(scan(u).filter((x) => x.tid.eq(r.id)))));
    expect(tablesOf(rel.node)).toEqual(['t', 'u']);
  });

  test('renameColumnIn follows extend, and not a name the view gives itself', () => {
    const rel = scan(t).extend((r) => ({ y: r.x })).filter((r) => r.g.eq('a').and(r.y.gt(1)));
    const json = JSON.stringify(renameColumnIn(rel.node, 't', 'g', 'grp'));
    expect(json).toContain('{"k":"col","name":"grp"}');
    expect(JSON.stringify(renameColumnIn(rel.node, 't', 'y', 'z'))).toBe(JSON.stringify(rel.node));
  });
});

group('change sets: what a table change does to the views reading it', () => {
  // Every view made now holds its interface, with a column list or without one (smaltdb ADR 0027).
  const kinds = [
    { name: 'a view', columns: undefined, materialized: false },
    { name: 'a materialized view', columns: undefined, materialized: true },
    { name: 'a view with a column list', columns: ['id', 'g', 'x'], materialized: false },
    { name: 'a materialized view with a column list', columns: ['id', 'g', 'x'], materialized: true },
  ] as const;
  const renamed = table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() });
  const added = table('t', { id: int().primaryKey(), g: text(), x: int(), y: int() });
  const dropped = table('t', { id: int().primaryKey(), g: text() });

  async function withView(kind: (typeof kinds)[number]) {
    const db = await fresh();
    await db.createView('v', scan(t), { ...(kind.columns ? { columns: kind.columns } : {}), materialized: kind.materialized });
    return db;
  }
  const entries = (c: { steps: readonly { action: string; object: string; impact: string }[]; diagnostics: readonly { level: string; object: string }[] }) => ({
    steps: c.steps.filter((s) => s.object === 'v').map((s) => `${s.action} ${s.impact}`),
    diagnostics: c.diagnostics.filter((d) => d.object.startsWith('v')).map((d) => d.level),
  });

  for (const kind of kinds) {
    test(`${kind.name}: a rename holds its interface`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [renamed, u] });
      expect(entries(changes)).toEqual({ steps: [], diagnostics: [] });
      await db.apply(changes);
      expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x']);
      expect((await db.diff({ tables: [renamed, u] })).steps).toEqual([]);
    });

    test(`${kind.name}: an added column doesn't reach it`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [added, u] });
      // Without a column list, the view's relation gains the column: a note that the view keeps the ones it had.
      expect(entries(changes)).toEqual({ steps: [], diagnostics: kind.columns ? [] : ['info'] });
      await db.apply(changes);
      expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x']);
      if (kind.materialized) await db.refresh('v');
      expect(await columnsOf(db, 'v')).toEqual(['id', 'g', 'x']);
    });

    test(`${kind.name}: a dropped column it gives is an error`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [dropped, u] }, { allowDataLoss: 'certain' });
      expect(entries(changes).diagnostics).toEqual(['error']);
      expect(changes.diagnostics.find((d) => d.object === 'v')?.message).toMatch(/^the change set breaks this view/);
      await expect(db.apply(changes, { allowDataLoss: 'certain' })).rejects.toThrow(/the change set has errors: v: the change set breaks this view/);
    });
  }

  test('a view made before interfaces reflects: a rename, an added column and a dropped one follow', async () => {
    const rename = await grandfathered('v', scan(t));
    const r = await rename.diff({ tables: [renamed, u] });
    expect(entries(r)).toEqual({ steps: [], diagnostics: ['info'] });
    await rename.apply(r);
    expect(await columnsOf(rename, 'v')).toEqual(['id', 'grp', 'x']);
    const add = await grandfathered('v', scan(t));
    await add.apply(await add.diff({ tables: [added, u] }));
    expect(await columnsOf(add, 'v')).toEqual(['id', 'g', 'x', 'y']);
    const drop = await grandfathered('v', scan(t));
    const d = await drop.diff({ tables: [dropped, u] }, { allowDataLoss: 'certain' });
    expect(entries(d)).toEqual({ steps: [], diagnostics: ['info'] });
    await drop.apply(d, { allowDataLoss: 'certain' });
    expect(await columnsOf(drop, 'v')).toEqual(['id', 'g']);
  });

  test(`a dropped column a view names is an error`, async () => {
    const db = await fresh();
    await db.createView('v', scan(t).pick('id', 'x'));
    const changes = await db.diff({ tables: [dropped, u] }, { allowDataLoss: 'certain' });
    expect(entries(changes)).toEqual({ steps: [], diagnostics: ['error'] });
  });

  test('a rename the engine does not edit (inside a rebuild) is a replaceView step', async () => {
    const db = await fresh();
    await db.createView('v', scan(t).pick('id', 'g'));
    const want = table('t', { id: int().primaryKey(), grp: text().notNull().renamedFrom('g'), x: int() });
    const changes = await db.diff({ tables: [want, u] }, { allowDataLoss: 'possible' });
    expect(changes.steps.map((s) => `${s.action} ${s.object}`)).toEqual(['rebuildTable t', 'replaceView v']);
    expect(changes.steps[1]!.reason).toBe('it reads a column a rebuild renames');
    await db.apply(changes, { allowDataLoss: 'possible' });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a' }, { id: 2, g: 'b' }]);
  });

  test("an interface's type change: lossless to its type is converted by the engine, otherwise an error", async () => {
    const db = await fresh();
    await db.createView('v', scan(t), { columns: ['id', 'x'] });
    const toBool = await db.diff({ tables: [table('t', { id: int().primaryKey(), g: text(), x: bool() }), u] }, { allowDataLoss: 'possible' });
    expect(toBool.diagnostics.filter((d) => d.object === 'v.x').map((d) => `${d.level}: ${d.message}`)).toEqual(["info: the column becomes bool: the engine converts it to the interface's int"]);
    const toText = await db.diff({ tables: [table('t', { id: int().primaryKey(), g: text(), x: text() }), u] }, { allowDataLoss: 'possible' });
    expect(toText.diagnostics.filter((d) => d.object === 'v.x').map((d) => `${d.level}: ${d.message}`)).toEqual([
      "error: the interface's column becomes text, which doesn't convert losslessly to its int: change the view in the same change set",
    ]);
  });

  test('a lossless type change is read as the interface says', async () => {
    const db = await fresh();
    await db.createView('v', scan(t).pick('id', 'g'));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), g: text(), x: real() }), u] }, { allowDataLoss: 'possible' });
    // x is not in the view; the view's columns and types stay as they were.
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a' }, { id: 2, g: 'b' }]);
  });

  test('a view of another view holds through a change to the table under both', async () => {
    const db = await fresh();
    await db.createView('base', scan(t));
    await db.createView('top', scan('base').pick('id', 'g'), { materialized: true });
    const changes = await db.diff({ tables: [renamed, u] });
    expect(changes.diagnostics.filter((d) => d.object === 'top' || d.object === 'base')).toEqual([]);
    await db.apply(changes);
    await db.refresh('top');
    expect(await db.rows(scan('top'))).toEqual([{ id: 1, g: 'a' }, { id: 2, g: 'b' }]);
  });
});

group('DDL from outside smaltts (milestone 6, part 2)', () => {
  // The schema operations any language sends (smaltql's DROP and ALTER TABLE map to these): the engine holds a
  // smaltts view's interface against them, as smaltts's own change sets do.
  test('the engine refuses a drop or a column drop a smaltts view reads, and cascades only when asked', async () => {
    const raw = Database.openMemory();
    const db = attach(raw);
    await db.migrate({ tables: [t, u] });
    await db.createView('v', scan(t).pick('id', 'g'));
    const schema = (op: object) => raw.preparePlan({ kind: 'schema', op } as never).run();
    expect(() => schema({ op: 'drop', objectType: 'table', name: 't', ifExists: false })).toThrow(/breaks the interface of view v/);
    expect(() => schema({ op: 'alterTable', table: 't', action: { kind: 'dropColumn', column: 'g' } })).toThrow();
    expect((await db.catalog({ fresh: true })).views.map((v) => v.name)).toEqual(['v']);
    expect(schema({ op: 'alterTable', table: 't', action: { kind: 'dropColumn', column: 'g' }, cascade: true }).cascaded).toEqual(['v']);
    expect((await db.catalog({ fresh: true })).views).toEqual([]);
  });

  test('a rename from outside smaltts edits the view, which keeps its interface', async () => {
    const raw = Database.openMemory();
    const db = attach(raw);
    await db.migrate({ tables: [t, u] });
    await db.load(t, [{ id: 1, g: 'a', x: 10 }]);
    await db.createView('v', scan(t));
    raw.preparePlan({ kind: 'schema', op: { op: 'alterTable', table: 't', action: { kind: 'renameColumn', column: 'g', newName: 'grp' } } }).run();
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, g: 'a', x: 10 }]);
    expect((await db.catalog({ fresh: true })).views[0]!.interface!.map((c) => c.name)).toEqual(['id', 'g', 'x']);
  });
});
