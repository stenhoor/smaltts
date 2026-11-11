// `npm run test:browser`: the scenarios (test/scenarios.ts) in each browser, in process and through the worker client,
// with the same results (milestone 10). Playwright is resolved globally, as smaltdb's browser tests resolve it (the
// owner's yes, 2026-11-11): CI installs it in Playwright's image; locally the pre-installed copy is used.
// BROWSERS=chromium,firefox,webkit picks the browsers (default: chromium).
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium, firefox, webkit } = createRequire(import.meta.url)('playwright');
const ENGINES = { chromium, firefox, webkit };
const browsers = (process.env.BROWSERS ?? 'chromium').split(',').map((b) => b.trim()).filter(Boolean);

const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/`;
let failed = 0;
try {
  for (const name of browsers) {
    const engine = ENGINES[name];
    if (!engine) throw new Error(`unknown browser ${name}`);
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      const results = await page.waitForFunction(() => globalThis.results, undefined, { timeout: 120_000 }).then(() => page.evaluate(() => globalThis.results));
      for (const r of results) {
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name}: ${r.name}`);
        if (!r.ok) {
          failed++;
          console.log(r.detail);
        }
      }
      if (results.length === 0) failed++;
      for (const e of errors) console.log(`page error in ${name}: ${e}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
