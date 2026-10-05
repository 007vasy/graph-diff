import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, type AnalyzeOptions } from './analyze.js';
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
  let chain: Promise<unknown> = Promise.resolve(); // analyses run one at a time

  const run = (key: string, priority: boolean): Job => {
    const existing = jobs.get(key);
    if (existing && existing.state !== 'error') return existing;
    const pr = queue.find((p) => p.key === key);
    if (!pr) throw new Error(`Unknown PR ${key}`);
    const job: Job = { state: 'pending', message: priority ? 'Queued…' : 'Prefetching…', promise: null as any };
    const exec = () =>
      analyze(pr, { ...opts.analyze, onProgress: (m) => (job.message = m) }).then(
        (p) => {
          Object.assign(pr, { title: p.pr.title, author: p.pr.author, url: p.pr.url, isDraft: p.pr.isDraft });
          job.state = 'done';
          job.message = 'Done';
          recent.push(key);
          while (recent.length > 8) jobs.delete(recent.shift()!);
          return p;
        },
        (e) => {
          job.state = 'error';
          job.error = job.message = String(e?.message ?? e);
          throw e;
        },
      );
    job.promise = chain.then(exec, exec);
    chain = job.promise.catch(() => {});
    jobs.set(key, job);
    return job;
  };

  const prefetchAfter = (key: string) => {
    const i = queue.findIndex((p) => p.key === key);
    const next = queue[i + 1];
    if (next && !jobs.has(next.key)) run(next.key, false);
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.searchParams.get('key') ?? '';
    switch (url.pathname) {
      case '/api/queue':
        if (url.searchParams.has('refresh') && opts.refresh) queue = await opts.refresh();
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

  // Kick off the selected PR right away so it's (partly) ready when the browser connects.
  if (queue[opts.index]) run(queue[opts.index].key, true);

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
