import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FileChange } from './types.js';

const pexec = promisify(execFile);

export const CACHE_DIR = process.env.GRAPH_DIFF_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'graph-diff');

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 1 << 30, encoding: 'utf8' });
  return stdout;
}

/** Bare cache repo for owner/repo; objects are fetched on demand per PR. */
export async function ensureRepo(owner: string, repo: string, remoteUrl: string): Promise<string> {
  const dir = join(CACHE_DIR, 'repos', owner, `${repo}.git`);
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '--bare', '-q']);
    await git(dir, ['remote', 'add', 'origin', remoteUrl]);
  }
  return dir;
}

export async function hasCommit(dir: string, sha: string) {
  try {
    await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const fetchLocks = new Map<string, Promise<unknown>>();

/**
 * Fetch exactly these commits (shallow) — avoids cloning the full history of large repos.
 * Fetches into one repo are serialized (git's shallow file lock), so a background batch
 * fetch and an on-demand fetch never collide; the later one usually finds its commits present.
 */
export function fetchCommits(dir: string, shas: string[]): Promise<void> {
  const prev = fetchLocks.get(dir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const missing: string[] = [];
    for (const s of new Set(shas)) if (!(await hasCommit(dir, s))) missing.push(s);
    if (!missing.length) return;
    await git(dir, ['fetch', '-q', '--depth=1', '--no-tags', '--no-write-fetch-head', 'origin', ...missing]);
  });
  fetchLocks.set(dir, run);
  return run;
}

export interface TreeEntry {
  path: string;
  blob: string;
  size: number;
}

export async function listTree(dir: string, sha: string): Promise<TreeEntry[]> {
  const out = await git(dir, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]);
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, type, blob, size] = rec.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    entries.push({ path: rec.slice(tab + 1), blob, size: Number(size) || 0 });
  }
  return entries;
}

/** Read many blobs through a single `git cat-file --batch` process. */
export function readBlobs(dir: string, blobs: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, string>();
    if (!blobs.length) return resolve(result);
    const p = spawn('git', ['cat-file', '--batch'], { cwd: dir });
    let buf = Buffer.alloc(0);
    let idx = 0;
    const consume = () => {
      while (idx < blobs.length) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        const parts = header.split(' ');
        if (parts[1] === 'missing') {
          buf = buf.subarray(nl + 1);
          idx++;
          continue;
        }
        const size = Number(parts[2]);
        if (buf.length < nl + 1 + size + 1) return;
        result.set(parts[0], buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
        buf = buf.subarray(nl + 1 + size + 1);
        idx++;
      }
    };
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      // Concatenate lazily to avoid O(n²) copying on large reads.
      if (chunks.length > 64 || d.length > 1 << 20) {
        buf = Buffer.concat([buf, ...chunks]);
        chunks.length = 0;
        consume();
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      buf = Buffer.concat([buf, ...chunks]);
      consume();
      if (code !== 0 && result.size === 0) reject(new Error(`git cat-file exited with ${code}`));
      else resolve(result);
    });
    p.stdin.end(blobs.join('\n') + '\n');
  });
}

export async function diffFiles(dir: string, base: string, head: string): Promise<FileChange[]> {
  const [numstat, names] = await Promise.all([
    git(dir, ['diff', '--numstat', '-z', '-M', base, head]),
    git(dir, ['diff', '--name-status', '-z', '-M', base, head]),
  ]);
  const statusByPath = new Map<string, { status: FileChange['status']; oldPath?: string }>();
  const ns = names.split('\0');
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++];
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = ns[i++];
      const path = ns[i++];
      statusByPath.set(path, { status: code[0] === 'R' ? 'renamed' : 'added', oldPath: code[0] === 'R' ? oldPath : undefined });
    } else {
      const path = ns[i++];
      statusByPath.set(path, { status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'removed' : 'modified' });
    }
  }
  const files: FileChange[] = [];
  const t = numstat.split('\0');
  for (let i = 0; i < t.length - 1; ) {
    const rec = t[i++];
    if (!rec) continue;
    const [a, r, p] = rec.split('\t');
    const path = p === '' ? (i++, t[i++]) : p; // rename: "a\tr\t\0old\0new"
    const s = statusByPath.get(path);
    files.push({
      path,
      oldPath: s?.oldPath,
      status: s?.status ?? 'modified',
      added: a === '-' ? 0 : Number(a),
      removed: r === '-' ? 0 : Number(r),
      binary: a === '-',
    });
  }
  return files;
}
