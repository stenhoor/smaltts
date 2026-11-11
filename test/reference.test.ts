/**
 * The API reference is the specification: every TypeScript example in docs/REFERENCE.md and the guide must strip with
 * smaltty (erasable TypeScript, as smaltui and smaltnb run it) and then run against the in-process engine. Examples of
 * API that is specified but not built yet are marked `<!-- spec:planned -->` and skipped. Examples that run in a page (a
 * Web Worker) are marked `<!-- spec:browser -->`: they strip here, and `npm run test:browser` runs what they do.
 *
 * Static type checks of the examples return when smaltty's checker covers smaltts (docs/MILESTONES.md).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { strip } from 'smaltty';
import { afterAll, expect, test, vi } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const PAGES = ['docs/REFERENCE.md', 'docs/guide/getting-started.md'];
const dir = join(root, 'test/.reference');

interface Example { page: string; code: string; line: number; planned: boolean; browser: boolean }

/** The ```ts blocks of the pages, with whether each is marked planned. */
function examples(): Example[] {
  return PAGES.flatMap((page) => examplesOf(page));
}

function examplesOf(page: string): Example[] {
  const out: Example[] = [];
  const lines = readFileSync(join(root, page), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '```ts') continue;
    const start = i + 1;
    let end = start;
    while (lines[end] !== '```') end++;
    const marks = lines.slice(Math.max(0, i - 2), i).map((l) => l.trim());
    out.push({ page, code: lines.slice(start, end).join('\n'), line: start + 1, planned: marks.includes('<!-- spec:planned -->'), browser: marks.includes('<!-- spec:browser -->') });
    i = end;
  }
  return out;
}

test('the reference has examples, and marks the planned ones', () => {
  const all = examples();
  expect(all.length).toBeGreaterThan(5);
  expect(all.some((e) => e.planned)).toBe(true);
});

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const [i, e] of examples().entries()) {
  if (e.planned) continue;
  if (e.browser) {
    test(`${e.page}:${e.line} strips with smaltty (it runs in a page: npm run test:browser)`, () => {
      expect(strip(e.code, { fileName: `${e.page}:${e.line}` }).length).toBe(e.code.length);
    });
    continue;
  }
  test(`${e.page}:${e.line} strips with smaltty and runs`, async () => {
    // smaltty rejects what isn't erasable TypeScript, with the line and column.
    const js = strip(e.code, { fileName: `${e.page}:${e.line}` });
    const file = join(dir, `example-${i}.js`);
    writeFileSync(file, `${js}\nexport {};\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await import(/* @vite-ignore */ pathToFileURL(file).href);
    } finally {
      log.mockRestore();
    }
  });
}
