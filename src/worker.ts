/**
 * The worker entry (`@smaltworks/smaltts/worker`): smaltdb's engine worker with smaltts's language registered, so the
 * engine can bind smaltts views wherever it runs (milestone 10). A page reaches it through smaltdb's client (`open`),
 * and smaltts through `attach(db)`:
 *
 *     // db-worker.ts
 *     import { defineSmalttsWorker } from '@smaltworks/smaltts/worker';
 *     defineSmalttsWorker({ plugins: [parquet] });
 *
 *     // the page
 *     const db = attach(await open('app.db', { worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }) }));
 *
 * It imports the engine (`smaltdb/worker-runtime`), as the language entry does: the main entry point doesn't.
 */
import { defineWorker } from 'smaltdb/worker-runtime';
import { smalttsLanguage } from './language.js';

/** What `defineWorker` takes: languages and plugins to install, and parallel readers. */
export type SmalttsWorkerOptions = NonNullable<Parameters<typeof defineWorker>[0]>;

/** Start smaltdb's engine worker with smaltts's language registered, and these other languages and plugins. */
export function defineSmalttsWorker(options: SmalttsWorkerOptions = {}): void {
  defineWorker({ ...options, languages: [smalttsLanguage, ...(options.languages ?? []).filter((l) => l.name !== smalttsLanguage.name)] });
}
