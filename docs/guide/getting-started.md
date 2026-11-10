# Getting started

::: warning Planned
smaltts is not on npm yet, and its API may change. The design and a prototype are in the
[repository](https://github.com/stenhoor/smaltts); this page shows what the prototype does today. Try it, break it,
tell us.
:::

The package will be `@smaltworks/smaltts` (not published yet). To try the prototype, clone the repository:

```bash
npm ci && npm run deps   # dependencies, then the pinned smaltdb build
npm run check            # the tests
```

## A first database

```ts
import { Database } from 'smaltdb/engine';
import { attach, describe, int, real, scan, table, agg } from '@smaltworks/smaltts';
import { registerSmaltts } from '@smaltworks/smaltts/language';

registerSmaltts();
const db = attach(Database.openMemory());

// A table, declared in code: its row type comes with it.
const orders = table('orders', {
  id: int().primaryKey(),
  customerId: int().notNull().indexed(),
  total: real().notNull(),
});

// What it would take to have it: a change set, as data. Nothing runs yet.
const changes = await db.diff({ tables: [orders] });
console.log(describe(changes));
await db.apply(changes);

// Rows in, and a typed plan over them.
await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 1, total: 30 }]);
const totals = scan(orders).aggregate((o) => ({ customerId: o.customerId }), (o) => ({ total: agg.sum(o.total) }));
console.log(await db.rows(totals)); // [{ customerId: 1, total: 40 }]
```

Next: the [API reference](../REFERENCE), the [design](../DESIGN) and its [milestones](../MILESTONES).
