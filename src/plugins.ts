/**
 * Plugins and external data (milestone 9; DESIGN.md section 14, decision 14).
 *
 * - **Connections and external tables are specs**, diffed and applied like tables (`SchemaSpec.connections`,
 *   `SchemaSpec.externals`). Their options are the engine's (`createConnection`, `createExternalTable`); what each
 *   option means is the plugin's (`@smaltdb/external` for connections and file locations, a format plugin for a format).
 * - **Plugins are typed by descriptors**: a descriptor names a plugin, the methods `db.plugin(descriptor).call` takes,
 *   and its table functions, each a typed relation. smaltts has no dependency on any plugin: a descriptor is data and
 *   types, written by the plugin (or by hand), and the engine runs the plugin.
 */
import { type ColumnType, type Rel, tableFunction } from './rel.js';
import { type ColumnSpec, type Columns, type RowOf, type Value, table } from './spec.js';

/** A connection: a name and the engine's options for it (`type`, `url`, `credentials` and the type's own). */
export interface ConnectionSpec {
  readonly name: string;
  readonly options: Readonly<Record<string, Value>>;
}

/** An external table: its columns (empty: read from the source when it is created) and its options. */
export interface ExternalTableSpec<Row = Record<string, Value>> {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  /** `location`, `format`, `connection` and the format's own options. */
  readonly options: Readonly<Record<string, Value>>;
  /** Type only: the rows the table gives. */
  readonly $row?: Row;
}

/** Options of a connection: the engine's, plus whatever its type takes. */
export type ConnectionOptions = { readonly type?: string; readonly url?: string; readonly credentials?: string } & Readonly<Record<string, Value | undefined>>;

/** Options of an external table: its location and format, the connection it reads through, and the format's own. */
export type ExternalTableOptions = { readonly location: string; readonly format?: string; readonly connection?: string | ConnectionSpec } & Readonly<Record<string, Value | ConnectionSpec | undefined>>;

/** Undefined options left out, a connection given as its spec named. */
function plainOptions(options: Readonly<Record<string, Value | ConnectionSpec | undefined>>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'object' && v !== null && 'options' in v && 'name' in v ? (v as ConnectionSpec).name : (v as Value);
  }
  return out;
}

/** A connection spec: `connection('lake', { type: 'https', url: 'https://data.example.org/' })`. */
export function connection(name: string, options: ConnectionOptions): ConnectionSpec {
  return { name, options: plainOptions(options) };
}

/**
 * An external table spec: `externalTable('sales', { location: 'file:sales.parquet' }, { day: date(), total: real() })`.
 * Without columns, the engine reads them from the source when the table is created, and they are typed `any` here.
 */
export function externalTable<const C extends Columns = Record<never, never>>(name: string, options: ExternalTableOptions, columns?: C): ExternalTableSpec<RowOf<C>> {
  return { name, columns: columns ? table(name, columns).columns : [], options: plainOptions(options) };
}

// ---------------------------------------------------------------------------------------------------------------
// Typed plugin descriptors.

/** A plugin's methods, as `db.plugin(descriptor).call` takes them: each a function of its arguments to its result. */
export type PluginMethods = Record<string, (...args: never[]) => unknown>;

/** A table function of a descriptor: its arguments (a location, …), the columns it gives, and named options. */
export type DescribedTableFunction = <const C extends Columns>(args: Value | readonly Value[], columns: C, named?: Readonly<Record<string, Value>>) => Rel<RowOf<C>>;

/** A plugin, described for smaltts: its name, its methods (types) and its table functions. */
export interface PluginDescriptor<M extends PluginMethods = PluginMethods, F extends string = string> {
  readonly name: string;
  /** Type only: the methods `db.plugin(this).call` takes. */
  readonly methods?: M;
  /** Its table functions, each giving a typed relation. */
  readonly tableFunctions: { readonly [K in F]: DescribedTableFunction };
}

/** Type only: a plugin's methods, for `definePlugin({ methods: methods<{ … }>() })`. */
export const methods = <M extends PluginMethods>(): M => undefined as unknown as M;

/**
 * A plugin descriptor. `definePlugin({ name: '@smaltdb/parquet', tableFunctions: ['read_parquet'] })` gives
 * `parquet.tableFunctions.read_parquet('file:x.parquet', { day: date(), total: real() })`, a typed relation; with
 * `methods: methods<{ importCSV(table: string, csv: string): { rows: number } }>()`, `db.plugin(io).call('importCSV', …)`
 * is typed by it.
 */
export function definePlugin<M extends PluginMethods = PluginMethods, const F extends string = never>(descriptor: { readonly name: string; readonly methods?: M; readonly tableFunctions?: readonly F[] }): PluginDescriptor<M, F> {
  const fns = {} as Record<F, DescribedTableFunction>;
  for (const name of descriptor.tableFunctions ?? []) {
    fns[name] = ((args, columns, named) => {
      const types: ColumnType[] = table(name, columns).columns.map((c) => ({ name: c.name, type: c.type, ...(c.planType ? { planType: c.planType } : {}) }));
      return tableFunction(name, Array.isArray(args) ? args : [args as Value], types, named ? { ...named } : undefined);
    }) as DescribedTableFunction;
  }
  return { name: descriptor.name, ...(descriptor.methods ? { methods: descriptor.methods } : {}), tableFunctions: fns };
}

/** A plugin's methods, called through the engine: typed by its descriptor. */
export interface PluginCalls<M extends PluginMethods> {
  call<K extends keyof M & string>(method: K, ...args: Parameters<M[K]>): Promise<Awaited<ReturnType<M[K]>>>;
}
