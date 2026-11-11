/**
 * Specs as the engine's definitions (`TableDef`, `ColumnDef`, `IndexDef`): what `diff` and the loads hand the engine.
 * CHECKs and computed defaults are compiled from their named expressions to plan expressions over the row (column `i`
 * is `col(0, i)`), and keep their expression's JSON as their text, which the catalog reader parses back.
 */
import { LANGUAGE } from './source.js';
import type * as plan from 'smaltdb/plan';
import type { ExprNode } from './expr.js';
import { type Field, expr } from './rel.js';
import { type ColumnSpec, type IndexSpec, type KeySpec, type TableSpec, type Value, columnIndex, columnPlanType } from './spec.js';

const litType = (v: Value): plan.PlanType => (v === null ? 'null' : typeof v === 'string' ? 'text' : v instanceof Uint8Array ? 'blob' : typeof v === 'bigint' || Number.isInteger(v) ? 'int' : 'real');
const literalText = (v: Value): string => (v === null ? 'NULL' : typeof v === 'string' ? JSON.stringify(v) : v instanceof Uint8Array ? `blob(${v.length})` : String(v));

/** An expression over the given fields, compiled; it may read no parameters. */
function compileOver(node: ExprNode, fields: readonly Field[], what: string): plan.PlanExpr {
  const params: string[] = [];
  const e = expr(node, [fields], params).e;
  if (params.length) throw new Error(`${what} cannot read parameters`);
  return e;
}

/** A table's columns as the fields its expressions read. */
const rowFields = (spec: TableSpec<any>): Field[] => spec.columns.map((c) => ({ name: c.name, type: columnPlanType(c), collation: c.collation ?? 'binary' }));

export function toColumnDef(c: ColumnSpec): plan.ColumnDef {
  const def: plan.DefaultDef | undefined =
    c.defaultExpr !== undefined
      ? { text: JSON.stringify(c.defaultExpr), expr: compileOver(c.defaultExpr, [], `the default of ${c.name}`), value: null }
      : c.default !== undefined
        ? { text: literalText(c.default), expr: { k: 'lit', value: c.default, type: litType(c.default) }, value: c.default }
        : undefined;
  return {
    name: c.name,
    declaredType: c.planType ?? c.type,
    type: c.type,
    notNull: c.notNull ?? false,
    collation: c.collation ?? 'binary',
    ...(def ? { default: def } : {}),
  };
}

/** The engine's `TableDef` for a spec. */
export function toTableDef(spec: TableSpec<any>): plan.TableDef {
  const key = (k: KeySpec, kind: 'primaryKey' | 'unique'): plan.KeyDef => ({
    kind,
    columns: k.columns.map((c) => ({ column: columnIndex(spec, c), desc: false, collation: spec.columns[columnIndex(spec, c)]!.collation ?? 'binary' })),
    ...(k.name ? { name: k.name } : {}),
  });
  const fields = rowFields(spec);
  return {
    name: spec.name,
    storage: spec.storage ?? 'row',
    // Its CHECK texts are smaltts expressions: the smaltts language edits them on a rename (smaltdb#190).
    exprLanguage: LANGUAGE,
    columns: spec.columns.map(toColumnDef),
    keys: [...(spec.primaryKey ? [key(spec.primaryKey, 'primaryKey')] : []), ...(spec.unique ?? []).map((u) => key(u, 'unique'))],
    checks: (spec.checks ?? []).map((k) => ({ ...(k.name ? { name: k.name } : {}), text: JSON.stringify(k.expr), expr: compileOver(k.expr, fields, `a CHECK of ${spec.name}`) })),
    foreignKeys: (spec.foreignKeys ?? []).map((f) => ({
      ...(f.name ? { name: f.name } : {}),
      columns: f.columns.map((c) => columnIndex(spec, c)),
      table: f.table,
      ...(f.refColumns ? { refColumns: f.refColumns } : {}),
      onDelete: f.onDelete ?? 'NO ACTION',
      onUpdate: f.onUpdate ?? 'NO ACTION',
      deferrable: false,
      isDeferrable: false,
    })),
  };
}

/** The engine's `IndexDef` for an index of a spec. */
export function toIndexDef(spec: TableSpec<any>, index: IndexSpec): plan.IndexDef {
  return {
    name: index.name,
    table: spec.name,
    unique: index.unique ?? false,
    columns: index.columns.map((c) => {
      const i = columnIndex(spec, c.column);
      return { column: i, desc: c.desc ?? false, collation: c.collation ?? spec.columns[i]!.collation ?? 'binary' };
    }),
  };
}
