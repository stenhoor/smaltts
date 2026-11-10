/**
 * `attach(db)`: a smaltdb database seen from smaltts. Database first: its catalog, the changes that bring it to a
 * desired schema, its views, loads into its tables, its plans and their costs, and its plugins.
 */
import * as P from 'smaltdb/plan';
import type { PlanStatementInput } from 'smaltdb/plan';
import { type Backend, type ClientDatabase, type EngineDatabase, backendOf } from './backend.js';
import { type Catalog, readCatalog } from './catalog.js';
import { type Applied, type ApplyPolicy, type ChangeSet, type DiffOptions, apply, diff } from './changes.js';
import { LANGUAGE, type ViewSource } from './source.js';
import { type Cols, type Compiled, Expr, type Field, Rel, compileRel, expr } from './rel.js';
import { toIndexDef, toTableDef } from './ddl.js';
import { type SchemaSpec, type TableSpec, type Value, columnIndex, columnPlanType } from './spec.js';

/** How a load writes into its target. */
export type LoadMode =
  /** Add the rows. */
  | 'append'
  /** Add the rows; a row whose key is taken replaces the existing row's other columns. */
  | 'upsert'
  /** Delete every row, then add these, in one transaction. */
  | 'replace'
  /** Build a new copy of the table with these rows and indexes, then switch it in: readers never see it half-built. */
  | 'swap';

export interface ExplainNode {
  readonly id: number;
  readonly detail: string;
  /** Estimated rows (from statistics: `db.analyze()`), when known. */
  readonly estimatedRows: number | null;
  /** Measured, with `explain(rel, { analyze: true })`. */
  readonly actual?: { readonly rows: number; readonly loops: number; readonly timeMs: number };
  readonly children: readonly ExplainNode[];
}

export interface Explained {
  readonly roots: readonly ExplainNode[];
  /** The engine plan that was explained. */
  readonly plan: P.PlanOp;
  toString(): string;
}

export class SmaltDb {
  private cached: Catalog | undefined;
  readonly backend: Backend;
  constructor(backend: Backend) {
    this.backend = backend;
  }

  // ----- Catalog and schema -----

  /** The database's objects, as specs. */
  async catalog(options: { fresh?: boolean } = {}): Promise<Catalog> {
    if (!this.cached || options.fresh) this.cached = await readCatalog(this.backend);
    return this.cached;
  }
  /** What it would take to bring the database to `desired`: a change set to review. Nothing runs. */
  async diff(desired: SchemaSpec, options?: DiffOptions): Promise<ChangeSet> {
    return diff(await this.catalog({ fresh: true }), desired, options);
  }
  /** Run a reviewed change set, if the policy allows it. */
  async apply(changes: ChangeSet, policy?: ApplyPolicy): Promise<Applied> {
    try {
      return await apply(this.backend, changes, policy);
    } finally {
      this.cached = undefined;
    }
  }
  /** `diff` then `apply`, under the policy. */
  async migrate(desired: SchemaSpec, policy?: ApplyPolicy & DiffOptions): Promise<{ changes: ChangeSet; applied: Applied }> {
    const changes = await this.diff(desired, policy);
    return { changes, applied: await this.apply(changes, policy) };
  }

  /**
   * A view: `rel` is stored as smaltts source and bound by name each time the view is read. Without `columns` the view
   * reflects the tables it reads (its columns follow them); `columns` declares it an interface: these of its relation's
   * columns, in this order (`true`: all of them as they are now), whatever is renamed or added underneath.
   */
  async createView(
    name: string,
    rel: Rel<any>,
    options: { columns?: readonly string[] | true; materialized?: boolean; storage?: 'row' | 'columnar'; populate?: boolean; replace?: boolean } = {},
  ): Promise<void> {
    let source: ViewSource = { kind: 'view', rel: rel.node };
    if (options.columns) {
      const fields = (await this.compile(rel)).fields;
      const columns = options.columns === true ? fields.map((f) => f.name) : options.columns;
      for (const c of columns) if (!fields.some((f) => f.name.toLowerCase() === c.toLowerCase())) throw new Error(`createView ${name}: no column named ${c} (columns: ${fields.map((f) => f.name).join(', ')})`);
      if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new Error(`createView ${name}: a column is listed twice`);
      source = { kind: 'view', rel: { r: 'select', input: rel.node, fields: columns.map((c) => [c, { k: 'col', name: c }] as const) }, columns };
    }
    const materialized = options.materialized ?? false;
    await this.backend.transaction(async (tx) => {
      if (options.replace) await tx.run({ kind: 'schema', op: { op: 'drop', objectType: materialized ? 'materialized view' : 'view', name, ifExists: true } });
      await tx.run({
        kind: 'schema',
        op: {
          op: 'createView',
          name,
          temp: false,
          ifNotExists: false,
          ...(source.columns ? { columns: source.columns } : {}),
          materialized,
          ...(materialized ? { options: { storage: options.storage ?? 'row' }, withData: options.populate ?? true } : {}),
          source: { language: LANGUAGE, text: JSON.stringify(source) },
        },
      });
    });
    this.cached = undefined;
  }
  /** Drop a view (a materialized view with `materialized`). */
  async dropView(name: string, options: { materialized?: boolean; ifExists?: boolean } = {}): Promise<void> {
    await this.backend.run({ kind: 'schema', op: { op: 'drop', objectType: options.materialized ? 'materialized view' : 'view', name, ifExists: options.ifExists ?? false } });
    this.cached = undefined;
  }
  /** Fill a materialized view again from its relation. */
  async refresh(name: string, options: { concurrently?: boolean; ifChanged?: boolean } = {}): Promise<void> {
    await this.backend.run({ kind: 'maintenance', action: 'refresh', view: name, concurrently: options.concurrently ?? false, withData: true, ifChanged: options.ifChanged ?? false });
  }
  /** Gather statistics, so plans can be costed. */
  async analyze(table?: string): Promise<void> {
    await this.backend.run(table ? { kind: 'maintenance', action: 'analyze', target: table } : { kind: 'maintenance', action: 'analyze' });
  }

  // ----- Plans -----

  /** The engine plan of a relation, with its output fields. */
  async compile(rel: Rel<any>): Promise<Compiled> {
    const catalog = await this.catalog();
    return compileRel(rel, catalog);
  }
  /** Run a relation; rows are objects typed by the relation. */
  /**
   * Run a relation; rows are objects typed by the relation. Dates and times come back as JavaScript `Date`s for `date`
   * and `datetime` columns (a `Date` holds ms, so a `datetime`'s µs are dropped: owner's decision, 2026-11-10), or as
   * the engine's exact text with `{ temporal: 'text' }`.
   */
  async rows<Row extends Record<string, unknown>>(rel: Rel<Row>, params?: Record<string, unknown>, options?: { signal?: AbortSignal; temporal?: 'date' }): Promise<Row[]>;
  async rows<Row extends Record<string, unknown>>(rel: Rel<Row>, params: Record<string, unknown> | undefined, options: { signal?: AbortSignal; temporal: 'text' }): Promise<AsText<Row>[]>;
  async rows<Row extends Record<string, unknown>>(rel: Rel<Row>, params: Record<string, unknown> = {}, options: { signal?: AbortSignal; temporal?: 'date' | 'text' } = {}): Promise<Row[]> {
    const c = await this.compile(rel);
    const r = await this.backend.run({ kind: 'query', plan: c.plan, columns: c.fields.map((f) => ({ name: f.name, type: f.type, collation: f.collation })) }, bind(c, params), { ...options, temporal: options.temporal ?? 'date' });
    return r.rows.map((row) => Object.fromEntries(c.fields.map((f, i) => [f.name, row[i]])) as Row);
  }
  /** The plan the engine would run, as a tree; with `analyze`, run it and measure each node. */
  async explain(rel: Rel<any>, options: { analyze?: boolean; params?: Record<string, unknown> } = {}): Promise<Explained> {
    const c = await this.compile(rel);
    const query = { kind: 'query' as const, plan: c.plan };
    const r = await this.backend.run({ kind: 'explain', mode: options.analyze ? 'analyze' : 'plan', query }, bind(c, options.params ?? {}));
    return explainTree(r.rows, !!options.analyze, c.plan);
  }

  // ----- Loads and writes -----

  /** Write rows into a table: from a relation (another table, a file through a plugin, a view) or JavaScript rows. */
  async load(table: TableSpec<any> | string, source: Rel<any> | readonly Record<string, unknown>[], options: { mode?: LoadMode } = {}): Promise<{ rows: number }> {
    const mode = options.mode ?? 'append';
    const catalog = await this.catalog();
    const target = catalog.table(typeof table === 'string' ? table : table.name);
    if (!target) throw new Error(`no table named ${typeof table === 'string' ? table : table.name}`);
    const c = source instanceof Rel ? compileRel(source, catalog) : rowsPlan(target, source);
    const columns = c.fields.map((f) => columnIndex(target, f.name));
    const write = (into: string, upsert: boolean): PlanStatementInput => ({
      kind: 'write',
      plan: {
        ...P.append(into, c.plan, columns),
        upserts: upsert ? [{ target: null, update: { sets: columns.filter((i) => !isKey(target, i)).map((i) => ({ column: i, value: P.col(0, target.columns.length + 1 + i, columnPlanType(target.columns[i]!)) })) } }] : [],
      },
      source: c.fields.map((f) => ({ name: f.name, type: f.type })),
    });
    const before = await this.count(target.name);
    let rows = 0;
    await this.backend.transaction(async (tx) => {
      if (mode === 'replace') await tx.run({ kind: 'write', plan: P.remove(target.name, P.scan(target.name, [-1]), 0) });
      if (mode === 'swap') {
        // The engine cannot rename a columnar table (finding F4): a columnar target is recreated under its name and
        // filled from a row-storage staging table instead.
        const columnar = (target.storage ?? 'row') === 'columnar';
        const next = { ...target, name: `${target.name}__smaltts_swap`, indexes: [], ...(columnar ? { storage: 'row' as const } : {}) };
        await tx.run({ kind: 'schema', op: { op: 'drop', objectType: 'table', name: next.name, ifExists: true } });
        await tx.run({ kind: 'schema', op: { op: 'createTable', table: toTableDef(next), temp: false, ifNotExists: false } });
        await tx.run(write(next.name, false), bind(c, {}));
        await tx.run({ kind: 'schema', op: { op: 'drop', objectType: 'table', name: target.name, ifExists: false } });
        if (columnar) {
          const all = target.columns.map((_, i) => i);
          await tx.run({ kind: 'schema', op: { op: 'createTable', table: toTableDef(target), temp: false, ifNotExists: false } });
          await tx.run({ kind: 'write', plan: P.append(target.name, P.scan(next.name, all), all) });
          await tx.run({ kind: 'schema', op: { op: 'drop', objectType: 'table', name: next.name, ifExists: false } });
        } else {
          await tx.run({ kind: 'schema', op: { op: 'alterTable', table: next.name, action: { kind: 'renameTable', newName: target.name } } });
        }
        for (const ix of target.indexes ?? []) {
          await tx.run({ kind: 'schema', op: { op: 'createIndex', index: toIndexDef(target, ix), ifNotExists: false } });
        }
        rows = await countIn(tx, target.name);
        return;
      }
      await tx.run(write(target.name, mode === 'upsert'), bind(c, {}));
      rows = (await countIn(tx, target.name)) - (mode === 'replace' ? 0 : before);
    });
    this.cached = undefined;
    return { rows };
  }
  /** Delete the rows of a table where `pred` is true. */
  async deleteWhere<Row extends Record<string, unknown>>(table: TableSpec<Row>, pred: (r: Cols<Row>) => Expr<number | null>): Promise<void> {
    const { input } = await this.targetRows(table, pred);
    await this.backend.run({ kind: 'write', plan: P.remove(table.name, input, 0) });
  }
  /** Set columns of the rows of a table where `pred` is true. */
  async updateWhere<Row extends Record<string, unknown>>(table: TableSpec<Row>, set: (r: Cols<Row>) => Partial<{ [K in keyof Row]: Expr<Row[K]> | Row[K] }>, pred: (r: Cols<Row>) => Expr<number | null>): Promise<void> {
    const { input, fields, spec } = await this.targetRows(table, pred);
    const proxy = new Proxy({}, { get: (_, n) => (typeof n === 'string' ? new Expr({ k: 'col', name: n }) : undefined) }) as Cols<Row>;
    const sets = Object.entries(set(proxy)).map(([name, v]) => ({ column: columnIndex(spec, name), value: expr(v instanceof Expr ? v.node : { k: 'lit', value: v as Value }, [fields], []).e }));
    await this.backend.run({ kind: 'write', plan: P.update(table.name, input, 0, sets) });
  }
  private async targetRows(table: TableSpec<any>, pred: (r: any) => Expr<number | null>) {
    const catalog = await this.catalog();
    const spec = catalog.table(table.name) ?? table;
    // The rowid first, then the table's columns.
    const fields: Field[] = [{ name: '__rowid', type: 'int', collation: 'binary' }, ...spec.columns.map((c) => ({ name: c.name, type: columnPlanType(c), collation: c.collation ?? 'binary' }))];
    const proxy = new Proxy({}, { get: (_, n) => (typeof n === 'string' ? new Expr({ k: 'col', name: n }) : undefined) });
    const input = P.filter(P.scan(spec.name, [-1, ...spec.columns.map((_, i) => i)]), expr(pred(proxy).node, [fields], []).e);
    return { input, fields, spec };
  }
  private async count(table: string): Promise<number> {
    return countIn(this.backend, table);
  }

  // ----- Plugins and transactions -----

  /** A plugin's methods. */
  plugin(name: string): { call(method: string, ...args: unknown[]): Promise<unknown> } {
    return { call: (method, ...args) => this.backend.callPlugin(name, method, args) };
  }
  /** Run `fn` in one transaction (nested calls are savepoints on the in-process engine). */
  transaction<T>(fn: (db: SmaltDb) => Promise<T>): Promise<T> {
    return this.backend.transaction((tx) => fn(new SmaltDb(tx)));
  }
}

/** smaltts over an engine or client `Database`. */
export function attach(db: EngineDatabase | ClientDatabase | Backend): SmaltDb {
  return new SmaltDb(backendOf(db));
}

function bind(c: Compiled, params: Record<string, unknown>): unknown[] {
  return c.params.map((name) => {
    if (!(name in params)) throw new Error(`parameter ${name} has no value`);
    return params[name]!;
  });
}

const isKey = (t: TableSpec<any>, i: number) => (t.primaryKey?.columns ?? []).some((c) => c.toLowerCase() === t.columns[i]!.name.toLowerCase());

async function countIn(db: Backend, table: string): Promise<number> {
  const r = await db.run({ kind: 'query', plan: P.aggregate(P.scan(table, []), [], [P.agg('count', [], 'int', { star: true })]) });
  return Number(r.rows[0]![0]);
}

/**
 * JavaScript rows as the engine's values from columns, typed by the target table's columns: the engine encodes
 * booleans, `Date`s, arrays and objects itself (smaltdb ADRs 0016 §5, 0018–0020).
 */
function rowsPlan(target: TableSpec<any>, rows: readonly Record<string, unknown>[]): Compiled {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cols = names.map((n) => target.columns[columnIndex(target, n)]!);
  const types = cols.map(columnPlanType);
  // A Date in a date column goes in as its ISO day: the engine reads a Date as a datetime there (finding F3).
  const value = (v: unknown, type: string) => (v === undefined ? null : type === 'date' && v instanceof Date ? v.toISOString().slice(0, 10) : v);
  const data = names.map((n, i) => rows.map((r) => value(r[n], types[i]!))) as P.ValueColumn[];
  return { plan: P.fromColumns(data, types), fields: cols.map((c, i) => ({ name: c.name, type: types[i]!, collation: c.collation ?? 'binary' })), params: [] };
}

/** A row type as read with `{ temporal: 'text' }`: dates and times as the engine's text. */
export type AsText<R> = { [K in keyof R]: R[K] extends Date ? string : R[K] extends Date | null ? string | null : R[K] };

function explainTree(rows: readonly (readonly Value[])[], analyzed: boolean, plan: P.PlanOp): Explained {
  const nodes = new Map<number, { node: ExplainNode & { children: ExplainNode[] }; parent: number }>();
  for (const r of rows) {
    const [id, parent] = [Number(r[0]), Number(r[1])];
    const node = analyzed
      ? { id, detail: String(r[2]), estimatedRows: r[3] === null ? null : Number(r[3]), actual: { loops: Number(r[4]), rows: Number(r[5]), timeMs: Number(r[6]) }, children: [] as ExplainNode[] }
      : { id, detail: String(r[3]), estimatedRows: null, children: [] as ExplainNode[] };
    nodes.set(id, { node, parent });
  }
  const roots: ExplainNode[] = [];
  for (const { node, parent } of nodes.values()) (nodes.get(parent)?.node.children ?? roots).push(node);
  const render = (n: ExplainNode, depth: number): string[] => [
    `${'  '.repeat(depth)}${n.detail}${n.estimatedRows !== null ? `  (est ${n.estimatedRows} rows)` : ''}${n.actual ? `  [${n.actual.rows} rows, ${n.actual.loops} loops, ${n.actual.timeMs} ms]` : ''}`,
    ...n.children.flatMap((c) => render(c, depth + 1)),
  ];
  return { roots, plan, toString: () => roots.flatMap((r) => render(r, 0)).join('\n') };
}
