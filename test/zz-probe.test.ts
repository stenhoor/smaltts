import { test } from 'vitest';
import { Database } from 'smaltdb/engine';
import * as P from 'smaltdb/plan';
test('raw update', async () => {
  for (const third of [null, 1]) {
    const db = Database.openMemory();
    const c = (name: string, type: string) => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
    db.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: { name: 't', storage: 'row', columns: [c('id', 'INTEGER'), c('total', 'REAL'), c('paid', 'BOOLEAN')], keys: [], checks: [], foreignKeys: [] } } } as never);
    db.queryPlan({ kind: 'write', plan: P.append('t', P.fromColumns([[2], [80], [third]], ['int', 'real', 'bool']), [0, 1, 2]) } as never);
    const input = P.filter(P.scan('t', [-1, 0, 1, 2]), P.call('cmp_eq', [P.col(0, 1, 'int'), P.lit(2)], 'bool'));
    db.queryPlan({ kind: 'write', plan: P.update('t', input, 0, [{ column: 1, value: P.call('mul', [P.col(0, 2, 'real'), P.lit(2)], 'num') }]) } as never);
    console.log('third', third, JSON.stringify(db.queryPlan(P.scan('t', [0, 1, 2])).rows));
  }
});
