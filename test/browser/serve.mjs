// The browser tests' server (milestone 10): smaltts's TypeScript as JavaScript, stripped by smaltty when it is asked
// for (an import of `./x.js` finds `./x.ts`, as the source writes it), and the packed smaltdb build, with no bundler.
// Bare imports of smaltdb are rewritten to its files: a module worker can't use the page's import map in every browser.
// Cross-origin isolated, as smaltdb's worker would be in an app.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strip } from 'smaltty';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SMALTDB = {
  smaltdb: '/node_modules/smaltdb/dist/smaltdb.js',
  'smaltdb/plan': '/node_modules/smaltdb/dist/plan.js',
  'smaltdb/engine': '/node_modules/smaltdb/dist/engine.js',
  'smaltdb/language': '/node_modules/smaltdb/dist/language.js',
  'smaltdb/worker-runtime': '/node_modules/smaltdb/dist/worker-runtime.js',
};
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.map': 'application/json' };

/** `code` with its bare imports of smaltdb pointed at its files; any other bare import is an error. */
function rewrite(code, file) {
  // Import and export statements only, at the start of a line: not the examples in comments.
  return code.replace(/^(\s*(?:import|export)\b[^'";]*?\bfrom\s*|\s*import\s*)(['"])([^'"./][^'"]*)\2/gm, (all, lead, q, spec) => {
    const to = SMALTDB[spec];
    if (!to) throw new Error(`${file}: the browser tests serve no module for ${spec}`);
    return `${lead}${q}${to}${q}`;
  });
}

/** The file a path names: itself, or the TypeScript it stands for. */
function resolveFile(path) {
  const file = normalize(join(root, decodeURIComponent(path)));
  if (!file.startsWith(root)) return undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (file.endsWith('.js') && existsSync(file.slice(0, -3) + '.ts')) return file.slice(0, -3) + '.ts';
  return undefined;
}

export function serve(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = resolveFile(path === '/' ? '/test/browser/page.html' : path);
    if (!file) {
      res.writeHead(404).end(`no ${path}`);
      return;
    }
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    try {
      if (file.endsWith('.ts')) {
        const code = rewrite(strip(readFileSync(file, 'utf8'), { fileName: file }), file);
        res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(code);
      } else res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await serve(Number(process.env.PORT ?? 8095));
  console.log(`http://127.0.0.1:${server.address().port}/`);
}
