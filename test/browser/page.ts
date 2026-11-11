// The browser tests' page (milestone 10): each scenario in process (the engine in this page) and through smaltdb's
// client (the engine in a Web Worker running smaltts's worker entry); the results must be the same.
import { Database } from 'smaltdb/engine';
import { open } from 'smaltdb';
import { attach } from '../../src/index.js';
import { registerSmaltts } from '../../src/language.js';
import { scenarios } from '../scenarios.js';

/** A value as comparable text: dates as ISO text, bytes as arrays, big integers as text. */
const text = (v: unknown): string =>
  JSON.stringify(v, function (this: Record<string, unknown>, k, x) {
    const raw = this[k];
    if (raw instanceof Date) return { date: raw.toISOString() };
    if (raw instanceof Uint8Array) return { bytes: [...raw] };
    return typeof x === 'bigint' ? { bigint: String(x) } : x;
  });

interface Outcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

async function run(): Promise<Outcome[]> {
  registerSmaltts();
  const out: Outcome[] = [];
  for (const s of scenarios) {
    try {
      const inProcess = text(await s.run(attach(Database.openMemory())));
      const client = await open(':memory:', { storage: 'memory', multiTab: false, worker: () => new Worker('/test/browser/worker.js', { type: 'module', name: 'smaltdb' }) });
      try {
        const throughWorker = text(await s.run(attach(client)));
        out.push(inProcess === throughWorker ? { name: s.name, ok: true } : { name: s.name, ok: false, detail: `in process ${inProcess}\nthrough the worker ${throughWorker}` });
      } finally {
        await client.close();
      }
    } catch (e) {
      out.push({ name: s.name, ok: false, detail: String((e as Error).stack ?? e) });
    }
  }
  return out;
}

(globalThis as { results?: Promise<Outcome[]> }).results = run();
