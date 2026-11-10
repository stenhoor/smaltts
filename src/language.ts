/**
 * smaltts as a language of the engine (smaltdb ADRs 0015 and 0016 §6), for the objects it stores with source text:
 * its views. Tables and indexes are defined without source text, so ALTER TABLE changes their definitions without
 * asking any language.
 *
 * The engine keeps a view as its language's source and asks that language to bind it where it is read, and to edit it
 * when ALTER TABLE renames a table or a column it reads. A smaltts view's source is its relation's JSON, so editing it
 * is editing data, never text.
 *
 * `registerSmaltts()` must run wherever the engine runs (in-process, or in the worker entry: `defineWorker({ languages:
 * [smalttsLanguage] })`) before smaltts views are read or the tables they read are altered.
 */
import type { BindContext, CatalogTable, SmaltLanguage } from 'smaltdb/language';
import { collationByName, registerLanguage } from 'smaltdb/language';
import * as P from 'smaltdb/plan';
import { specOfCatalogTable } from './catalog.js';
import { type RelNode, compileRel } from './rel.js';
import { renameColumnIn, renameTableIn, tablesOf } from './views.js';
import { LANGUAGE, type ViewSource } from './source.js';

export { LANGUAGE, type ViewSource } from './source.js';

type Json = Record<string, unknown>;
const parse = (text: string): Json => JSON.parse(text) as Json;

/** A smaltts view of the catalog, as its relation (inlined where it is read). */
function viewOf(ctx: BindContext, name: string): RelNode | undefined {
  const v = ctx.getView?.(name);
  if (!v || v.source.language !== LANGUAGE) return undefined;
  return (parse(v.source.text) as unknown as ViewSource).rel;
}

/** A view source with its relation edited, or the text unchanged when it is not a smaltts view. */
function editView(text: string, f: (rel: RelNode) => RelNode): string {
  const o = parse(text);
  if (o.kind !== 'view') return text;
  return JSON.stringify({ ...o, rel: f(o.rel as RelNode) });
}

const unchanged = (text: string): string => text;

export const smalttsLanguage: SmaltLanguage = {
  name: LANGUAGE,
  bindView(source, ctx) {
    const view = parse(source.text) as unknown as ViewSource;
    const compiled = compileRel(view.rel, {
      table: (name) => {
        const t: CatalogTable | undefined = ctx.table(name);
        return t ? specOfCatalogTable(t) : undefined;
      },
      view: (name) => viewOf(ctx, name),
      resultType: (name, args) => ctx.catalog.resultType(name, args),
    });
    if (compiled.params.length) throw new Error('a view cannot have parameters');
    // The engine reads a view's plan in the shape its planner takes: a projection on top.
    const top = compiled.plan.op === 'project' ? compiled.plan : P.project(compiled.plan, compiled.fields.map((f, i) => P.col(0, i, f.type, f.collation)));
    return {
      kind: 'query',
      plan: top,
      columns: compiled.fields.map((f) => ({ name: f.name, type: f.type, collation: collationByName(f.collation)!, affinity: 'NONE' as const })),
    };
  },
  viewReferences(source) {
    return tablesOf((parse(source.text) as unknown as ViewSource).rel).map((name) => ({ name }));
  },
  viewDefinition: (source) => JSON.stringify((parse(source.text) as unknown as ViewSource).rel),
  sourceEditor: {
    renameTable: (text, oldName, newName) => editView(text, (rel) => renameTableIn(rel, oldName, newName)),
    renameColumn: (text, table, oldName, newName) => editView(text, (rel) => renameColumnIn(rel, table, oldName, newName)),
    renameColumnInExpr: unchanged,
    // smaltts defines tables without source text, so these never reach a smaltts source.
    addColumn: unchanged,
    dropColumn: unchanged,
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
