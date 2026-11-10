/**
 * Milestone 6, part 1: reflecting and interface views (DESIGN.md section 8.1). Renames run through the engine, which
 * asks smaltts to edit each view's source; additions change the tables underneath.
 */
import { beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { agg, attach, bool, exists, int, iterate, list, renameColumnIn, scan, table, tablesOf, text } from '../src/index.js';
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

const tWith = (columns: Record<string, ReturnType<typeof int>>) => table('t', { id: int().primaryKey(), ...columns });
const columnsOf = async (db: Awaited<ReturnType<typeof fresh>>, view: string) => Object.keys((await db.rows(scan(view)))[0] ?? {});

group('a rename underneath', () => {
  test('a reflecting view: a column it passes through takes the new name', async () => {
    const db = await fresh();
    await db.createView('v', scan(t));
    await db.migrate({ tables: [table('t', { id: int().primaryKey(), grp: text().renamedFrom('g'), x: int() }), u] });
    expect(await db.rows(scan('v'))).toEqual([{ id: 1, grp: 'a', x: 10 }, { id: 2, grp: 'b', x: 20 }]);
  });

  test('a reflecting view: a column it names itself keeps its name', async () => {
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
    expect((await db.rows(scan('e'))).map((r) => r.labels)).toEqual(['p', 'q']);
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
  test('a reflecting view that reads the table in full gains the column', async () => {
    const db = await fresh();
    await db.createView('v', scan(t));
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
  const kinds = [
    { name: 'reflecting', columns: undefined, materialized: false },
    { name: 'reflecting materialized', columns: undefined, materialized: true },
    { name: 'interface', columns: ['id', 'g', 'x'], materialized: false },
    { name: 'interface materialized', columns: ['id', 'g', 'x'], materialized: true },
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
    const reflecting = !kind.columns;
    test(`${kind.name}: a rename`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [renamed, u] });
      expect(entries(changes)).toEqual(reflecting ? { steps: kind.materialized ? ['replaceView rewrite'] : [], diagnostics: ['info'] } : { steps: [], diagnostics: [] });
      await db.apply(changes);
      expect(await columnsOf(db, 'v')).toEqual(reflecting ? ['id', 'grp', 'x'] : ['id', 'g', 'x']);
      expect((await db.diff({ tables: [renamed, u] })).steps).toEqual([]);
    });

    test(`${kind.name}: an added column`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [added, u] });
      expect(entries(changes)).toEqual(reflecting ? { steps: kind.materialized ? ['replaceView rewrite'] : [], diagnostics: ['info'] } : { steps: [], diagnostics: [] });
      await db.apply(changes);
      expect(await columnsOf(db, 'v')).toEqual(reflecting ? ['id', 'g', 'x', 'y'] : ['id', 'g', 'x']);
      if (kind.materialized) await db.refresh('v');
    });

    test(`${kind.name}: a dropped column`, async () => {
      const db = await withView(kind);
      const changes = await db.diff({ tables: [dropped, u] }, { allowDataLoss: 'certain' });
      if (reflecting) {
        // A view that passes the table through loses the column, as it gains an added one.
        expect(entries(changes)).toEqual({ steps: kind.materialized ? ['replaceView rewrite'] : [], diagnostics: ['info'] });
        await db.apply(changes, { allowDataLoss: 'certain' });
        expect(await columnsOf(db, 'v')).toEqual(['id', 'g']);
      } else {
        expect(entries(changes).diagnostics).toEqual(['error']);
        expect(changes.diagnostics.find((d) => d.object === 'v')?.message).toMatch(/^the change set breaks this view: no column named x/);
        await expect(db.apply(changes, { allowDataLoss: 'certain' })).rejects.toThrow(/the change set has errors: v: the change set breaks this view/);
      }
    });

    test(`${kind.name}: a dropped column it names is an error`, async () => {
      const db = await fresh();
      await db.createView('v', scan(t).pick('id', 'x'), { ...(kind.columns ? { columns: ['id', 'x'] } : {}), materialized: kind.materialized });
      const changes = await db.diff({ tables: [dropped, u] }, { allowDataLoss: 'certain' });
      expect(entries(changes)).toEqual({ steps: [], diagnostics: ['error'] });
    });
  }

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

  test("an interface's type change: lossless to its type is a warning, otherwise an error", async () => {
    const db = await fresh();
    await db.createView('v', scan(t), { columns: ['id', 'x'] });
    const toBool = await db.diff({ tables: [table('t', { id: int().primaryKey(), g: text(), x: bool() }), u] }, { allowDataLoss: 'possible' });
    expect(toBool.diagnostics.filter((d) => d.object === 'v.x').map((d) => d.level)).toEqual(['warning']);
    const toText = await db.diff({ tables: [table('t', { id: int().primaryKey(), g: text(), x: text() }), u] }, { allowDataLoss: 'possible' });
    expect(toText.diagnostics.filter((d) => d.object === 'v.x').map((d) => `${d.level}: ${d.message}`)).toEqual([
      "error: the interface's column becomes text, which doesn't convert losslessly to its int: change the view in the same change set",
    ]);
  });

  test('a view of another view follows a change to the table under both', async () => {
    const db = await fresh();
    await db.createView('base', scan(t));
    await db.createView('top', scan('base').pick('id', 'g'), { materialized: true });
    const changes = await db.diff({ tables: [renamed, u] });
    expect(changes.diagnostics.find((d) => d.object === 'top')?.level).toBe('error');
  });
});
