// Module hooks for a worker thread that runs smaltts's TypeScript: `.ts` files are stripped by smaltty (smaltts's
// TypeScript tooling, owner's decision 2026-11-10), and an import of `./x.js` finds `./x.ts`, as the source writes it.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strip } from 'smaltty';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/')) && context.parentURL?.startsWith('file:')) {
    const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (!existsSync(fileURLToPath(new URL(specifier, context.parentURL))) && existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const code = await readFile(fileURLToPath(url), 'utf8');
  return { format: 'module', source: strip(code, { fileName: fileURLToPath(url) }), shortCircuit: true };
}
