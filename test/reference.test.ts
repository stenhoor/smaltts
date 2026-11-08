/**
 * The API reference is the specification: every TypeScript example in docs/REFERENCE.md (and the guide) typechecks
 * against src/, except those marked `<!-- spec:planned -->` (API that is specified but not built yet).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const PAGES = ['docs/REFERENCE.md', 'docs/guide/getting-started.md'];

interface Example { page: string; code: string; line: number; planned: boolean }

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
    const planned = lines.slice(Math.max(0, i - 2), i).some((l) => l.trim() === '<!-- spec:planned -->');
    out.push({ page, code: lines.slice(start, end).join('\n'), line: start + 1, planned });
    i = end;
  }
  return out;
}

test('the reference has examples, and marks the planned ones', () => {
  const all = examples();
  expect(all.length).toBeGreaterThan(5);
  expect(all.some((e) => e.planned)).toBe(true);
});

test('every example of built API typechecks against src/', () => {
  const dir = join(root, 'test/.reference');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = examples()
    .filter((e) => !e.planned)
    .map((e, i) => {
      const file = join(dir, `example-${i}.ts`);
      writeFileSync(file, `${e.code}\nexport {};\n`);
      return { file, page: e.page, line: e.line };
    });
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(files.map((f) => f.file), { ...parsed.options, noEmit: true });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && d.file.fileName.includes('/test/.reference/'))
    .map((d) => {
      const at = files.find((f) => f.file === d.file!.fileName)!;
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${at.page}:${at.line + line}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
}, 60_000);
