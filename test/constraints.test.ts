/** Milestone 2, part 2: CHECKs, computed defaults and foreign keys, enforced by the engine and read back for diffs. */
import { beforeAll, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { attach, fn, int, real, scan, table, text } from '../src/index.js';
import { registerSmaltts } from '../src/language.js';

// The engine edits smaltts's CHECK texts on a rename with the smaltts language (exprLanguage, smaltdb#190).
beforeAll(() => registerSmaltts());

const customers = table('customers', { id: int().primaryKey(), name: text().notNull() });
const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().references(customers, 'id', { onDelete: 'CASCADE' }),
  qty: int().notNull().check((q) => q.gt(0), 'qty_positive'),
  price: real().notNull(),
  priority: int().defaultExpr(fn.abs(-5)),
}, { checks: (r) => ({ affordable: r.price.lte(1000) }) });

async function fresh() {
  const db = attach(Database.openMemory());
  await db.migrate({ tables: [customers, orders] });
  await db.load(customers, [{ name: 'Ada' }]);
  return db;
}

test('the engine enforces CHECKs, computed defaults and foreign keys', async () => {
  const db = await fresh();
  await db.load(orders, [{ customerId: 1, qty: 2, price: 10 }]);
  expect(await db.rows(scan(orders).pick('priority'))).toEqual([{ priority: 5 }]);
  await expect(db.load(orders, [{ customerId: 1, qty: 0, price: 10 }])).rejects.toThrow(/qty_positive/);
  await expect(db.load(orders, [{ customerId: 1, qty: 1, price: 5000 }])).rejects.toThrow(/affordable/);
  await expect(db.load(orders, [{ customerId: 9, qty: 1, price: 10 }])).rejects.toThrow(/FOREIGN KEY/i);
  await db.deleteWhere(customers, (c) => c.id.eq(1));
  expect(await db.rows(scan(orders))).toEqual([]);
});

test('constraints and computed defaults are read back: diffing against the database finds nothing', async () => {
  const db = await fresh();
  expect((await db.diff({ tables: [customers, orders] })).steps).toEqual([]);
  const read = (await db.catalog({ fresh: true })).table('orders')!;
  expect(read.checks?.map((c) => c.name)).toEqual(['qty_positive', 'affordable']);
  expect(read.foreignKeys).toMatchObject([{ columns: ['customerId'], table: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }]);
  expect(read.columns.find((c) => c.name === 'priority')!.defaultExpr).toEqual({ k: 'fn', name: 'abs', args: [{ k: 'lit', value: -5 }] });
});

test('a changed CHECK or foreign key action is a rebuild, and the rows survive it', async () => {
  const db = await fresh();
  await db.load(orders, [{ customerId: 1, qty: 2, price: 10 }]);
  const stricter = table('orders', {
    id: int().primaryKey(),
    customerId: int().notNull().references(customers, 'id', { onDelete: 'RESTRICT' }),
    qty: int().notNull().check((q) => q.gt(1), 'qty_positive'),
    price: real().notNull(),
    priority: int().defaultExpr(fn.abs(-5)),
  }, { checks: (r) => ({ affordable: r.price.lte(1000) }) });
  const changes = await db.diff({ tables: [customers, stricter] });
  expect(changes.steps.map((s) => [s.action, s.reason])).toEqual([['rebuildTable', 'CHECKs change; foreign keys change']]);
  await db.apply(changes);
  expect(await db.rows(scan(orders).pick('qty'))).toEqual([{ qty: 2 }]);
  expect((await db.diff({ tables: [customers, stricter] })).steps).toEqual([]);
});

test('renaming a column a CHECK reads converges', async () => {
  const db = await fresh();
  const renamed = table('orders', {
    id: int().primaryKey(),
    customerId: int().notNull().references(customers, 'id', { onDelete: 'CASCADE' }),
    quantity: int().notNull().renamedFrom('qty').check((q) => q.gt(0), 'qty_positive'),
    price: real().notNull(),
    priority: int().defaultExpr(fn.abs(-5)),
  }, { checks: (r) => ({ affordable: r.price.lte(1000) }) });
  await db.migrate({ tables: [customers, renamed] });
  expect((await db.diff({ tables: [customers, renamed] })).steps).toEqual([]);
  await expect(db.load(renamed, [{ customerId: 1, quantity: 0, price: 1 }])).rejects.toThrow(/qty_positive/);
});
