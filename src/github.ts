import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrInfo } from './types.js';

const pexec = promisify(execFile);

export async function gh<T = unknown>(args: string[], cwd?: string): Promise<T> {
  try {
    const { stdout } = await pexec('gh', args, { cwd, maxBuffer: 1 << 28 });
    return JSON.parse(stdout) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('GitHub CLI `gh` not found. Install it from https://cli.github.com and run `gh auth login`.');
    const msg = String(e.stderr || e.message);
    if (/auth login|not logged/i.test(msg)) throw new Error('`gh` is not authenticated. Run `gh auth login` first.');
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${msg.trim()}`);
  }
}

export const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

interface SearchPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string };
  repository: { nameWithOwner: string };
}

const SEARCH_FIELDS = 'number,title,url,isDraft,updatedAt,author,repository';

function fromSearch(p: SearchPr): PrInfo {
  const [owner, repo] = p.repository.nameWithOwner.split('/');
  return {
    key: prKey(owner, repo, p.number),
    owner,
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author?.login,
    isDraft: p.isDraft,
    updatedAt: p.updatedAt,
  };
}

export interface ListOptions {
  all?: boolean;
  repo?: string;
  owner?: string;
  author?: string;
  limit?: number;
}

/** PRs awaiting my review, or (with `all`) all open PRs in a repo / owner / involving me. */
export async function listPrs(opts: ListOptions): Promise<PrInfo[]> {
  const limit = String(opts.limit ?? 50);
  if (opts.all && opts.repo) {
    const list = await gh<any[]>([
      'pr', 'list', '-R', opts.repo, '--state', 'open', '--limit', limit,
      '--json', 'number,title,url,isDraft,updatedAt,author',
      ...(opts.author ? ['--author', opts.author] : []),
    ]);
    const [owner, repo] = opts.repo.split('/');
    return list.map((p) => fromSearch({ ...p, repository: { nameWithOwner: `${owner}/${repo}` } }));
  }
  const args = ['search', 'prs', '--state=open', '--limit', limit, '--json', SEARCH_FIELDS, '--sort', 'updated'];
  if (!opts.all) args.push('--review-requested=@me');
  else if (opts.owner) args.push(`--owner=${opts.owner}`);
  else args.push('--involves=@me');
  if (opts.repo) args.push(`--repo=${opts.repo}`);
  if (opts.author) args.push(`--author=${opts.author}`);
  return (await gh<SearchPr[]>(args)).map(fromSearch);
}

/** owner/repo of the GitHub remote in cwd, if any. */
export async function currentRepo(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const r = await gh<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'], cwd);
    return r.nameWithOwner;
  } catch {
    return undefined;
  }
}

/** Accepts a PR URL, `owner/repo#123`, or `123` (current repo). */
export async function parsePrRef(ref: string): Promise<{ owner: string; repo: string; number: number }> {
  let m = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  m = ref.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  if (/^\d+$/.test(ref)) {
    const cur = await currentRepo();
    if (!cur) throw new Error(`"${ref}" needs a GitHub repo in the current directory (or use owner/repo#${ref}).`);
    const [owner, repo] = cur.split('/');
    return { owner, repo, number: Number(ref) };
  }
  throw new Error(`Can't parse PR reference "${ref}". Use a URL, owner/repo#123, or 123.`);
}

/** Fill in base/head SHAs (base = merge-base, matching GitHub's "Files changed"). */
export async function resolvePr(pr: PrInfo): Promise<PrInfo & { baseSha: string; headSha: string }> {
  const { owner, repo, number } = pr as Required<PrInfo>;
  const v = await gh<any>([
    'pr', 'view', String(number), '-R', `${owner}/${repo}`,
    '--json', 'number,title,url,author,baseRefName,headRefName,headRefOid,isDraft,updatedAt',
  ]);
  const cmp = await gh<any>([
    'api', `repos/${owner}/${repo}/compare/${encodeURIComponent(v.baseRefName)}...${v.headRefOid}?per_page=1`,
    '--jq', '{merge_base: .merge_base_commit.sha}',
  ]);
  return {
    ...pr,
    title: v.title,
    url: v.url,
    author: v.author?.login,
    isDraft: v.isDraft,
    updatedAt: v.updatedAt,
    baseRef: v.baseRefName,
    headRef: v.headRefName,
    headSha: v.headRefOid,
    baseSha: cmp.merge_base,
  };
}

let protocol: Promise<string> | undefined;
export async function remoteUrl(owner: string, repo: string) {
  protocol ??= pexec('gh', ['config', 'get', 'git_protocol']).then((r) => r.stdout.trim(), () => 'https');
  return (await protocol) === 'ssh' ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
}
