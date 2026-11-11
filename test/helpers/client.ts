/**
 * smaltdb's client in Node, its engine in a worker thread running smaltts's worker entry (test/helpers/node-worker.mjs):
 * messages are structured-cloned between threads, as between a page and its worker.
 */
import { Worker as NodeWorker } from 'node:worker_threads';
import { open } from 'smaltdb';

/** A Web Worker's interface over a Node worker thread. */
class ThreadWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private readonly thread = new NodeWorker(new URL('./node-worker.mjs', import.meta.url));
  constructor() {
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (e) => this.onerror?.(e));
  }
  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    this.thread.postMessage(message, transfer as never);
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    if (type === 'message') this.thread.on('message', (data) => listener({ data }));
  }
  removeEventListener(): void {}
  terminate(): void {
    void this.thread.terminate();
  }
}

// The client tells a Worker from a URL with `instanceof Worker`: Node has no Worker global, so this one stands in.
(globalThis as { Worker?: unknown }).Worker ??= ThreadWorker;

/** A memory database through the client, its engine in a worker thread. */
export function openThroughWorker() {
  return open(':memory:', { storage: 'memory', multiTab: false, worker: new ThreadWorker() as unknown as Worker });
}
