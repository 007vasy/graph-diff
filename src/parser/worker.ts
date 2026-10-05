import { parentPort } from 'node:worker_threads';
import { extractItem, type ParseItem } from './pool.js';

parentPort!.on('message', async (m: { start: number; items: ParseItem[] }) => {
  const results = [];
  for (const it of m.items) {
    results.push(await extractItem(it));
  }
  parentPort!.postMessage({ start: m.start, results });
});
