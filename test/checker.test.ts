/**
 * Static checks, with smaltty's checker (owner's decision, 2026-11-10: smaltts's TypeScript tooling is smaltty's, no
 * `typescript`). The checker reads smaltts's source for its types and checks calls into it: unknown properties and
 * column names, argument counts and types, option keys and values. Anything it doesn't model is unknown and quiet, and
 * smaltty's own tests compare it with tsc, so an error here is one tsc reports too.
 *
 * - The tests and the reference's examples have no errors.
 * - Every `// @ts-expect-error` in the tests (the compile-time tests) is found: the error it expects is reported.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { check, expectations } from 'smaltty';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = new Map<string, string>();
const read = (dir: string) => {
  for (const f of readdirSync(join(root, dir)).sort()) if (f.endsWith('.ts')) files.set(`/${dir}/${f}`, readFileSync(join(root, dir, f), 'utf8'));
};
read('src');
read('test');
// The reference's and guide's examples, as reference.test.ts runs them (planned ones aside).
for (const page of ['docs/REFERENCE.md', 'docs/guide/getting-started.md']) {
  const lines = readFileSync(join(root, page), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '```ts') continue;
    let end = i + 1;
    while (lines[end] !== '```') end++;
    const planned = lines.slice(Math.max(0, i - 2), i).some((l) => l.trim() === '<!-- spec:planned -->');
    if (!planned) files.set(`/examples/${page.replace(/\W/g, '-')}-${i + 2}.ts`, lines.slice(i + 1, end).join('\n'));
    i = end;
  }
}
const packages = { '@smaltworks/smaltts': '/src/index.ts', '@smaltworks/smaltts/language': '/src/language.ts' };
const roots = [...files.keys()].filter((f) => !f.startsWith('/src/'));

test('the tests and the reference examples have no errors', () => {
  const errors = check(files, { roots, packages }).map((d) => {
    const line = files.get(d.file)!.slice(0, d.start).split('\n').length;
    return `${d.file}:${line} ${d.code} ${d.message}`;
  });
  expect(errors).toEqual([]);
  expect(roots.length).toBeGreaterThan(10);
});

test('every compile-time test (a @ts-expect-error) is found', () => {
  const found = expectations(files, { roots, packages });
  expect(found.filter((e) => !e.found).map((e) => `${e.file}:${e.line}`)).toEqual([]);
  expect(found.length).toBeGreaterThanOrEqual(3);
});
