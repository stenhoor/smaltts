/**
 * Milestone 10: smaltts through smaltdb's client, the engine in a worker running smaltts's worker entry
 * (`@smaltworks/smaltts/worker`), gives what it gives in process. In Node the worker is a worker thread
 * (test/helpers/client.ts); `npm run test:browser` runs the same scenarios in each browser.
 */
import { afterAll, beforeAll, describe as group, expect, test } from 'vitest';
import { Database } from 'smaltdb/engine';
import { attach } from '../src/index.js';
import { registerSmaltts } from '../src/language.js';
import { openThroughWorker } from './helpers/client.js';
import { scenarios } from './scenarios.js';

beforeAll(() => registerSmaltts());

const open: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const db of open.splice(0)) await db.close();
});

group('in process and through the worker, the same results', () => {
  for (const s of scenarios) {
    test(s.name, async () => {
      const inProcess = await s.run(attach(Database.openMemory()));
      const client = await openThroughWorker();
      open.push(client);
      const throughWorker = await s.run(attach(client));
      expect(throughWorker).toEqual(inProcess);
    }, 30_000);
  }
});
