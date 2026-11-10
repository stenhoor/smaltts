/**
 * Engine findings (docs/DESIGN.md section 11), pinned against the raw plan API: each `test.fails` passes while the
 * engine still has the bug, and fails (so it must become a plain test) once smaltdb fixes it.
 */
import { expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import * as P from 'smaltdb/plan';

function dbWith(column: P.ColumnDef): Database {
  const db = Database.openMemory();
  db.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: { name: 't', storage: 'row', columns: [column], keys: [], checks: [], foreignKeys: [] } } });
  return db;
}
const columnOf = (type: P.StorageType): P.ColumnDef => ({ name: 'v', declaredType: type, type, notNull: false, collation: 'binary' });

// F2: values from columns read text in the result format for date, time and datetime, but not for duration
// (ADR 0019 §5: "text in the result format parses"). 'PT1H30M' is how the engine gives a duration back.
test.fails('F2: a duration given as its result text goes in', () => {
  const db = dbWith(columnOf('DURATION'));
  db.queryPlan({ kind: 'write', plan: P.append('t', P.fromColumns([['PT1H30M']], ['duration']), [0]) });
  expect(db.queryPlan(P.scan('t', [0])).rows).toEqual([['PT1H30M']]);
});

// F3: a JS Date in a date column of values is taken as a datetime (µs since the epoch) instead of its day, so the
// day it stores is millions of years away.
test.fails('F3: a Date in a date column is stored as its day', () => {
  const db = dbWith(columnOf('DATE'));
  db.queryPlan({ kind: 'write', plan: P.append('t', P.fromColumns([[new Date('2026-11-10T00:00:00Z')]], ['date']), [0]) });
  expect(db.queryPlan(P.scan('t', [0])).rows).toEqual([['2026-11-10']]);
});
