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
import { type Catalog, readCatalog } from './catalog.js';
import { conversion } from './conversions.js';
import { toColumnDef, toIndexDef, toTableDef } from './ddl.js';
import { type CheckSpec, type ColumnSpec, type ForeignKeySpec, type IndexSpec, type SchemaSpec, type TableSpec, columnIndex, columnPlanType } from './spec.js';

/** How much a step costs and disrupts, from least to most. */
export type Impact = 'metadata' | 'instant' | 'build' | 'rewrite';
const IMPACTS: readonly Impact[] = ['metadata', 'instant', 'build', 'rewrite'];
/** What a step may lose: rows or values that do not survive it. */
export type DataLoss = 'none' | 'possible' | 'certain';
const LOSSES: readonly DataLoss[] = ['none', 'possible', 'certain'];

export interface Step {
  readonly action: 'createTable' | 'dropTable' | 'renameTable' | 'addColumn' | 'dropColumn' | 'renameColumn' | 'rebuildTable' | 'createIndex' | 'dropIndex';
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
  return diffCatalog(catalog.tables.filter((t) => !same(t.name, HISTORY_TABLE)), desired, options);
}

/** `diff` on specs alone, with no database. */
export function diffCatalog(have: readonly TableSpec<any>[], desired: SchemaSpec, options: DiffOptions = {}): ChangeSet {
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

  const order: Step['action'][] = ['renameTable', 'dropIndex', 'renameColumn', 'dropColumn', 'addColumn', 'rebuildTable', 'createTable', 'createIndex', 'dropTable'];
  steps.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  for (const s of steps) {
    if (s.dataLoss === 'certain') diagnostics.push({ level: 'warning', object: s.object, message: `${s.action} loses data: ${s.reason}` });
  }
  return finish(steps, diagnostics);
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
  // A rename in place leaves a CHECK's or computed default's text with the old name (a table without source text has
  // no language to edit it), so renaming a column one of them reads is a rebuild, which writes the new text.
  const reads = (n: unknown, name: string) => JSON.stringify(n).toLowerCase().includes(`{"k":"col","name":${JSON.stringify(name.toLowerCase())}}`);
  for (const [from, to] of renamed) {
    const readers = [...(old.checks ?? []).map((c) => c.expr), ...old.columns.map((c) => c.defaultExpr).filter((e) => e !== undefined)];
    if (readers.some((e) => reads(e, from))) rebuild.push(`${to}: renamed from ${from}, which a CHECK or computed default reads`);
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

/** Rebuild `old` as `want`: new table, rows copied by an append plan, old table dropped, new one renamed. */
/**
 * The statements of a rebuild. The engine cannot rename a columnar table (finding F4), so when either side is
 * columnar the rows go through a row-storage staging table: copy there, drop the old table, create the new one under
 * its name, copy back, drop the staging table. Otherwise the new table is built under a temporary name and renamed.
 */
function* rebuildStatements(old: TableSpec<any>, want: TableSpec<any>, temp: TableSpec<any>, copy: plan.PlanOp): Generator<PlanStatementInput> {
  const columnar = (old.storage ?? 'row') === 'columnar' || (want.storage ?? 'row') === 'columnar';
  const staging = columnar ? { ...temp, storage: 'row' as const } : temp;
  yield { kind: 'schema', op: { op: 'createTable', table: toTableDef(staging), temp: false, ifNotExists: false } };
  yield { kind: 'write', plan: copy };
  yield { kind: 'schema', op: { op: 'drop', objectType: 'table', name: old.name, ifExists: false } };
  if (columnar) {
    yield { kind: 'schema', op: { op: 'createTable', table: toTableDef(want), temp: false, ifNotExists: false } };
    const all = want.columns.map((_, i) => i);
    yield { kind: 'write', plan: P.append(want.name, P.scan(staging.name, all), all) };
    yield { kind: 'schema', op: { op: 'drop', objectType: 'table', name: staging.name, ifExists: false } };
  } else {
    yield { kind: 'schema', op: { op: 'alterTable', table: staging.name, action: { kind: 'renameTable', newName: want.name } } };
  }
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
export async function apply(db: Backend, changes: ChangeSet, policy: ApplyPolicy = {}): Promise<Applied> {
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
    await recordHistory(tx, changes, policy.label);
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
  ],
  primaryKey: { columns: ['id'] },
};

async function recordHistory(db: Backend, changes: ChangeSet, label: string | undefined): Promise<void> {
  await db.run({ kind: 'schema', op: { op: 'createTable', table: toTableDef(historySpec), temp: false, ifNotExists: true } });
  const row = P.values([[P.lit(changes.checksum), P.lit(label ?? null), P.lit(JSON.stringify(changes.steps.map((s) => ({ action: s.action, object: s.object, reason: s.reason }))))]], ['text', 'text', 'text']);
  await db.run({ kind: 'write', plan: P.append(HISTORY_TABLE, row, [1, 2, 3]) });
}

/** Render a change set for review. */
export function describe(changes: ChangeSet): string {
  const lines = changes.steps.map((s, i) => `${String(i + 1).padStart(2)}. ${s.action} ${s.object}  [impact ${s.impact}, data loss ${s.dataLoss}]\n      ${s.reason}`);
  const notes = changes.diagnostics.map((d) => `${d.level}: ${d.object}: ${d.message}`);
  return [`${changes.steps.length} step(s), impact ${changes.impact}, data loss ${changes.dataLoss}, checksum ${changes.checksum}`, ...lines, ...notes].join('\n');
}

function jsonSafe(_: string, v: unknown): unknown {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Uint8Array) return { $blob: [...v] };
  return v;
}

/** FNV-1a, 64-bit, as hex. */
function checksum(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}
