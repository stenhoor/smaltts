// A Node worker thread dressed as a dedicated Web Worker, as far as smaltdb's worker runtime uses one: `self`,
// `postMessage` and message events. It runs `test/helpers/worker-entry.ts`, smaltts's worker entry, through smaltty.
import { register } from 'node:module';
import { parentPort } from 'node:worker_threads';

register('./strip-hooks.mjs', import.meta.url);

const listeners = new Set();
const early = [];
let started = false;
const deliver = (data) => {
  const event = { data };
  globalThis.onmessage?.(event);
  for (const l of listeners) l(event);
};
globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
globalThis.addEventListener = (type, listener) => void (type === 'message' && listeners.add(listener));
globalThis.removeEventListener = (type, listener) => void (type === 'message' && listeners.delete(listener));
parentPort.on('message', (data) => (started ? deliver(data) : early.push(data)));

await import('./worker-entry.ts');
started = true;
for (const data of early.splice(0)) deliver(data);
