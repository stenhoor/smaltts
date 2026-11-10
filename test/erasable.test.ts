/** smaltts's source is erasable TypeScript: smaltty strips every file (no enum, namespace or parameter properties). */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { strip } from 'smaltty';
import { expect, test } from 'vitest';

const src = fileURLToPath(new URL('../src', import.meta.url));

for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
  test(`src/${file} strips with smaltty`, () => {
    const code = readFileSync(join(src, file), 'utf8');
    expect(strip(code, { fileName: `src/${file}` }).length).toBe(code.length);
  });
}

test('only the language entry point imports the engine; the rest imports smaltdb/plan alone', () => {
  const engine = /from 'smaltdb(\/engine|\/language)?'/;
  const offenders = readdirSync(src)
    .filter((f) => f.endsWith('.ts') && f !== 'language.ts')
    .filter((f) => readFileSync(join(src, f), 'utf8').split('\n').some((line) => engine.test(line) && !/^import type /.test(line)));
  expect(offenders).toEqual([]);
});
