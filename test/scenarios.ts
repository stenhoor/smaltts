/**
 * Scenarios that run the same way in process and through the worker client (milestone 10): each takes a database
 * attached to either and gives a value to compare. `test/client.test.ts` runs them in Node (the engine in a worker
 * thread), `test/browser/` in each browser (the engine in a Web Worker). They import nothing of the test runner.
 */
import { type SmaltDb, agg, bool, date, fn, int, list, param, real, scan, table, text } from '../src/index.js';

export interface Scenario {
  readonly name: string;
  run(db: SmaltDb): Promise<unknown>;
}

const orders = table('orders', { id: int().primaryKey(), customer: text().notNull(), total: real(), paid: bool(), day: date(), tags: list(text()) });
const customers = table('customers', { name: text().primaryKey(), region: text() });
const ROWS = [
  { id: 1, customer: 'ann', total: 120.5, paid: true, day: new Date('2026-11-01T00:00:00Z'), tags: ['a', 'b'] },
  { id: 2, customer: 'bob', total: 80, paid: false, day: new Date('2026-11-02T00:00:00Z'), tags: [] },
  { id: 3, customer: 'ann', total: 40, paid: true, day: null, tags: ['c'] },
];

async function seeded(db: SmaltDb): Promise<void> {
  await db.migrate({ tables: [orders, customers] });
  await db.load(orders, ROWS);
  await db.load(customers, [{ name: 'ann', region: 'north' }, { name: 'bob', region: 'south' }]);
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'specs, migrate and load: every value type round-trips (milestones 1, 2)',
    async run(db) {
      await seeded(db);
      return db.rows(scan(orders).sort('id'));
    },
  },
  {
    name: 'relations: a join, an aggregate, a window and a parameter (milestone 5)',
    async run(db) {
      await seeded(db);
      const byRegion = scan(orders)
        .join(scan(customers), (o, c) => o.customer.eq(c.name))
        .aggregate((r) => ({ region: r.region }), (r) => ({ n: agg.count(), total: agg.sum(r.total) }))
        .sort('region');
      const ranked = scan(orders).window((r) => ({ rank: agg.row_number() }), { partition: ['customer'], order: ['id'] }).pick('id', 'rank').sort('id');
      const over = scan(orders).filter((r) => r.total.gt(param.real('min'))).pick('id').sort('id');
      return [await db.rows(byRegion), await db.rows(ranked), await db.rows(over, { min: 50 }), await db.rows(scan(orders).explode('tags').pick('id', 'tags').sort('id', 'tags'))];
    },
  },
  {
    name: 'change sets: a rebuild that changes a type, applied once (milestone 3)',
    async run(db) {
      await seeded(db);
      const wider = table('orders', { id: int().primaryKey(), customer: text().notNull(), total: text(), paid: bool(), day: date(), tags: list(text()) });
      const changes = await db.diff({ tables: [wider, customers] });
      await db.apply(changes);
      return [changes.steps.map((s) => `${s.action} ${s.object} ${s.dataLoss}`), await db.rows(scan(wider).pick('id', 'total').sort('id')), (await db.diff({ tables: [wider, customers] })).steps.length];
    },
  },
  {
    name: 'views keep their interfaces through a rename (milestone 6)',
    async run(db) {
      await seeded(db);
      await db.createView('big', scan(orders).filter((r) => r.total.gt(50)).pick('id', 'customer'));
      await db.createView('over_big', scan('big').pick('customer'));
      const renamed = table('orders', { id: int().primaryKey(), buyer: text().notNull().renamedFrom('customer'), total: real(), paid: bool(), day: date(), tags: list(text()) });
      await db.migrate({ tables: [renamed, customers] });
      const cat = await db.catalog({ fresh: true });
      return [await db.rows(scan('big').sort('id')), await db.rows(scan('over_big').sort('customer')), cat.views.map((v) => [v.name, v.interface?.map((c) => c.name)])];
    },
  },
  {
    name: 'a change set that would break a view is refused (milestone 6)',
    async run(db) {
      await seeded(db);
      await db.createView('v', scan(orders).pick('id', 'paid'));
      const dropped = table('orders', { id: int().primaryKey(), customer: text().notNull(), total: real(), day: date(), tags: list(text()) });
      const changes = await db.diff({ tables: [dropped, customers] }, { allowDataLoss: 'certain' });
      return changes.diagnostics.filter((d) => d.level === 'error').map((d) => d.object);
    },
  },
  {
    name: 'transactions: a failure rolls back every write (milestone 2)',
    async run(db) {
      await seeded(db);
      const failed = await db
        .transaction(async (tx) => {
          await tx.deleteWhere(orders, (r) => r.id.eq(1));
          throw new Error('stop');
        })
        .then(() => 'committed', (e: Error) => e.message);
      await db.updateWhere(orders, (r) => ({ total: fn.mul(r.total, 2) }), (r) => r.id.eq(2));
      return [failed, await db.rows(scan(orders).pick('id', 'total').sort('id'))];
    },
  },
  {
    name: 'the catalog reads the database back as specs (milestone 1)',
    async run(db) {
      await seeded(db);
      const cat = await db.catalog({ fresh: true });
      return cat.tables.map((t) => [t.name, t.columns.map((c) => `${c.name} ${c.type}${c.notNull ? ' not null' : ''}`), t.primaryKey]);
    },
  },
];
