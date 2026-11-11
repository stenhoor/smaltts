/**
 * Change sets: the difference between what a database has and what a toolchain wants, as reviewable data.
 *
 * `diff(current, desired)` returns a `ChangeSet`: ordered steps, each with the engine statements it runs, its impact
 * (how much work and disruption it costs) and what it may lose. Nothing runs until `apply`, which checks the change
 * set against a policy, runs every step in one transaction, and records it in the history table. A change set is
 * JSON: it can be reviewed, stored, approved, and applied later or elsewhere.
 *
 * What the engine cannot change in place (a column's type, nullability, default or collation, keys, storage) becomes
 * a REBUILD step, built from plans: create the new table, copy the rows with an `append` plan, drop the old table,
 * rename the new one, recreate the indexes.
 */
import type * as plan from 'smaltdb/plan';
import type { PlanStatementInput } from 'smaltdb/plan';
import * as P from 'smaltdb/plan';
import type { Backend } from './backend.js';
import { type Catalog, type CatalogViewInfo, readCatalog } from './catalog.js';
import { conversion } from './conversions.js';
import { toColumnDef, toIndexDef, toTableDef } from './ddl.js';
import { type Field, type RelNode, compileRel } from './rel.js';
import { LANGUAGE, type ViewSource } from './source.js';
import type { ConnectionSpec, ExternalTableSpec } from './plugins.js';
import { type CheckSpec, type ColumnSpec, type ForeignKeySpec, type IndexSpec, type SchemaSpec, type TableSpec, type Value, columnIndex, columnPlanType } from './spec.js';
import { renameColumnIn, renameTableIn } from './views.js';

/** How much a step costs and disrupts, from least to most. */
export type Impact = 'metadata' | 'instant' | 'build' | 'rewrite';
const IMPACTS: readonly Impact[] = ['metadata', 'instant', 'build', 'rewrite'];
/** What a step may lose: rows or values that do not survive it. */
export type DataLoss = 'none' | 'possible' | 'certain';
const LOSSES: readonly DataLoss[] = ['none', 'possible', 'certain'];

export interface Step {
  readonly action:
    | 'createTable' | 'dropTable' | 'renameTable' | 'addColumn' | 'dropColumn' | 'renameColumn' | 'rebuildTable' | 'createIndex' | 'dropIndex' | 'replaceView'
    | 'createConnection' | 'dropConnection' | 'replaceConnection' | 'createExternalTable' | 'dropExternalTable' | 'replaceExternalTable';
  /** The object the step changes. */
  readonly object: string;
  readonly impact: Impact;
  readonly dataLoss: DataLoss;
  /** Why the step is needed, for review. */
  readonly reason: string;
  /** The engine statements the step runs, in order. */
  readonly statements: readonly PlanStatementInput[];
}

export interface Diagnostic {
  readonly level: 'error' | 'warning' | 'info';
  readonly object: string;
  readonly message: string;
}

export interface ChangeSet {
  readonly steps: readonly Step[];
  readonly diagnostics: readonly Diagnostic[];
  /** The highest impact and data loss of any step. */
  readonly impact: Impact;
  readonly dataLoss: DataLoss;
  /** A checksum of the steps, recorded in the history table when applied. */
  readonly checksum: string;
}

export interface DiffOptions {
  /** Drop tables the database has and the desired schema does not. Default false: they are reported, not dropped. */
  readonly prune?: boolean;
}

/** The table smaltts records applied change sets in. */
export const HISTORY_TABLE = 'smaltts_history';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const findTable = (tables: readonly TableSpec<any>[], name: string) => tables.find((t) => same(t.name, name));

/** Compare a database (or its catalog) with the desired schema. */
export async function diff(current: Backend | Catalog, desired: SchemaSpec, options: DiffOptions = {}): Promise<ChangeSet> {
  const catalog = 'run' in current ? await readCatalog(current) : current;
  return diffCatalog(catalog.tables.filter((t) => !same(t.name, HISTORY_TABLE)), desired, options, catalog);
}

/** What the differ reads of the database's views: the catalog's. */
export type ViewsOf = Pick<Catalog, 'views' | 'table' | 'resultType'> & Partial<Pick<Catalog, 'connections' | 'externals'>>;

/**
 * `diff` on specs alone, with no database. With `views` (a catalog's), each view that reads a changed table is checked
 * against the change set (DESIGN.md section 8): a view the change breaks is an error, an interface's type change a
 * warning or an error, a reflecting view's new shape a note, and a view the engine won't edit a `replaceView` step.
 */
export function diffCatalog(have: readonly TableSpec<any>[], desired: SchemaSpec, options: DiffOptions = {}, views?: ViewsOf): ChangeSet {
  const steps: Step[] = [];
  const diagnostics: Diagnostic[] = [];
  const claimed = new Set<string>();

  for (const want of desired.tables) {
    let old = findTable(have, want.name);
    if (!old && want.renamedFrom) {
      old = findTable(have, want.renamedFrom);
      if (old) {
        steps.push({ action: 'renameTable', object: want.name, impact: 'metadata', dataLoss: 'none', reason: `renamed from ${old.name}`, statements: [{ kind: 'schema', op: { op: 'alterTable', table: old.name, action: { kind: 'renameTable', newName: want.name } } }] });
      }
    }
    if (!old) {
      steps.push(...createTableSteps(want, `${want.name} is not in the database`));
      continue;
    }
    claimed.add(old.name.toLowerCase());
    steps.push(...tableSteps(old, want, diagnostics));
  }

  for (const t of have) {
    if (claimed.has(t.name.toLowerCase()) || findTable(desired.tables, t.name)) continue;
    if (options.prune) {
      steps.push({ action: 'dropTable', object: t.name, impact: 'metadata', dataLoss: 'certain', reason: `${t.name} is not in the desired schema`, statements: [{ kind: 'schema', op: { op: 'drop', objectType: 'table', name: t.name, ifExists: false } }] });
    } else {
      diagnostics.push({ level: 'info', object: t.name, message: 'in the database but not in the desired schema: left alone (diff with prune to drop it)' });
    }
  }

  if (views) steps.push(...viewSteps(views, have, desired, options, steps, diagnostics));
  steps.push(...externalSteps(views?.connections ?? [], views?.externals ?? [], desired, options, diagnostics));

  const order: Step['action'][] = ['dropExternalTable', 'dropConnection', 'createConnection', 'replaceConnection', 'replaceExternalTable', 'createExternalTable', 'renameTable', 'dropIndex', 'renameColumn', 'dropColumn', 'addColumn', 'rebuildTable', 'createTable', 'createIndex', 'dropTable', 'replaceView'];
  steps.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  for (const s of steps) {
    if (s.dataLoss === 'certain') diagnostics.push({ level: 'warning', object: s.object, message: `${s.action} loses data: ${s.reason}` });
  }
  return finish(steps, diagnostics);
}

// ---------------------------------------------------------------------------------------------------------------
// Views over changed tables (DESIGN.md section 8).

/** How a desired table continues one in the database: its old name and its columns' renames (old to new). */
interface Continued {
  readonly old: TableSpec<any>;
  readonly want: TableSpec<any>;
  readonly renames: readonly (readonly [string, string])[];
  readonly rebuilt: boolean;
}

function viewSteps(views: ViewsOf, have: readonly TableSpec<any>[], desired: SchemaSpec, options: DiffOptions, steps: readonly Step[], diagnostics: Diagnostic[]): Step[] {
  const continued: Continued[] = [];
  const claimed = new Set<string>();
  for (const want of desired.tables) {
    const old = findTable(have, want.name) ?? (want.renamedFrom ? findTable(have, want.renamedFrom) : undefined);
    if (!old) continue;
    claimed.add(old.name.toLowerCase());
    const renames = want.columns.flatMap((c) => {
      if (old.columns.some((o) => same(o.name, c.name))) return [];
      const prev = c.renamedFrom ? old.columns.find((o) => same(o.name, c.renamedFrom!)) : undefined;
      return prev ? [[prev.name, c.name] as const] : [];
    });
    continued.push({ old, want, renames, rebuilt: steps.some((s) => s.action === 'rebuildTable' && same(s.object, want.name)) });
  }
  // The tables after the change set: the desired ones, and those it leaves alone.
  const after = [...desired.tables, ...(options.prune ? [] : have.filter((t) => !claimed.has(t.name.toLowerCase()) && !findTable(desired.tables, t.name)))];

  /** A view's relation as the engine leaves it (renames in place), and as it should read (every rename). */
  const edited = (rel: RelNode, all: boolean): RelNode => {
    let r = rel;
    for (const c of continued) if (!same(c.old.name, c.want.name)) r = renameTableIn(r, c.old.name, c.want.name);
    for (const c of continued) if (all || !c.rebuilt) for (const [from, to] of c.renames) r = renameColumnIn(r, c.want.name, from, to);
    return r;
  };

  const ours = views.views.filter((v) => v.language === LANGUAGE);
  const sources = new Map(ours.map((v) => [v.name.toLowerCase(), JSON.parse(v.definition) as ViewSource]));
  const before = (name: string) => sources.get(name.toLowerCase())?.rel;
  const now = (name: string) => {
    const rel = before(name);
    return rel && edited(rel, true);
  };
  const interfaceOf = (n: string) => views.views.find((v) => same(v.name, n))?.interface;
  const compileWith = (rel: RelNode, tables: readonly TableSpec<any>[], view: (n: string) => RelNode | undefined): Field[] =>
    [...compileRel(rel, { table: (n) => findTable(tables, n) ?? (findTable(have, n) ? undefined : views.table(n)), view, viewInterface: interfaceOf, ...(views.resultType ? { resultType: views.resultType } : {}) }).fields];

  const out: Step[] = [];
  for (const v of ours) {
    const source = sources.get(v.name.toLowerCase())!;
    let old: Field[];
    try {
      old = compileWith(source.rel, have, before);
    } catch {
      continue; // already broken: nothing this change set does to it
    }
    const rel = edited(source.rel, true);
    let fields: Field[];
    try {
      fields = compileWith(rel, after, now);
    } catch (e) {
      diagnostics.push({ level: 'error', object: v.name, message: `the change set breaks this view: ${(e as Error).message}` });
      continue;
    }
    const shape = (fs: readonly Field[]) => fs.map((f) => `${f.name} ${f.type}`).join(', ');
    let rewrite = JSON.stringify(rel) !== JSON.stringify(edited(source.rel, false));
    if (v.interface) {
      // The engine holds the view's interface (smaltdb ADR 0027): smaltts refuses what would break it, as the engine
      // would, rather than dropping the view (the owner's decision). A lossless type change is converted by the engine.
      const iface = v.interface;
      if (fields.length < iface.length || (fields.length > iface.length && source.columns)) {
        diagnostics.push({ level: 'error', object: v.name, message: `the change set breaks this view's interface: it would give ${fields.length} columns, not ${iface.length}` });
        continue;
      }
      if (fields.length > iface.length) diagnostics.push({ level: 'info', object: v.name, message: `the view keeps its columns (${iface.map((c) => c.name).join(', ')}): the new ones don't reach it` });
      for (const [i, want] of iface.entries()) {
        const f = fields[i]!;
        if (f.type === want.type) continue;
        if (P.isLossless(f.type, want.type)) diagnostics.push({ level: 'info', object: `${v.name}.${want.name}`, message: `the column becomes ${f.type}: the engine converts it to the interface's ${want.type}` });
        else diagnostics.push({ level: 'error', object: `${v.name}.${want.name}`, message: `the interface's column becomes ${f.type}, which doesn't convert losslessly to its ${want.type}: change the view in the same change set` });
      }
    } else if (source.columns) {
      // An interface view made before the engine held interfaces: its names and order hold by construction; a type
      // change must convert losslessly to the old type.
      for (const [i, f] of fields.entries()) {
        const was = old[i]!;
        if (was.type === f.type) continue;
        if (!P.isLossless(f.type, was.type)) diagnostics.push({ level: 'error', object: `${v.name}.${f.name}`, message: `the interface's column becomes ${f.type}, which doesn't convert losslessly to its ${was.type}: change the view in the same change set` });
        else diagnostics.push({ level: 'warning', object: `${v.name}.${f.name}`, message: `the interface's column becomes ${f.type} (lossless to its ${was.type}); the engine holds no interface for this view, made before it did` });
      }
    } else if (shape(old) !== shape(fields)) {
      diagnostics.push({ level: 'info', object: v.name, message: `the view's columns follow the change: (${shape(old)}) → (${shape(fields)})` });
      // A materialized view stores its columns: it is recreated and filled again.
      if (v.materialized) rewrite = true;
    }
    if (rewrite) out.push(replaceViewStep(v, { ...source, rel }, v.materialized ? 'its stored columns change' : 'it reads a column a rebuild renames'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Connections and external tables (milestone 9): created, dropped (with prune) or made again when they change. Their
// data is outside the database, so no step loses any.

/** Options compared by name (any case) and value. */
function sameOptions(a: Readonly<Record<string, Value>>, b: Readonly<Record<string, Value>>): boolean {
  const norm = (o: Readonly<Record<string, Value>>) =>
    JSON.stringify(Object.entries(o).map(([k, v]) => [k.toLowerCase(), typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v]).sort(([x], [y]) => (String(x) < String(y) ? -1 : 1)));
  return norm(a) === norm(b);
}

/** Declared columns compared by name and type; a spec without columns takes the source's. */
function sameColumns(want: ExternalTableSpec<any>, have: ExternalTableSpec<any>): boolean {
  if (want.columns.length === 0) return true;
  return want.columns.length === have.columns.length && want.columns.every((c, i) => same(c.name, have.columns[i]!.name) && columnPlanType(c) === columnPlanType(have.columns[i]!));
}

const connectionOf = (x: ExternalTableSpec<any>): string | undefined => {
  const c = Object.entries(x.options).find(([k]) => k.toLowerCase() === 'connection')?.[1];
  return typeof c === 'string' ? c : undefined;
};

const createConnectionOp = (c: ConnectionSpec): PlanStatementInput => ({ kind: 'schema', op: { op: 'createConnection', name: c.name, ifNotExists: false, options: { ...c.options } } });
const dropOp = (objectType: 'connection' | 'external table', name: string, ifExists = false): PlanStatementInput => ({ kind: 'schema', op: { op: 'drop', objectType, name, ifExists } });
const createExternalOp = (x: ExternalTableSpec<any>): PlanStatementInput => ({
  kind: 'schema',
  op: { op: 'createExternalTable', name: x.name, ifNotExists: false, columns: x.columns.map((c) => ({ name: c.name, declaredType: toColumnDef(c).declaredType, constrained: false })), options: { ...x.options } },
});

function externalSteps(haveConns: readonly ConnectionSpec[], haveExts: readonly ExternalTableSpec<any>[], desired: SchemaSpec, options: DiffOptions, diagnostics: Diagnostic[]): Step[] {
  const steps: Step[] = [];
  const step = (action: Step['action'], object: string, reason: string, statements: PlanStatementInput[]): Step => ({ action, object, impact: 'metadata', dataLoss: 'none', reason, statements });
  const wantExts = desired.externals;
  const wantConns = desired.connections;
  const remadeExts = new Set<string>();
  if (wantConns) {
    for (const c of wantConns) {
      const old = haveConns.find((h) => same(h.name, c.name));
      if (!old) steps.push(step('createConnection', c.name, `${c.name} is not in the database`, [createConnectionOp(c)]));
      else if (!sameOptions(old.options, c.options)) {
        // The engine refuses to drop a connection an external table reads: those are made again around it.
        const users = haveExts.filter((x) => same(connectionOf(x) ?? '', c.name));
        for (const u of users) remadeExts.add(u.name.toLowerCase());
        const again = users.map((u) => wantExts?.find((w) => same(w.name, u.name)) ?? u);
        steps.push(
          step('replaceConnection', c.name, `its options change${users.length ? `; the external tables that read through it are made again (${users.map((u) => u.name).join(', ')})` : ''}`, [
            ...users.map((u) => dropOp('external table', u.name)),
            dropOp('connection', c.name),
            createConnectionOp(c),
            ...again.map(createExternalOp),
          ]),
        );
      }
    }
    for (const h of haveConns) {
      if (wantConns.some((c) => same(c.name, h.name))) continue;
      if (options.prune) steps.push(step('dropConnection', h.name, `${h.name} is not in the desired schema`, [dropOp('connection', h.name)]));
      else diagnostics.push({ level: 'info', object: h.name, message: 'a connection in the database but not in the desired schema: left alone (diff with prune to drop it)' });
    }
  }
  if (wantExts) {
    for (const x of wantExts) {
      const old = haveExts.find((h) => same(h.name, x.name));
      if (!old) steps.push(step('createExternalTable', x.name, `${x.name} is not in the database`, [createExternalOp(x)]));
      else if (remadeExts.has(x.name.toLowerCase())) continue; // made again with its connection
      else if (!sameOptions(old.options, x.options) || !sameColumns(x, old)) {
        steps.push(step('replaceExternalTable', x.name, !sameOptions(old.options, x.options) ? 'its options change' : 'its columns change', [dropOp('external table', x.name), createExternalOp(x)]));
      }
    }
    for (const h of haveExts) {
      if (wantExts.some((x) => same(x.name, h.name))) continue;
      if (options.prune) steps.push(step('dropExternalTable', h.name, `${h.name} is not in the desired schema`, [dropOp('external table', h.name)]));
      else diagnostics.push({ level: 'info', object: h.name, message: 'an external table in the database but not in the desired schema: left alone (diff with prune to drop it)' });
    }
  }
  // A connection the desired external tables read that neither exists nor is declared is an error the engine would
  // give when the table is created.
  for (const x of wantExts ?? []) {
    const c = connectionOf(x);
    if (c && !haveConns.some((h) => same(h.name, c)) && !(wantConns ?? []).some((w) => same(w.name, c))) {
      diagnostics.push({ level: 'error', object: x.name, message: `reads through connection ${c}, which is neither in the database nor in the desired schema` });
    }
  }
  return steps;
}

/** Drop a view and create it again with `source` (a materialized one filled again). */
function replaceViewStep(v: CatalogViewInfo, source: ViewSource, reason: string): Step {
  const objectType = v.materialized ? 'materialized view' : 'view';
  return {
    action: 'replaceView',
    object: v.name,
    impact: v.materialized ? 'rewrite' : 'metadata',
    dataLoss: 'none',
    reason,
    statements: [
      { kind: 'schema', op: { op: 'drop', objectType, name: v.name, ifExists: false } },
      {
        kind: 'schema',
        op: {
          op: 'createView',
          name: v.name,
          temp: false,
          ifNotExists: false,
          // A view the engine holds an interface for keeps its names when made again.
          ...(source.columns ? { columns: source.columns } : v.interface ? { columns: v.interface.map((c) => c.name) } : {}),
          materialized: v.materialized,
          ...(v.materialized ? { options: { storage: v.storage ?? 'row' }, withData: true } : {}),
          source: { language: LANGUAGE, text: JSON.stringify(source) },
        },
      },
    ],
  };
}

function finish(steps: Step[], diagnostics: Diagnostic[]): ChangeSet {
  const impact = steps.reduce<Impact>((m, s) => (IMPACTS.indexOf(s.impact) > IMPACTS.indexOf(m) ? s.impact : m), 'metadata');
  const dataLoss = steps.reduce<DataLoss>((m, s) => (LOSSES.indexOf(s.dataLoss) > LOSSES.indexOf(m) ? s.dataLoss : m), 'none');
  return { steps, diagnostics, impact, dataLoss, checksum: checksum(JSON.stringify(steps, jsonSafe)) };
}

function createTableSteps(want: TableSpec<any>, reason: string): Step[] {
  return [
    { action: 'createTable', object: want.name, impact: 'metadata', dataLoss: 'none', reason, statements: [{ kind: 'schema', op: { op: 'createTable', table: toTableDef(want), temp: false, ifNotExists: false } }] },
    ...(want.indexes ?? []).map((ix) => createIndexStep(want, ix, `index of new table ${want.name}`)),
  ];
}

function createIndexStep(table: TableSpec<any>, ix: IndexSpec, reason: string): Step {
  return { action: 'createIndex', object: ix.name, impact: 'build', dataLoss: 'none', reason, statements: [{ kind: 'schema', op: { op: 'createIndex', index: toIndexDef(table, ix), ifNotExists: false } }] };
}

function dropIndexStep(ix: IndexSpec, reason: string): Step {
  return { action: 'dropIndex', object: ix.name, impact: 'metadata', dataLoss: 'none', reason, statements: [{ kind: 'schema', op: { op: 'drop', objectType: 'index', name: ix.name, ifExists: false } }] };
}

/** The steps that turn table `old` into `want`. */
function tableSteps(old: TableSpec<any>, want: TableSpec<any>, diagnostics: Diagnostic[]): Step[] {
  const steps: Step[] = [];
  const rebuild: string[] = [];
  // Match each wanted column with the old column it continues (same name, or the name it was renamed from).
  const matched = new Map<ColumnSpec, ColumnSpec>();
  for (const c of want.columns) {
    const prev = old.columns.find((o) => same(o.name, c.name)) ?? (c.renamedFrom ? old.columns.find((o) => same(o.name, c.renamedFrom!)) : undefined);
    if (prev) matched.set(c, prev);
  }
  const kept = new Set(matched.values());
  const dropped = old.columns.filter((o) => !kept.has(o));
  const added = want.columns.filter((c) => !matched.has(c));

  for (const [c, prev] of matched) {
    const why = columnChange(prev, c);
    if (why) rebuild.push(`${c.name}: ${why}`);
  }
  // Keys and constraints read back with the old column names: compare them as they read after the table's renames.
  const renamed = new Map([...matched].filter(([c, p]) => p.name !== c.name).map(([c, p]) => [p.name.toLowerCase(), c.name]));
  const after = (cols?: readonly string[]) => cols?.map((c) => renamed.get(c.toLowerCase()) ?? c);
  if (!sameKey(after(old.primaryKey?.columns), want.primaryKey?.columns)) rebuild.push('the primary key changes');
  if (!sameKeys((old.unique ?? []).map((k) => ({ columns: after(k.columns)! })), want.unique ?? [])) rebuild.push('unique keys change');
  if (!sameChecks(old.checks ?? [], want.checks ?? [], renamed)) rebuild.push('CHECKs change');
  // A rename in place: the engine edits CHECK texts with the smaltts language (exprLanguage, smaltdb#190). It edits no
  // default text, so renaming a column a computed default reads is still a rebuild, which writes the new text.
  const reads = (n: unknown, name: string) => JSON.stringify(n).toLowerCase().includes(`{"k":"col","name":${JSON.stringify(name.toLowerCase())}}`);
  for (const [from, to] of renamed) {
    const readers = old.columns.map((c) => c.defaultExpr).filter((e) => e !== undefined);
    if (readers.some((e) => reads(e, from))) rebuild.push(`${to}: renamed from ${from}, which a computed default reads`);
  }
  if (!sameForeignKeys(old.foreignKeys ?? [], want.foreignKeys ?? [], renamed)) rebuild.push('foreign keys change');
  if ((old.storage ?? 'row') !== (want.storage ?? 'row')) rebuild.push(`storage changes to ${want.storage ?? 'row'}`);
  // Added columns must come after the existing ones for an in-place ADD COLUMN.
  // Dropping and adding in place leaves the kept columns in their old order, followed by the added ones.
  const keptOld = old.columns.filter((o) => kept.has(o));
  const wantedPrev = want.columns.filter((c) => matched.has(c)).map((c) => matched.get(c)!);
  const inOrder = keptOld.every((o, i) => wantedPrev[i] === o) && want.columns.slice(0, matched.size).every((c) => matched.has(c));
  if (!inOrder) rebuild.push('the column order changes');
  for (const c of added) {
    if (c.notNull && c.default === undefined) rebuild.push(`${c.name}: a NOT NULL column without a default can only be added by a rebuild (and only to an empty table)`);
  }

  if (rebuild.length > 0) {
    // Everything else the rebuild carries out, so the review shows the whole change.
    const also = [
      ...[...matched].filter(([c, p]) => p.name !== c.name).map(([c, p]) => `renames ${p.name} to ${c.name}`),
      ...added.map((c) => `adds ${c.name}`),
      ...dropped.map((c) => `drops ${c.name}`),
      ...(old.indexes ?? []).filter((ix) => !(want.indexes ?? []).some((w) => same(w.name, ix.name))).map((ix) => `drops index ${ix.name}`),
      ...(want.indexes ?? []).filter((ix) => !(old.indexes ?? []).some((o) => same(o.name, ix.name))).map((ix) => `creates index ${ix.name}`),
    ];
    steps.push(rebuildStep(old, want, matched, also.length ? [...rebuild, `also ${also.join(', ')}`] : rebuild, diagnostics));
    return steps;
  }

  for (const [c, prev] of matched) {
    if (prev.name !== c.name) {
      steps.push({ action: 'renameColumn', object: `${want.name}.${c.name}`, impact: 'metadata', dataLoss: 'none', reason: `renamed from ${prev.name}`, statements: [{ kind: 'schema', op: { op: 'alterTable', table: want.name, action: { kind: 'renameColumn', column: prev.name, newName: c.name } } }] });
    }
  }
  for (const c of dropped) {
    steps.push({ action: 'dropColumn', object: `${want.name}.${c.name}`, impact: 'rewrite', dataLoss: 'certain', reason: `${c.name} is not in the desired table`, statements: [{ kind: 'schema', op: { op: 'alterTable', table: want.name, action: { kind: 'dropColumn', column: c.name } } }] });
  }
  for (const c of added) {
    steps.push({ action: 'addColumn', object: `${want.name}.${c.name}`, impact: 'instant', dataLoss: 'none', reason: `${c.name} is not in the table`, statements: [{ kind: 'schema', op: { op: 'alterTable', table: want.name, action: { kind: 'addColumn', column: toColumnDef(c), checks: [], foreignKeys: [], text: JSON.stringify(c) } } }] });
  }
  // Indexes: by name.
  for (const ix of old.indexes ?? []) {
    const w = (want.indexes ?? []).find((x) => same(x.name, ix.name));
    if (!w) steps.push(dropIndexStep(ix, `${ix.name} is not in the desired table`));
    else if (!sameIndex(ix, w, matched)) steps.push(dropIndexStep(ix, `${ix.name} changes`), createIndexStep(want, w, `${ix.name} changes`));
  }
  for (const ix of want.indexes ?? []) {
    if (!(old.indexes ?? []).some((x) => same(x.name, ix.name))) steps.push(createIndexStep(want, ix, `${ix.name} is not in the database`));
  }
  return steps;
}

/** An expression's JSON with its column names renamed (`from` lower-case), for comparing constraints. */
function exprKey(n: unknown, renamed: ReadonlyMap<string, string>): string {
  return JSON.stringify(n, (k, v) => (k === 'name' && typeof v === 'string' && renamed.has(v.toLowerCase()) ? renamed.get(v.toLowerCase()) : v));
}

/** The same CHECKs: by expression, and by name where the desired one is named (the engine names the others). */
function sameChecks(have: readonly CheckSpec[], want: readonly CheckSpec[], renamed: ReadonlyMap<string, string>): boolean {
  if (have.length !== want.length) return false;
  const left = have.map((c) => exprKey(c.expr, renamed));
  return want.every((w) => {
    const i = left.indexOf(exprKey(w.expr, new Map()));
    if (i < 0 || (w.name && have[i]!.name?.toLowerCase() !== w.name.toLowerCase())) return false;
    left[i] = '';
    return true;
  });
}

/** The same foreign keys: columns, parent, actions, and parent columns where the desired one names them. */
function sameForeignKeys(have: readonly ForeignKeySpec[], want: readonly ForeignKeySpec[], renamed: ReadonlyMap<string, string>): boolean {
  if (have.length !== want.length) return false;
  const key = (f: ForeignKeySpec, map: ReadonlyMap<string, string>, refs: boolean) =>
    JSON.stringify([f.columns.map((c) => (map.get(c.toLowerCase()) ?? c).toLowerCase()), f.table.toLowerCase(), f.onDelete ?? 'NO ACTION', f.onUpdate ?? 'NO ACTION', refs ? (f.refColumns ?? []).map((c) => c.toLowerCase()) : null]);
  const left = [...have];
  return want.every((w) => {
    const i = left.findIndex((h) => h && key(h, renamed, !!w.refColumns) === key(w, new Map(), !!w.refColumns) && (!w.name || h.name?.toLowerCase() === w.name.toLowerCase()));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

/** A full list or struct type, compared without regard to spacing or case. */
const fullType = (c: ColumnSpec) => (c.planType ?? '').replace(/\s+/g, ' ').replace(/\s*([<>,])\s*/g, '$1').toLowerCase();

function columnChange(prev: ColumnSpec, c: ColumnSpec): string | undefined {
  if (prev.type !== c.type) return `type ${prev.type} → ${c.type}`;
  if (fullType(prev) !== fullType(c)) return `type ${prev.planType ?? prev.type} → ${c.planType ?? c.type}`;
  if (!!prev.notNull !== !!c.notNull) return c.notNull ? 'becomes NOT NULL' : 'becomes nullable';
  if ((prev.collation ?? 'binary') !== (c.collation ?? 'binary')) return `collation ${prev.collation ?? 'binary'} → ${c.collation ?? 'binary'}`;
  if (JSON.stringify(prev.default ?? null) !== JSON.stringify(c.default ?? null)) return 'default changes';
  if (JSON.stringify(prev.defaultExpr ?? null) !== JSON.stringify(c.defaultExpr ?? null)) return 'default changes';
  return undefined;
}

const sameKey = (a?: readonly string[], b?: readonly string[]) => (a ?? []).map((x) => x.toLowerCase()).join(',') === (b ?? []).map((x) => x.toLowerCase()).join(',');
const sameKeys = (a: readonly { columns: readonly string[] }[], b: readonly { columns: readonly string[] }[]) => {
  const norm = (ks: readonly { columns: readonly string[] }[]) => ks.map((k) => k.columns.map((c) => c.toLowerCase()).join(',')).sort().join(';');
  return norm(a) === norm(b);
};
function sameIndex(a: IndexSpec, b: IndexSpec, matched: Map<ColumnSpec, ColumnSpec>): boolean {
  const renamed = new Map([...matched].map(([c, p]) => [p.name.toLowerCase(), c.name.toLowerCase()]));
  const cols = (ix: IndexSpec, map: boolean) => ix.columns.map((c) => `${map ? (renamed.get(c.column.toLowerCase()) ?? c.column.toLowerCase()) : c.column.toLowerCase()}${c.desc ? ' desc' : ''}`).join(',');
  return cols(a, true) === cols(b, false) && !!a.unique === !!b.unique;
}

/**
 * The statements of a rebuild: the new table built under a temporary name, the rows copied by an append plan, the old
 * table dropped and the new one renamed into its place (columnar tables too), then its indexes.
 */
function* rebuildStatements(old: TableSpec<any>, want: TableSpec<any>, temp: TableSpec<any>, copy: plan.PlanOp): Generator<PlanStatementInput> {
  yield { kind: 'schema', op: { op: 'createTable', table: toTableDef(temp), temp: false, ifNotExists: false } };
  yield { kind: 'write', plan: copy };
  yield { kind: 'schema', op: { op: 'drop', objectType: 'table', name: old.name, ifExists: false } };
  yield { kind: 'schema', op: { op: 'alterTable', table: temp.name, action: { kind: 'renameTable', newName: want.name } } };
  for (const ix of want.indexes ?? []) yield { kind: 'schema', op: { op: 'createIndex', index: toIndexDef(want, ix), ifNotExists: false } };
}

function rebuildStep(old: TableSpec<any>, want: TableSpec<any>, matched: Map<ColumnSpec, ColumnSpec>, reasons: string[], diagnostics: Diagnostic[]): Step {
  const temp = `${want.name}__smaltts_rebuild`;
  const tempSpec = { ...want, name: temp, indexes: [] };
  const copied = want.columns.filter((c) => matched.has(c));
  const scan = P.scan(old.name, copied.map((c) => columnIndex(old, matched.get(c)!.name)));
  // Each column whose type changes is converted with the engine's cast for the pair (the conversion table).
  let loss: DataLoss = 'none';
  const exprs = copied.map((c, i) => {
    const prev = matched.get(c)!;
    const raw = P.col(0, i, columnPlanType(prev), prev.collation ?? 'binary');
    const sameType = prev.type === c.type && fullType(prev) === fullType(c);
    if (sameType) return raw;
    const conv = prev.type === c.type ? undefined : conversion(prev.type, c.type);
    if (!conv) {
      diagnostics.push({ level: 'error', object: `${want.name}.${c.name}`, message: `no conversion from ${prev.planType ?? prev.type} to ${c.planType ?? c.type}: drop the column and add a new one, or convert the values in a load` });
      return raw;
    }
    if (conv.loss === 'possible') loss = 'possible';
    return conv.fn ? P.call(conv.fn, [raw], columnPlanType(c)) : raw;
  });
  if ([...matched].some(([c, p]) => !p.notNull && c.notNull)) loss = 'possible';
  // An added NOT NULL column with no default has nothing to copy into it: the copy fails if the table has rows.
  if (want.columns.some((c) => !matched.has(c) && c.notNull && c.default === undefined && c.defaultExpr === undefined)) loss = 'possible';
  const copy: plan.PlanOp = P.append(temp, P.project(scan, exprs), copied.map((c) => columnIndex(want, c.name)));
  const drops = old.columns.length > matched.size;
  return {
    action: 'rebuildTable',
    object: want.name,
    impact: 'rewrite',
    dataLoss: drops ? 'certain' : loss,
    reason: reasons.join('; '),
    statements: [...rebuildStatements(old, want, tempSpec, copy)],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Applying.

export interface ApplyPolicy {
  /** The most data loss allowed. Default `none`: a change set that may lose data is refused. */
  readonly allowDataLoss?: DataLoss;
  /** The most impact allowed. Default `rewrite` (anything). */
  readonly maxImpact?: Impact;
  /** A label recorded in the history table. */
  readonly label?: string;
}

export interface Applied {
  readonly steps: number;
  readonly checksum: string;
}

/** Run a change set in one transaction, if `policy` allows it, and record it in the history table. */
export async function apply(db: Backend, changes: ChangeSet, policy: ApplyPolicy = {}, file?: { readonly name: string; readonly checksum: string }): Promise<Applied> {
  const errors = changes.diagnostics.filter((d) => d.level === 'error');
  if (errors.length) throw new Error(`the change set has errors: ${errors.map((e) => `${e.object}: ${e.message}`).join('; ')}`);
  const loss = policy.allowDataLoss ?? 'none';
  const refused = changes.steps.filter((s) => LOSSES.indexOf(s.dataLoss) > LOSSES.indexOf(loss) || IMPACTS.indexOf(s.impact) > IMPACTS.indexOf(policy.maxImpact ?? 'rewrite'));
  if (refused.length) {
    throw new Error(`the policy refuses ${refused.length} step(s): ${refused.map((s) => `${s.action} ${s.object} (impact ${s.impact}, data loss ${s.dataLoss})`).join('; ')}`);
  }
  await db.transaction(async (tx) => {
    for (const step of changes.steps) {
      for (const stmt of step.statements) {
        try {
          await tx.run(stmt);
        } catch (e) {
          throw new Error(`${step.action} ${step.object}: ${(e as Error).message}`, { cause: e });
        }
      }
    }
    await recordHistory(tx, changes, policy.label, file);
  });
  return { steps: changes.steps.length, checksum: changes.checksum };
}

const historySpec: TableSpec = {
  kind: 'table',
  name: HISTORY_TABLE,
  columns: [
    { name: 'id', type: 'INTEGER', notNull: true },
    { name: 'checksum', type: 'TEXT', notNull: true },
    { name: 'label', type: 'TEXT' },
    { name: 'steps', type: 'TEXT', notNull: true },
    // A saved change-set file's name and checksum (milestone 4), when the change set came from one.
    { name: 'file', type: 'TEXT' },
    { name: 'file_checksum', type: 'TEXT' },
  ],
  primaryKey: { columns: ['id'] },
};

async function recordHistory(db: Backend, changes: ChangeSet, label: string | undefined, file?: { readonly name: string; readonly checksum: string }): Promise<void> {
  await ensureHistory(db);
  const steps = JSON.stringify(changes.steps.map((s) => ({ action: s.action, object: s.object, reason: s.reason })));
  const row = P.values([[P.lit(changes.checksum), P.lit(label ?? null), P.lit(steps), P.lit(file?.name ?? null), P.lit(file?.checksum ?? null)]], ['text', 'text', 'text', 'text', 'text']);
  await db.run({ kind: 'write', plan: P.append(HISTORY_TABLE, row, [1, 2, 3, 4, 5]) });
}

/** The history table, created if missing, with the file columns added to one made before milestone 4. */
export async function ensureHistory(db: Backend): Promise<void> {
  await db.run({ kind: 'schema', op: { op: 'createTable', table: toTableDef(historySpec), temp: false, ifNotExists: true } });
  const t = (await db.catalog()).tables.find((x) => same(x.name, HISTORY_TABLE));
  for (const c of historySpec.columns) {
    if (t && !t.columns.some((x) => same(x.name, c.name))) {
      await db.run({ kind: 'schema', op: { op: 'alterTable', table: HISTORY_TABLE, action: { kind: 'addColumn', column: toColumnDef(c), checks: [], foreignKeys: [], text: JSON.stringify(c) } } });
    }
  }
}

/** Render a change set for review. */
export function describe(changes: ChangeSet): string {
  const lines = changes.steps.map((s, i) => `${String(i + 1).padStart(2)}. ${s.action} ${s.object}  [impact ${s.impact}, data loss ${s.dataLoss}]\n      ${s.reason}`);
  const notes = changes.diagnostics.map((d) => `${d.level}: ${d.object}: ${d.message}`);
  return [`${changes.steps.length} step(s), impact ${changes.impact}, data loss ${changes.dataLoss}, checksum ${changes.checksum}`, ...lines, ...notes].join('\n');
}

export function jsonSafe(_: string, v: unknown): unknown {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Uint8Array) return { $blob: [...v] };
  return v;
}

/** FNV-1a, 64-bit, as hex. */
export function checksum(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}
