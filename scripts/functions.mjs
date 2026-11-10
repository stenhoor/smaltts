// Writes src/functions.ts from the engine's catalog (db.catalog.functions()): the names, kinds, result types and
// argument counts of every function, and which are the engine's own operations. Run it when test/functions.test.ts
// fails because the engine's list changed: node scripts/functions.mjs
import { writeFileSync } from 'node:fs';
import { Database } from 'smaltdb/engine';

const fns = Database.openMemory().catalog.functions().slice().sort((a, b) => (a.name < b.name ? -1 : 1));
const key = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name));
const scalar = fns.filter((f) => f.kind === 'scalar');
const aggregate = fns.filter((f) => f.kind !== 'scalar');

const out = `/**
 * The engine's functions and operations, by their engine names, with their result types when nothing is known of
 * the arguments: what \`fn\` and \`agg\` offer and how they are typed. Generated from the engine's catalog
 * (\`db.catalog.functions()\`) by scripts/functions.mjs; test/functions.test.ts fails when the engine's list changes.
 */

/** Scalar functions and operations (\`fn.<name>\`). */
export const SCALAR = {
${scalar.map((f) => `  ${key(f.name)}: '${f.result}',`).join('\n')}
} as const;

/** Aggregate and window functions (\`agg.<name>\`): aggregates in \`aggregate\`, \`pivot\` and \`window\`, window functions in \`window\`. */
export const AGGREGATE = {
${aggregate.map((f) => `  ${key(f.name)}: { kind: '${f.kind}', result: '${f.result}' },`).join('\n')}
} as const;

/** How many arguments each function takes: [fewest, most], most \`null\` for any number. */
export const ARITY: { readonly [name: string]: readonly [number, number | null] } = {
${fns.map((f) => `  ${key(f.name)}: [${f.minArgs}, ${f.maxArgs ?? 'null'}],`).join('\n')}
};

/** The engine's own operations (ADR 0016 section 1), as opposed to named functions: src/signatures.ts types each. */
export const OPERATIONS = [
${scalar.filter((f) => f.operation).map((f) => `  '${f.name}',`).join('\n')}
] as const;

export type ScalarName = keyof typeof SCALAR;
export type OperationName = (typeof OPERATIONS)[number];
export type AggregateName = { [K in keyof typeof AGGREGATE]: (typeof AGGREGATE)[K]['kind'] extends 'aggregate' ? K : never }[keyof typeof AGGREGATE];
export type WindowName = keyof typeof AGGREGATE;
`;
writeFileSync(new URL('../src/functions.ts', import.meta.url), out);
console.log(`src/functions.ts: ${scalar.length} scalar, ${aggregate.length} aggregate and window functions`);
