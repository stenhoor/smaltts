import { beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { agg, attach, describe, inferTable, int, param, real, registerSmaltts, scan, table, text, values } from '../src/index.js';

beforeAll(() => registerSmaltts());

const customers = table('customers', {
  id: int().primaryKey(),
  email: text().notNull().unique().collate('nocase'),
  name: text(),
});
const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().indexed(),
  total: real().notNull(),
});
const v1 = { tables: [customers, orders] };

async function fresh() {
  const db = attach(Database.openMemory());
  await db.migrate(v1);
  return db;
}

group('schema: desired state, diff, apply', () => {
  test('a new database gets every table and index; diffing again finds nothing', async () => {
    const db = attach(Database.openMemory());
    const changes = await db.diff(v1);
    expect(changes.steps.map((s) => `${s.action} ${s.object}`)).toEqual(['createTable customers', 'createTable orders', 'createIndex orders_customerId']);
    expect(changes.dataLoss).toBe('none');
    await db.apply(changes, { label: 'v1' });
    expect((await db.diff(v1)).steps).toEqual([]);
  });

  test('adding a column, renaming a column and adding an index are in-place steps', async () => {
    const db = await fresh();
    const v2 = {
      tables: [
        table('customers', { id: int().primaryKey(), email: text().notNull().unique().collate('nocase'), fullName: text().renamedFrom('name'), region: text().default('north') }, { indexes: [{ name: 'customers_region', columns: [{ column: 'region' }] }] }),
        orders,
      ],
    };
    const changes = await db.diff(v2);
    expect(changes.steps.map((s) => `${s.action} ${s.object} ${s.impact}`)).toEqual(['renameColumn customers.fullName metadata', 'addColumn customers.region instant', 'createIndex customers_region build']);
    await db.apply(changes);
    expect((await db.diff(v2)).steps).toEqual([]);
  });

  test('a type change is a rebuild; the default policy refuses possible data loss, and the rows survive', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 2, total: 12 }]);
    const v2 = { tables: [customers, table('orders', { id: int().primaryKey(), customerId: int().notNull().indexed(), total: text().notNull() })] };
    const changes = await db.diff(v2);
    expect(changes.steps.map((s) => [s.action, s.impact, s.dataLoss])).toEqual([['rebuildTable', 'rewrite', 'possible']]);
    expect(describe(changes)).toContain('total: type REAL → TEXT');
    await expect(db.apply(changes)).rejects.toThrow(/policy refuses/);
    await db.apply(changes, { allowDataLoss: 'possible' });
    expect(await db.rows(scan('orders').pick('total'))).toEqual([{ total: '10' }, { total: '12' }]);
    expect((await db.diff(v2)).steps).toEqual([]);
  });

  test('tables not in the desired schema are reported, and dropped only with prune', async () => {
    const db = await fresh();
    const only = { tables: [customers] };
    const kept = await db.diff(only);
    expect(kept.steps).toEqual([]);
    expect(kept.diagnostics.map((d) => d.object)).toEqual(['orders']);
    const pruned = await db.diff(only, { prune: true });
    expect(pruned.steps.map((s) => [s.action, s.dataLoss])).toEqual([['dropTable', 'certain']]);
  });

  test('change sets are JSON and are recorded with their checksum', async () => {
    const db = attach(Database.openMemory());
    const changes = JSON.parse(JSON.stringify(await db.diff(v1)));
    const applied = await db.apply(changes, { label: 'v1' });
    expect(await db.rows(scan('smaltts_history').pick('checksum', 'label'))).toEqual([{ checksum: applied.checksum, label: 'v1' }]);
  });

  test('a schema discovered at run time goes through the same path', async () => {
    const db = await fresh();
    const sample = [{ sku: 'a-1', price: 9.5, stock: 3 }, { sku: 'b-2', price: 12, stock: null }];
    const products = inferTable('products', sample, { primaryKey: ['sku'] });
    expect(products.columns).toEqual([{ name: 'sku', type: 'TEXT', notNull: true }, { name: 'price', type: 'REAL' }, { name: 'stock', type: 'INTEGER' }]);
    await db.migrate({ tables: [customers, orders, products] });
    await db.load(products, sample);
    expect(await db.rows(scan('products').filter((p) => p.stock.isNull()).pick('sku'))).toEqual([{ sku: 'b-2' }]);
  });
});

group('plans: relations, loads, views, explain', () => {
  test('loads in each mode', async () => {
    const db = await fresh();
    await db.load(customers, [{ email: 'a@x.dev', name: 'Ada' }, { email: 'b@x.dev', name: 'Bo' }]);
    await db.load(customers, [{ id: 2, email: 'b@x.dev', name: 'Bob' }, { id: 3, email: 'c@x.dev', name: 'Cy' }], { mode: 'upsert' });
    expect(await db.rows(scan(customers).sort('id').pick('id', 'name'))).toEqual([{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Cy' }]);
    await db.load(customers, [{ email: 'z@x.dev', name: 'Zed' }], { mode: 'replace' });
    expect(await db.rows(scan(customers).pick('name'))).toEqual([{ name: 'Zed' }]);
    await db.load(orders, [{ customerId: 1, total: 5 }]);
    const r = await db.load(orders, values([{ name: 'customerId', type: 'INTEGER' }, { name: 'total', type: 'REAL' }], [{ customerId: 9, total: 1 }, { customerId: 9, total: 2 }]), { mode: 'swap' });
    expect(r.rows).toBe(2);
    expect((await db.diff(v1)).steps).toEqual([]); // the swapped table has its index back
  });

  test('a pipeline: join, aggregate, sort, typed rows, named parameters', async () => {
    const db = await fresh();
    await db.load(customers, [{ email: 'a@x.dev', name: 'Ada' }, { email: 'b@x.dev', name: 'Bo' }]);
    await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 1, total: 30 }, { customerId: 2, total: 5 }]);
    const spend = scan(orders)
      .filter((o) => o.total.gte(param.real('min')))
      .join(scan(customers), (o, c) => o.customerId.eq(c.c_id), { prefix: 'c_' })
      .aggregate((r) => ({ name: r.c_name }), (r) => ({ spent: agg.sum(r.total), orders: agg.count(), avg: agg.avg(r.total) }))
      .sort('-spent');
    const rows = await db.rows(spend, { min: 1 });
    const first: { name: string | null; spent: number | null; orders: number } = rows[0]!;
    expect(first).toEqual({ name: 'Ada', spent: 40, orders: 2, avg: 20 });
    expect(rows).toHaveLength(2);
  });

  test('div is float division, intDiv truncates', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 7, total: 1 }]);
    expect(await db.rows(scan(orders).select((o) => ({ d: o.customerId.div(2), i: o.customerId.intDiv(2) })))).toEqual([{ d: 3.5, i: 3 }]);
  });

  test('a materialized view stored as a smaltts relation, refreshed by the engine', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 1, total: 30 }]);
    const byCustomer = scan(orders).aggregate((o) => ({ customerId: o.customerId }), (o) => ({ total: agg.sum(o.total) }));
    await db.createView('order_totals', byCustomer, { materialized: true, storage: 'columnar' });
    expect(await db.rows(scan('order_totals'))).toEqual([{ customerId: 1, total: 40 }]);
    await db.load(orders, [{ customerId: 2, total: 1 }]);
    await db.refresh('order_totals');
    expect(await db.rows(scan('order_totals').sort('customerId'))).toEqual([{ customerId: 1, total: 40 }, { customerId: 2, total: 1 }]);
    const catalog = await db.catalog({ fresh: true });
    expect(catalog.views.map((v) => [v.name, v.materialized])).toEqual([['order_totals', true]]);
  });

  test('a plain view is stored as a smaltts relation and read by name', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 2, total: 3 }]);
    await db.createView('big_orders', scan(orders).filter((o) => o.total.gt(5)).pick('customerId', 'total'));
    expect(await db.rows(scan('big_orders'))).toEqual([{ customerId: 1, total: 10 }]);
  });

  // A view's columns are its interface: a rename in the table beneath it changes what the view reads, not what it
  // gives, so the steps downstream of the view keep working.
  test('ALTER TABLE edits smaltts sources: a column rename reaches the views that read it', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 1, total: 10 }]);
    await db.createView('big', scan(orders).filter((o) => o.total.gt(5)).pick('customerId', 'total'));
    await db.migrate({ tables: [customers, table('orders', { id: int().primaryKey(), buyer: int().notNull().renamedFrom('customerId').indexed(), total: real().notNull() })] });
    expect(await db.rows(scan('big'))).toEqual([{ customerId: 1, total: 10 }]);
    expect((await db.catalog({ fresh: true })).view('big')).toMatchObject({ input: { input: { r: 'scan', table: 'orders' } }, fields: [['customerId', { k: 'col', name: 'buyer' }], ['total', { k: 'col', name: 'total' }]] });
  });

  // Engine finding F1 (docs/DESIGN.md): the first materialized view creates the system table smalt_matview from SQL
  // text, so every later RENAME COLUMN asks the sql language to edit it. Flips to passing when smaltdb fixes it.
  test.fails('ALTER TABLE edits smaltts sources: a rename keeps materialized views working', async () => {
    const db = await fresh();
    await db.load(orders, [{ customerId: 1, total: 10 }]);
    await db.createView('big', scan(orders).filter((o) => o.total.gt(5)).pick('customerId', 'total'), { materialized: true });
    await db.migrate({ tables: [customers, table('orders', { id: int().primaryKey(), buyer: int().notNull().renamedFrom('customerId').indexed(), total: real().notNull() }, { renamedFrom: 'orders' })] });
    await db.refresh('big');
    expect(await db.rows(scan('big'))).toEqual([{ buyer: 1, total: 10 }]);
  });

  test('explain gives the physical plan as a tree; analyze measures it', async () => {
    const db = await fresh();
    await db.load(orders, Array.from({ length: 2000 }, (_, i) => ({ customerId: i % 500, total: i })));
    await db.analyze();
    const rel = scan(orders).filter((o) => o.customerId.eq(2)).pick('total');
    const plan = await db.explain(rel);
    expect(String(plan)).toMatch(/orders_customerId/);
    const run = await db.explain(rel, { analyze: true });
    expect(run.roots[0]!.actual!.rows).toBe(4);
    expect(String(run)).toMatch(/est \d+ rows/);
  });

  test('relations are JSON: what views store and toolchains exchange', () => {
    const rel = scan(orders).filter((o) => o.total.gt(5)).pick('id');
    expect(JSON.parse(JSON.stringify(rel))).toEqual({ r: 'select', input: { r: 'filter', input: { r: 'scan', table: 'orders' }, pred: { k: 'op', op: 'gt', args: [{ k: 'col', name: 'total' }, { k: 'lit', value: 5 }] } }, fields: [['id', { k: 'col', name: 'id' }]] });
  });

  test('names are checked at compile time', () => {
    // @ts-expect-error: orders has no column named totl
    scan(orders).filter((o) => o.totl.gt(5));
    // @ts-expect-error: total is a number
    scan(orders).filter((o) => o.total.eq('five'));
    // @ts-expect-error: sort keys are column names
    scan(orders).sort('-nope');
    expect(true).toBe(true);
  });
});
