/**
 * Views' relations, edited as the engine asks when ALTER TABLE renames a table or a column they read (DESIGN.md
 * section 8.1), and the tables they read. Pure functions of the relation's JSON: the language (language.ts) calls them
 * with the view's source, and the differ (changes.ts) with the views it checks.
 *
 * A column rename follows the column, not its name. Each operation's output says which of its names come from the
 * renamed table's column: a scan of the table gives the column; filters, sorts and the like pass their input's names
 * through; a join passes both sides' (the right side's under its prefix); a name an operation gives itself (`select`,
 * `pick`, an aggregate's keys) is the view's own, and keeps its name. A reference is renamed only when it reads one of
 * the names its scope gets from the column, so a column of the same name in another table is never touched.
 */
import type { ExprNode, RelNode } from './rel.js';

/** The names of a scope that come from the renamed column: lower-cased old name to new name. */
type Names = ReadonlyMap<string, string>;
const none: Names = new Map();

interface Ctx {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  /** The scopes of the operations a subquery is nested in, innermost first. */
  readonly outer: readonly Names[];
  /** The open `iterate`s' names, by name. */
  readonly working: ReadonlyMap<string, Names>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const rename = (names: Names, name: string): string => names.get(name.toLowerCase()) ?? name;

/** `rel` with every reference to column `from` of `table` renamed `to`. Names the view gives itself keep theirs. */
export function renameColumnIn(rel: RelNode, table: string, from: string, to: string): RelNode {
  return edit(rel, { table, from, to, outer: [], working: new Map() }).node;
}

/** `rel` reading table `from` as `to`. */
export function renameTableIn(rel: RelNode, from: string, to: string): RelNode {
  return mapScans(rel, (n) => (same(n.table, from) ? { ...n, table: to } : n));
}

/** The tables and views `rel` reads, in subqueries and recursion too: each once, in the order first read. */
export function tablesOf(rel: RelNode): string[] {
  const out: string[] = [];
  mapScans(rel, (n) => {
    if (!out.some((t) => same(t, n.table))) out.push(n.table);
    return n;
  });
  return out;
}

/** Every `scan` in the JSON, wherever it is (inputs, join sides, subqueries in expressions), through `f`. */
function mapScans<T>(v: T, f: (n: Extract<RelNode, { r: 'scan' }>) => RelNode): T {
  if (Array.isArray(v)) return v.map((x) => mapScans(x, f)) as T;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  const o = v as Record<string, unknown>;
  if (o.r === 'scan') return f(o as never) as T;
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, mapScans(x, f)])) as T;
}

function edit(n: RelNode, ctx: Ctx): { node: RelNode; out: Names } {
  /** An expression over scopes `scopes` (the operation's inputs' names; a correlated reference reads `outer`). */
  const ex = (e: ExprNode, scopes: readonly Names[]): ExprNode => {
    const go = (x: ExprNode): ExprNode => {
      switch (x.k) {
        case 'col': {
          const at = x.outer ? ctx.outer[x.outer - 1] : undefined;
          const names = x.outer ? (at ?? none) : merged(scopes);
          const name = rename(names, x.name);
          return name === x.name ? x : { ...x, name };
        }
        case 'fn':
        case 'and':
        case 'or':
          return { ...x, args: x.args.map(go) };
        case 'agg':
          return { ...x, args: x.args.map(go), ...(x.filter ? { filter: go(x.filter) } : {}) };
        case 'not':
        case 'isNull':
          return { ...x, arg: go(x.arg) };
        case 'case':
          return { ...x, whens: x.whens.map((w) => ({ when: go(w.when), then: go(w.then) })), ...(x.else ? { else: go(x.else) } : {}) };
        case 'exists':
        case 'scalar':
          return { ...x, rel: edit(x.rel, { ...ctx, outer: [merged(scopes), ...ctx.outer] }).node };
        case 'inRel':
          return { ...x, probe: go(x.probe), rel: edit(x.rel, { ...ctx, outer: [merged(scopes), ...ctx.outer] }).node };
        default:
          return x;
      }
    };
    return go(e);
  };
  const fields = (fs: readonly (readonly [string, ExprNode])[], scope: Names) => fs.map(([k, v]) => [k, ex(v, [scope])] as const);
  const amount = <A>(a: A): A => (a && typeof a === 'object' ? (ex(a as ExprNode, []) as A) : a);

  switch (n.r) {
    case 'scan':
      return { node: n, out: same(n.table, ctx.table) ? new Map([[ctx.from.toLowerCase(), ctx.to]]) : none };
    case 'values':
    case 'columns':
    case 'function':
      return { node: n, out: none };
    case 'working':
      return { node: n, out: ctx.working.get(n.name.toLowerCase()) ?? none };
    case 'filter': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, pred: ex(n.pred, [i.out]) }, out: i.out };
    }
    case 'select': {
      const i = edit(n.input, ctx);
      const star = n.fields[0]?.[0] === '*';
      const node = { ...n, input: i.node, fields: star ? [n.fields[0]!, ...fields(n.fields.slice(1), i.out)] : fields(n.fields, i.out) };
      if (!star) return { node, out: none };
      // `extend` passes its input's columns through, except those it computes again.
      const computed = new Set(n.fields.slice(1).map(([k]) => k.toLowerCase()));
      return { node, out: new Map([...i.out].filter(([from]) => !computed.has(from))) };
    }
    case 'join': {
      const l = edit(n.left, ctx);
      const r = edit(n.right, ctx);
      const px = n.prefix ?? '';
      const right: Names = new Map([...r.out].map(([from, to]) => [(px + from).toLowerCase(), px + to]));
      const both = merged([l.out, right]);
      const asof = n.asof ? { ...n.asof, left: ex(n.asof.left, [both]), right: ex(n.asof.right, [both]), ...(n.asof.tolerance ? { tolerance: ex(n.asof.tolerance, []) } : {}) } : undefined;
      const node = { ...n, left: l.node, right: r.node, ...(n.on ? { on: ex(n.on, [both]) } : {}), ...(asof ? { asof } : {}) };
      return { node, out: n.kind === 'semi' || n.kind === 'anti' ? l.out : both };
    }
    case 'aggregate': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, keys: fields(n.keys, i.out), aggs: fields(n.aggs, i.out) }, out: none };
    }
    case 'sort': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, keys: n.keys.map((k) => ({ ...k, expr: ex(k.expr, [i.out]) })) }, out: i.out };
    }
    case 'limit': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, count: amount(n.count), ...(n.offset !== undefined ? { offset: amount(n.offset) } : {}) }, out: i.out };
    }
    case 'distinct': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, ...(n.on ? { on: n.on.map((c) => rename(i.out, c)) } : {}) }, out: i.out };
    }
    case 'union':
    case 'setop': {
      const a = edit(n.inputs[0], ctx);
      const b = edit(n.inputs[1], ctx);
      return { node: { ...n, inputs: [a.node, b.node] }, out: a.out };
    }
    case 'sample': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, ...(n.count !== undefined ? { count: amount(n.count) } : {}), ...(n.fraction !== undefined ? { fraction: amount(n.fraction) } : {}) }, out: i.out };
    }
    case 'explode': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, column: rename(i.out, n.column) }, out: i.out };
    }
    case 'pivot': {
      const i = edit(n.input, ctx);
      return { node: { ...n, input: i.node, keys: fields(n.keys, i.out), on: ex(n.on, [i.out]), aggs: fields(n.aggs, i.out) }, out: none };
    }
    case 'unpivot': {
      const i = edit(n.input, ctx);
      const columns = n.columns.map((c) => rename(i.out, c));
      const keep = n.keep?.map((c) => rename(i.out, c));
      // The kept columns pass through; the unpivoted ones become values of the name column.
      const unpivoted = new Set(n.columns.map((c) => c.toLowerCase()));
      const kept = n.keep ? new Set(n.keep.map((c) => c.toLowerCase())) : undefined;
      const out = new Map([...i.out].filter(([from]) => (kept ? kept.has(from) : !unpivoted.has(from))));
      return { node: { ...n, input: i.node, columns, ...(keep ? { keep } : {}) }, out };
    }
    case 'window': {
      const i = edit(n.input, ctx);
      const node = {
        ...n,
        input: i.node,
        partition: n.partition.map((c) => rename(i.out, c)),
        order: n.order.map((k) => ({ ...k, expr: ex(k.expr, [i.out]) })),
        calls: fields(n.calls, i.out),
      };
      const computed = new Set(n.calls.map(([k]) => k.toLowerCase()));
      return { node, out: new Map([...i.out].filter(([from]) => !computed.has(from))) };
    }
    case 'iterate': {
      const init = edit(n.init, ctx);
      const step = edit(n.step, { ...ctx, working: new Map(ctx.working).set(n.name.toLowerCase(), init.out) });
      return { node: { ...n, init: init.node, step: step.node }, out: init.out };
    }
  }
}

/** The names of several scopes read together (a join's sides). */
function merged(scopes: readonly Names[]): Names {
  if (scopes.length === 1) return scopes[0]!;
  return new Map(scopes.flatMap((s) => [...s]));
}
