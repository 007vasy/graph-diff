import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCallGraph } from './callgraph.js';
import { parseLcov, type LcovData } from './coverage.js';
import { diffGraphs } from './diff.js';
import { CACHE_DIR, diffFiles, ensureRepo, fetchCommits, git, listTree, readBlobs, type TreeEntry } from './git.js';
import { remoteUrl, resolvePr } from './github.js';
import { langForPath } from './parser/index.js';
import { extractMany, type ParseItem } from './parser/pool.js';
import type { FileChange, FnNode, GraphPayload, PrInfo } from './types.js';

const ANALYSIS_VERSION = 5;
const MAX_FILE_BYTES = 512 * 1024;

const EXCLUDE =
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.git|\.terraform|__pycache__)\/|\.min\.js$|\.pb\.go$|_gen\.go$|\.gen\.go$|(^|\/)generated\/|_generated\.|\.generated\./;

export interface AnalyzeOptions {
  maxFiles?: number;
  coverage?: string;
  includeGenerated?: boolean;
  noCache?: boolean;
  onProgress?: (msg: string) => void;
}

export type Timings = Record<string, number>;

/**
 * Network warm-up for a PR queue: resolve all PRs concurrently, then fetch every needed commit
 * with one `git fetch` per repo. Mutates queue items in place (adds baseSha/headSha), so later
 * `analyze()` calls skip both network steps. Errors are left for `analyze()` to report.
 */
export async function warmQueue(queue: PrInfo[], onResolved?: (pr: PrInfo) => void) {
  const pending = queue.filter((p) => !p.local && !(p.baseSha && p.headSha));
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, pending.length) }, async () => {
      while (i < pending.length) {
        const pr = pending[i++];
        try {
          Object.assign(pr, await resolvePr(pr));
          onResolved?.(pr);
        } catch {}
      }
    }),
  );
  const byRepo = new Map<string, PrInfo[]>();
  for (const p of queue) if (!p.local && p.baseSha && p.headSha) (byRepo.get(`${p.owner}/${p.repo}`) ?? byRepo.set(`${p.owner}/${p.repo}`, []).get(`${p.owner}/${p.repo}`)!).push(p);
  await Promise.all(
    [...byRepo].map(async ([, prs]) => {
      const { owner, repo } = prs[0];
      const dir = await ensureRepo(owner!, repo!, await remoteUrl(owner!, repo!));
      await fetchCommits(dir, prs.flatMap((p) => [p.baseSha!, p.headSha!])).catch(() => {});
    }),
  );
}

/**
 * Parse cache shared across base/head and across PRs: key = path@blob.
 * Code text is only kept for files that are part of the diff (it's needed for patches);
 * for everything else we keep only hashes and call sites to save memory on big repos.
 */
const parseCache = new Map<string, FnNode[]>();
const PARSE_CACHE_LIMIT = 200_000;

function cacheSet(k: string, v: FnNode[]) {
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    // Drop the oldest ~10% (Map keeps insertion order).
    let n = PARSE_CACHE_LIMIT / 10;
    for (const key of parseCache.keys()) {
      parseCache.delete(key);
      if (--n <= 0) break;
    }
  }
  parseCache.set(k, v);
}

export async function analyze(pr: PrInfo, opts: AnalyzeOptions = {}): Promise<GraphPayload & { timings: Timings }> {
  const startedAt = Date.now();
  const timings: Timings = {};
  let t = Date.now();
  const lap = (name: string) => {
    const now = Date.now();
    timings[name] = (timings[name] ?? 0) + now - t;
    t = now;
  };
  const progress = opts.onProgress ?? (() => {});

  // 1. Resolve commits.
  let dir: string;
  let info: PrInfo;
  if (pr.local) {
    dir = pr.local.cwd;
    const head = (await git(dir, ['rev-parse', pr.local.head])).trim();
    const base = (await git(dir, ['merge-base', pr.local.base, head])).trim();
    info = { ...pr, baseSha: base, headSha: head };
  } else {
    progress('Resolving PR…');
    const r = pr.baseSha && pr.headSha ? (pr as PrInfo & { baseSha: string; headSha: string }) : await resolvePr(pr);
    info = r;
    lap('resolve');
    const cachePath = join(CACHE_DIR, 'analyses', `${r.owner}_${r.repo}_${r.baseSha}_${r.headSha}_v${ANALYSIS_VERSION}.json`);
    if (!opts.noCache && !opts.coverage && existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      cached.pr = { ...cached.pr, ...r };
      return { ...cached, timings: { ...timings, cacheHit: Date.now() - startedAt } };
    }
    dir = await ensureRepo(r.owner!, r.repo!, await remoteUrl(r.owner!, r.repo!));
    progress(`Fetching ${r.baseSha.slice(0, 7)}…${r.headSha.slice(0, 7)}`);
    await fetchCommits(dir, [r.baseSha, r.headSha]);
    lap('fetch');
  }
  const baseSha = info.baseSha!;
  const headSha = info.headSha!;

  // 2. File-level diff.
  progress('Diffing files…');
  const files = await diffFiles(dir, baseSha, headSha);
  const changed = new Set<string>();
  const renames = new Map<string, string>(); // old → new
  for (const f of files) {
    changed.add(f.path);
    if (f.oldPath) {
      changed.add(f.oldPath);
      renames.set(f.oldPath, f.path);
    }
  }
  lap('diff');

  // 3. Trees + file selection.
  const [baseTree, headTree] = await Promise.all([listTree(dir, baseSha), listTree(dir, headSha)]);
  lap('lsTree');
  let skipped = 0;
  const select = (tree: TreeEntry[]) => {
    const out: TreeEntry[] = [];
    for (const e of tree) {
      if (!langForPath(e.path)) continue;
      if ((!opts.includeGenerated && EXCLUDE.test(e.path) && !changed.has(e.path)) || e.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      out.push(e);
    }
    return capFiles(out, changed, opts.maxFiles ?? 15000, () => skipped++);
  };
  const baseFiles = select(baseTree);
  const headFiles = select(headTree);
  lap('select');

  // 4. Read + parse (cached by path@blob).
  const keyOf = (e: TreeEntry) => `${e.path}@${e.blob}${changed.has(e.path) ? ':full' : ''}`;
  const needed = new Map<string, TreeEntry>();
  for (const e of [...baseFiles, ...headFiles]) if (!parseCache.has(keyOf(e))) needed.set(keyOf(e), e);
  progress(`Reading ${needed.size} files…`);
  const blobs = await readBlobs(dir, [...new Set([...needed.values()].map((e) => e.blob))]);
  lap('readBlobs');
  progress(`Parsing ${needed.size} files…`);
  const todo: Array<[string, ParseItem]> = [];
  for (const [k, e] of needed) {
    const source = blobs.get(e.blob);
    if (source !== undefined) todo.push([k, { path: e.path, source, keepCode: changed.has(e.path) }]);
  }
  const parsed = await extractMany(
    todo.map(([, it]) => it),
    (n) => progress(`Parsing ${n}/${todo.length} files…`),
  );
  for (let i = 0; i < todo.length; i++) {
    if (parsed[i]) cacheSet(todo[i][0], parsed[i]!);
    else if (langForPath(todo[i][1].path)) skipped++;
  }
  lap('parse');

  // 5. Call graphs (base functions in renamed files get their new path so they match head).
  const collect = (entries: TreeEntry[], isBase: boolean) => {
    const out: FnNode[] = [];
    for (const e of entries) {
      const fns = parseCache.get(keyOf(e));
      if (!fns) continue;
      const to = isBase ? renames.get(e.path) : undefined;
      if (!to) out.push(...fns);
      else for (const f of fns) out.push({ ...f, file: to, id: to + f.id.slice(e.path.length) });
    }
    return out;
  };
  progress('Building call graphs…');
  const baseGraph = buildCallGraph(collect(baseFiles, true));
  const headGraph = buildCallGraph(collect(headFiles, false));
  lap('callGraph');

  // 6. Diff.
  let lcov: LcovData | undefined;
  if (opts.coverage) lcov = parseLcov(resolve(opts.coverage), pr.local?.cwd ?? process.cwd());
  const payload = diffGraphs(baseGraph, headGraph, {
    pr: info,
    files,
    lcov,
    parsedFiles: { base: baseFiles.length, head: headFiles.length },
    skippedFiles: skipped,
    startedAt,
  });
  lap('graphDiff');

  if (!pr.local && !opts.coverage) {
    const dirPath = join(CACHE_DIR, 'analyses');
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, `${info.owner}_${info.repo}_${baseSha}_${headSha}_v${ANALYSIS_VERSION}.json`),
      JSON.stringify(payload),
    );
    lap('writeCache');
  }
  return { ...payload, timings };
}

/** Keep changed files and their neighbourhood first when a repo exceeds the file budget. */
function capFiles(entries: TreeEntry[], changed: Set<string>, max: number, onSkip: () => void): TreeEntry[] {
  if (entries.length <= max) return entries;
  const dirs = new Set<string>();
  for (const p of changed) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const score = (e: TreeEntry) => {
    if (changed.has(e.path)) return 1e9;
    const parts = e.path.split('/');
    let s = 0;
    for (let i = 1; i < parts.length; i++) if (dirs.has(parts.slice(0, i).join('/'))) s = i;
    return s;
  };
  const sorted = entries.map((e) => [score(e), e] as const).sort((a, b) => b[0] - a[0]);
  for (let i = max; i < sorted.length; i++) onSkip();
  return sorted.slice(0, max).map(([, e]) => e);
}

export type { FileChange };
