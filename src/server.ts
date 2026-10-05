import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, warmQueue, type AnalyzeOptions } from './analyze.js';

const LOOKAHEAD = 3;
import type { GraphPayload, PrInfo } from './types.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

interface Job {
  state: 'pending' | 'done' | 'error';
  message: string;
  promise: Promise<GraphPayload>;
  error?: string;
}

export interface ServerOptions {
  queue: PrInfo[];
  index: number;
  port: number;
  analyze: AnalyzeOptions;
  initialDepth: number;
  refresh?: () => Promise<PrInfo[]>;
}

export async function startServer(opts: ServerOptions): Promise<{ url: string; close: () => void }> {
  let queue = opts.queue;
  const jobs = new Map<string, Job>();
  const recent: string[] = []; // keys of completed jobs, most recent last (memory bound)
  // Analyses are CPU-bound and run one at a time; on-demand requests jump ahead of prefetches.
  const waiting: Array<{ key: string; start: () => void }> = [];
  let busy = false;
  const pump = () => {
    if (busy || !waiting.length) return;
    busy = true;
    waiting.shift()!.start();
  };

  const run = (key: string, priority: boolean): Job => {
    const existing = jobs.get(key);
    if (existing && existing.state !== 'error') {
      // Promote a queued prefetch when the user asks for it.
      const i = waiting.findIndex((w) => w.key === key);
      if (priority && i > 0) waiting.unshift(...waiting.splice(i, 1));
      return existing;
    }
    const pr = queue.find((p) => p.key === key);
    if (!pr) throw new Error(`Unknown PR ${key}`);
    const job: Job = { state: 'pending', message: priority ? 'Queued…' : 'Prefetching…', promise: null as any };
    job.promise = new Promise<GraphPayload>((resolve, reject) => {
      const start = () =>
        analyze(pr, { ...opts.analyze, onProgress: (m) => (job.message = m) })
          .then(
            (p) => {
              Object.assign(pr, { title: p.pr.title, author: p.pr.author, url: p.pr.url, isDraft: p.pr.isDraft });
              job.state = 'done';
              job.message = 'Done';
              recent.push(key);
              while (recent.length > 12) jobs.delete(recent.shift()!);
              resolve(p);
            },
            (e) => {
              job.state = 'error';
              job.error = job.message = String(e?.message ?? e);
              reject(e);
            },
          )
          .finally(() => {
            busy = false;
            pump();
          });
      if (priority) waiting.unshift({ key, start });
      else waiting.push({ key, start });
    });
    job.promise.catch(() => {});
    jobs.set(key, job);
    pump();
    return job;
  };

  // Analyse the next few PRs in the background so `n` is instant even for fast reviewers.
  const prefetchAfter = (key: string) => {
    const i = queue.findIndex((p) => p.key === key);
    for (const next of queue.slice(i + 1, i + 1 + LOOKAHEAD)) if (!jobs.has(next.key)) run(next.key, false);
  };
  const warm = (q: PrInfo[]) => warmQueue(q).catch(() => {});

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.searchParams.get('key') ?? '';
    switch (url.pathname) {
      case '/api/queue':
        if (url.searchParams.has('refresh') && opts.refresh) {
          queue = await opts.refresh();
          void warm(queue);
        }
        return json(res, 200, { queue, index: opts.index, initialDepth: opts.initialDepth });
      case '/api/graph': {
        const job = run(key, true);
        try {
          const payload = await job.promise;
          json(res, 200, payload);
          prefetchAfter(key);
        } catch (e: any) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
        return;
      }
      case '/api/status': {
        const job = jobs.get(key);
        return json(res, 200, job ? { state: job.state, message: job.message } : { state: 'idle', message: '' });
      }
      case '/api/statuses':
        return json(res, 200, Object.fromEntries([...jobs].map(([k, j]) => [k, j.state])));
    }
    // Static files.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR + '/')) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) }));
  });

  // Kick off the selected PR right away so it's (partly) ready when the browser connects,
  // and resolve + fetch every other PR in the queue in parallel (network-bound, off the CPU lane).
  if (queue[opts.index]) run(queue[opts.index].key, true);
  void warm(queue);

  let port = opts.port;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      break;
    } catch (e: any) {
      if (e.code !== 'EADDRINUSE' || port > opts.port + 20) throw e;
      port++;
    }
  }
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}
