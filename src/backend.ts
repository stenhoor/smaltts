/**
 * Backends: the two ways to reach a smaltdb engine, behind one asynchronous interface.
 *
 * - the in-process engine (`smaltdb/engine`'s `Database`: Node, tests, a worker of your own), synchronous underneath;
 * - the client (`smaltdb`'s `Database`), whose engine runs in a worker.
 *
 * Both take plans (`queryPlan`) and plugin calls (`callPlugin`). smaltts imports only types from smaltdb, so it adds no
 * engine to a page that builds plans.
 */
import type { PlanStatementInput } from 'smaltdb/plan';
import type { Value } from './spec.js';

export interface Result {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Value[])[];
}

export interface Backend {
  run(stmt: PlanStatementInput, params?: readonly Value[], options?: { signal?: AbortSignal }): Promise<Result>;
  /** Run `fn` in one transaction: every statement it runs commits together, or none does. */
  transaction<T>(fn: (tx: Backend) => Promise<T>): Promise<T>;
  callPlugin(plugin: string, method: string, args: unknown[]): Promise<unknown>;
  readonly kind: 'engine' | 'client';
}

/** The in-process engine's `Database`, as far as smaltts uses it. */
export interface EngineDatabase {
  queryPlanAsync(stmt: PlanStatementInput, params?: readonly Value[], options?: { signal?: AbortSignal }): Promise<{ columns: string[]; rows: Value[][] }>;
  callPlugin(plugin: string, method: string, args: unknown[]): Promise<unknown>;
  readonly inTransaction: boolean;
}

/** What the client `Database` and its transaction handles share, as far as smaltts uses it. */
export interface ClientQueryable {
  queryPlan(stmt: PlanStatementInput, params?: readonly Value[], options?: { rowMode?: 'array'; signal?: AbortSignal }): Promise<unknown>;
}
export interface ClientDatabase extends ClientQueryable {
  transaction<T>(fn: (tx: ClientQueryable) => Promise<T>): Promise<T>;
  callPlugin(plugin: string, method: string, args: unknown[]): Promise<unknown>;
}

export function engineBackend(db: EngineDatabase): Backend {
  const backend: Backend = {
    kind: 'engine',
    run: (stmt, params, options) => db.queryPlanAsync(stmt, params, options),
    callPlugin: (plugin, method, args) => db.callPlugin(plugin, method, args),
    async transaction(fn) {
      // Nested transactions become savepoints, so a step can roll back alone.
      const nested = db.inTransaction;
      const name = `smaltts_${Math.random().toString(36).slice(2)}`;
      await db.queryPlanAsync(nested ? { kind: 'transaction', action: 'savepoint', name } : { kind: 'transaction', action: 'begin', mode: 'immediate' });
      try {
        const out = await fn(backend);
        await db.queryPlanAsync(nested ? { kind: 'transaction', action: 'release', name } : { kind: 'transaction', action: 'commit' });
        return out;
      } catch (e) {
        if (nested) {
          await db.queryPlanAsync({ kind: 'transaction', action: 'rollback', savepoint: name });
          await db.queryPlanAsync({ kind: 'transaction', action: 'release', name });
        } else if (db.inTransaction) await db.queryPlanAsync({ kind: 'transaction', action: 'rollback' });
        throw e;
      }
    },
  };
  return backend;
}

export function clientBackend(db: ClientDatabase): Backend {
  const over = (q: ClientQueryable, inTx: boolean): Backend => ({
    kind: 'client',
    async run(stmt, params, options) {
      const rows = (await q.queryPlan(stmt, params, { rowMode: 'array', ...(options?.signal ? { signal: options.signal } : {}) })) as Value[][] & { columns: string[] };
      return { columns: rows.columns, rows };
    },
    callPlugin: (plugin, method, args) => db.callPlugin(plugin, method, args),
    // The client serializes transactions per connection; inside one, a nested call runs in the same transaction.
    transaction: (fn) => (inTx ? fn(over(q, true)) : db.transaction((tx) => fn(over(tx, true)))),
  });
  return over(db, false);
}

/** A backend for either kind of database. */
export function backendOf(db: EngineDatabase | ClientDatabase | Backend): Backend {
  if ('run' in db && 'kind' in db) return db;
  if ('queryPlanAsync' in db) return engineBackend(db);
  return clientBackend(db);
}
