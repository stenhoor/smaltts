# smaltts

**The database-first, plan-first TypeScript API for [smaltdb](https://github.com/stenhoor/smaltdb).**

smaltts is for the people who build toolchains and data pipelines on smaltdb: code that creates, reshapes, indexes,
fills and checks databases. Schemas are values you can write in TypeScript or build at run time, read back from a
database, compare and apply as reviewable change sets. Plans are values too: relations by column name, compiled to
the engine's plan format. There is no SQL in it and no dataframes: SQL is [smaltql](https://github.com/stenhoor/smaltql),
dataframes are [smaltdf](https://github.com/stenhoor/smaltdf), and pipelines will be
[smaltfl](https://github.com/stenhoor/smaltfl), built on smaltts.

> **Status: design and prototype.** Read [docs/DESIGN.md](docs/DESIGN.md) (the design, engine findings and open
> questions) and [docs/research](docs/research/README.md) (the surveys behind it). Not on npm.

```ts
import { Database } from 'smaltdb/engine';
import { attach, registerSmaltts, table, int, real, text, scan, agg, describe } from '@smaltworks/smaltts';

registerSmaltts();
const db = attach(Database.openMemory());

const orders = table('orders', { id: int().primaryKey(), customerId: int().notNull().indexed(), total: real().notNull() });

const changes = await db.diff({ tables: [orders] });   // what it would take: data, nothing runs
console.log(describe(changes));                       // steps, impact, data loss
await db.apply(changes);                              // one transaction, recorded with its checksum

await db.load(orders, [{ customerId: 1, total: 10 }, { customerId: 1, total: 30 }]);
const totals = scan(orders).aggregate((o) => ({ customerId: o.customerId }), (o) => ({ total: agg.sum(o.total) }));
await db.createView('order_totals', totals, { materialized: true, storage: 'columnar' });
console.log(String(await db.explain(totals, { analyze: true })));
```

## Development

Requires Node 20+.

```bash
npm ci && npm run deps   # dependencies, then the smaltdb build pinned in packed.json
npm run check            # typecheck + tests
```

## License

[MIT](LICENSE)
