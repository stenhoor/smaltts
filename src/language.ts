/**
 * smaltts as a language of the engine (smaltdb ADR 0015).
 *
 * The engine keeps every object's source in the language that made it and asks that language for what it needs: to
 * bind a view where it is read, and to edit a source when ALTER TABLE renames or adds or drops a column. A smaltts
 * source is JSON: a table's or index's spec, or a view's relation IR (`RelNode`). Editing it is editing data, so it
 * never goes stale and never needs a parser.
 *
 * `registerSmaltts()` must run wherever the engine runs (in-process, or in the worker entry: `defineWorker({ languages:
 * [smalttsLanguage] })`) before smaltts objects are altered or smaltts views are read.
 */
import type { BindContext, SmaltLanguage } from 'smaltdb/language';
import { collationByName, collationName, registerLanguage } from 'smaltdb/language';
import * as P from 'smaltdb/plan';
import { type RelNode, type ExprNode, compileRel } from './rel.js';
import type { Collation, StorageType, TableSpec } from './spec.js';

export const LANGUAGE = 'smaltts';

/** A view's source: its relation and, optionally, its column names. */
export interface ViewSource {
  readonly kind: 'view';
  readonly rel: RelNode;
}

type Json = Record<string, unknown>;
const parse = (text: string): Json => JSON.parse(text) as Json;
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** A table of the catalog, as a spec (enough to compile against: names, types, collations). */
function specOf(ctx: BindContext, name: string): TableSpec | undefined {
  const t = ctx.getTable(name);
  if (!t) return undefined;
  return {
    kind: 'table',
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type as StorageType, notNull: c.notNull, collation: collationName(c.collation) as Collation })),
  };
}

/** A smaltts view of the catalog, as its relation (inlined where it is read). */
function viewOf(ctx: BindContext, name: string): RelNode | undefined {
  const v = ctx.getView?.(name);
  if (!v || v.source.language !== LANGUAGE) return undefined;
  return (parse(v.source.text) as unknown as ViewSource).rel;
}

function walkRel(n: RelNode, f: (n: RelNode) => void): void {
  f(n);
  if ('input' in n) walkRel(n.input, f);
  if (n.r === 'join') {
    walkRel(n.left, f);
    walkRel(n.right, f);
  }
  if (n.r === 'union') n.inputs.forEach((i) => walkRel(i, f));
}

/** Rename references in a view's relation (table names in scans; column names everywhere they appear). */
function mapRel(n: RelNode, table: (name: string) => string, column: (name: string) => string): RelNode {
  const e = (x: ExprNode): ExprNode => (x.k === 'col' ? { ...x, name: column(x.name) } : x.k === 'op' || x.k === 'agg' ? { ...x, args: x.args.map(e) } : x);
  const r = (x: RelNode): RelNode => mapRel(x, table, column);
  switch (n.r) {
    case 'scan':
      return { ...n, table: table(n.table) };
    case 'values':
    case 'function':
      return n;
    case 'filter':
      return { ...n, input: r(n.input), pred: e(n.pred) };
    case 'select':
      return { ...n, input: r(n.input), fields: n.fields.map(([k, v]) => [k, e(v)] as const) };
    case 'join':
      return { ...n, left: r(n.left), right: r(n.right), ...(n.on ? { on: e(n.on) } : {}) };
    case 'aggregate':
      return { ...n, input: r(n.input), keys: n.keys.map(([k, v]) => [k, e(v)] as const), aggs: n.aggs.map(([k, v]) => [k, e(v)] as const) };
    case 'sort':
      return { ...n, input: r(n.input), keys: n.keys.map((k) => ({ ...k, expr: e(k.expr) })) };
    case 'limit':
    case 'distinct':
      return { ...n, input: r(n.input) };
    case 'union':
      return { ...n, inputs: [r(n.inputs[0]), r(n.inputs[1])] };
  }
}

export const smalttsLanguage: SmaltLanguage = {
  name: LANGUAGE,
  parse() {
    throw new Error('smaltts statements are plans: run them with queryPlan');
  },
  parseOne() {
    throw new Error('smaltts statements are plans: run them with queryPlan');
  },
  bindStoredExprs: (table) => ({ checks: [], defaults: table.columns.map(() => null) }),
  bindView(source, ctx) {
    const view = parse(source.text) as unknown as ViewSource;
    const compiled = compileRel(view.rel, { table: (name) => specOf(ctx, name), view: (name) => viewOf(ctx, name) });
    if (compiled.params.length) throw new Error('a view cannot have parameters');
    // The engine reads a view's plan in the shape its planner takes: a projection on top.
    const top = compiled.plan.op === 'project' ? compiled.plan : P.project(compiled.plan, compiled.fields.map((f, i) => P.col(0, i, f.type, f.collation)));
    return {
      kind: 'query',
      plan: top,
      columns: compiled.fields.map((f) => ({ name: f.name, type: f.type, collation: collationByName(f.collation)!, affinity: 'NONE' })),
    };
  },
  viewReferences(source) {
    const refs: { name: string }[] = [];
    walkRel((parse(source.text) as unknown as ViewSource).rel, (n) => {
      if (n.r === 'scan') refs.push({ name: n.table });
    });
    return refs;
  },
  viewDefinition: (source) => JSON.stringify((parse(source.text) as unknown as ViewSource).rel),
  sourceEditor: {
    renameTable(text, oldName, newName) {
      const o = parse(text);
      if (o.kind === 'view') return JSON.stringify({ ...o, rel: mapRel(o.rel as RelNode, (t) => (same(t, oldName) ? newName : t), (c) => c) });
      const out: Json = { ...o };
      if (same(o.name, oldName) && o.kind === 'table') out.name = newName;
      if (same(o.table, oldName)) out.table = newName;
      if (Array.isArray(o.foreignKeys)) out.foreignKeys = (o.foreignKeys as Json[]).map((f) => (same(f.table, oldName) ? { ...f, table: newName } : f));
      return JSON.stringify(out);
    },
    renameColumn(text, table, oldName, newName) {
      const o = parse(text);
      const ren = (c: unknown) => (same(c, oldName) ? newName : c);
      if (o.kind === 'view') return JSON.stringify({ ...o, rel: mapRel(o.rel as RelNode, (t) => t, (c) => (same(c, oldName) ? newName : c)) });
      if (o.kind === 'table' && same(o.name, table)) {
        const keyOf = (k: Json) => ({ ...k, columns: (k.columns as unknown[]).map(ren) });
        return JSON.stringify({
          ...o,
          columns: (o.columns as Json[]).map((c) => (same(c.name, oldName) ? { ...c, name: newName } : c)),
          ...(o.primaryKey ? { primaryKey: keyOf(o.primaryKey as Json) } : {}),
          ...(o.unique ? { unique: (o.unique as Json[]).map(keyOf) } : {}),
          ...(o.indexes ? { indexes: (o.indexes as Json[]).map((ix) => ({ ...ix, columns: (ix.columns as Json[]).map((c) => ({ ...c, column: ren(c.column) })) })) } : {}),
        });
      }
      if (Array.isArray(o.columns) && o.kind === undefined) {
        // An index spec.
        return JSON.stringify({ ...o, columns: (o.columns as Json[]).map((c) => ({ ...c, column: ren(c.column) })) });
      }
      return text;
    },
    renameColumnInExpr: (text) => text,
    addColumn(tableText, columnText) {
      const o = parse(tableText);
      return JSON.stringify({ ...o, columns: [...(o.columns as Json[]), parse(columnText)] });
    },
    dropColumn(tableText, column) {
      const o = parse(tableText);
      return JSON.stringify({ ...o, columns: (o.columns as Json[]).filter((_, i) => i !== column) });
    },
    externalTable: (name, columns, options) => JSON.stringify({ kind: 'externalTable', name, columns, options }),
  },
};

let registered = false;
/** Register smaltts with the engine (once; later calls do nothing). */
export function registerSmaltts(): void {
  if (registered) return;
  registerLanguage(smalttsLanguage);
  registered = true;
}
