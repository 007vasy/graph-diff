import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { FnNode } from '../types.js';
import { extractFile } from './index.js';

export interface ParseItem {
  path: string;
  source: string;
  /** keep function source text (needed only for files in the diff) */
  keepCode: boolean;
}

export async function extractItem(it: ParseItem): Promise<FnNode[] | null> {
  try {
    const fns = await extractFile(it.path, it.source);
    if (fns && !it.keepCode) for (const f of fns) f.code = '';
    return fns;
  } catch {
    return null;
  }
}
type Result = FnNode[] | null;

const IN_PROCESS_BELOW = 250; // worker startup (~100ms incl. WASM) isn't worth it for small batches
const CHUNK = 48;
const MAX_WORKERS = Math.max(1, Math.min(Number(process.env.GRAPH_DIFF_WORKERS) || 8, availableParallelism() - 1));

interface PoolWorker {
  w: Worker;
}
let pool: PoolWorker[] = [];

function spawnWorker(): PoolWorker {
  const w = new Worker(new URL('./worker.js', import.meta.url));
  w.unref();
  return { w };
}

/** Parse many files, fanning out over worker threads for large batches. Result order matches input. */
export async function extractMany(items: ParseItem[], onProgress?: (done: number) => void): Promise<Result[]> {
  const results: Result[] = new Array(items.length).fill(null);
  if (items.length < IN_PROCESS_BELOW || MAX_WORKERS < 2) {
    for (let i = 0; i < items.length; i++) {
      results[i] = await extractItem(items[i]);
      if (i % 500 === 499) onProgress?.(i + 1);
    }
    return results;
  }

  const want = Math.min(MAX_WORKERS, Math.ceil(items.length / (CHUNK * 2)));
  while (pool.length < want) pool.push(spawnWorker());
  const workers = pool.slice(0, want);

  let next = 0;
  let done = 0;
  await Promise.all(
    workers.map(
      (pw) =>
        new Promise<void>((resolve, reject) => {
          const send = () => {
            if (next >= items.length) {
              pw.w.off('message', onMsg);
              pw.w.off('error', onErr);
              pw.w.unref();
              return resolve();
            }
            const start = next;
            next = Math.min(items.length, next + CHUNK);
            pw.w.postMessage({ start, items: items.slice(start, next) });
          };
          const onMsg = (m: { start: number; results: Result[] }) => {
            for (let i = 0; i < m.results.length; i++) results[m.start + i] = m.results[i];
            done += m.results.length;
            onProgress?.(done);
            send();
          };
          const onErr = (e: Error) => {
            pool = pool.filter((x) => x !== pw);
            reject(e);
          };
          pw.w.ref();
          pw.w.on('message', onMsg);
          pw.w.on('error', onErr);
          send();
        }),
    ),
  );
  return results;
}
