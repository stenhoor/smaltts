import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run smaltdb from the source in its packed build (node_modules/smaltdb/src, installed by
// scripts/fetch-packed.mjs), so tests can also reach its internals as `smaltdb-src/...` (the worker protocol, the
// engine server) with one copy of every class.
const core = (path: string): string => fileURLToPath(new URL(`./node_modules/smaltdb/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^smaltdb$/, replacement: core('client/index.ts') },
      { find: /^smaltdb\/engine$/, replacement: core('engine/index.ts') },
      { find: /^@smaltworks\/smaltts$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
      { find: /^smaltdb\/plan$/, replacement: core('engine/plan/portable.ts') },
      { find: /^smaltdb\/language$/, replacement: core('engine/language-support.ts') },
      { find: /^smaltdb\/worker-runtime$/, replacement: core('engine/worker-runtime.ts') },
      { find: /^smaltdb-src\/(.*)\.js$/, replacement: core('$1.ts') },
    ],
  },
  server: { deps: { inline: [/node_modules\/smaltdb\//] } },
  test: { include: ['test/**/*.test.ts'] },
});
