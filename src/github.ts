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

/**
 * Anonymous REST fallback for public repos when `gh` is blocked (e.g. org SAML SSO not authorized for the token).
 * Rate-limited to 60 requests/hour by GitHub.
 */
async function publicApi<T = any>(path: string): Promise<T> {
  const r = await fetch(`https://api.github.com/${path}`, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub REST ${r.status} for ${path}`);
  return r.json() as Promise<T>;
}

const isSso = (e: unknown) => /SAML|SSO/i.test(String((e as Error)?.message));

function fromRest(owner: string, repo: string, p: any): PrInfo {
  return {
    key: prKey(owner, repo, p.number),
    owner,
    repo,
    number: p.number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login,
    isDraft: p.draft,
    updatedAt: p.updated_at,
    baseRef: p.base?.ref,
    headRef: p.head?.ref,
    headSha: p.head?.sha,
  };
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
    const [owner, repo] = opts.repo.split('/');
    const list = await gh<any[]>([
      'pr', 'list', '-R', opts.repo, '--state', 'open', '--limit', limit,
      '--json', 'number,title,url,isDraft,updatedAt,author',
      ...(opts.author ? ['--author', opts.author] : []),
    ]).catch(async (e) => {
      if (!isSso(e)) throw e;
      warnSso(owner);
      const prs = await publicApi<any[]>(`repos/${owner}/${repo}/pulls?state=open&per_page=${Math.min(100, Number(limit))}`);
      return prs.filter((p) => !opts.author || p.user?.login === opts.author).map((p) => ({ ...fromRest(owner, repo, p), repository: undefined }));
    });
    if (list.length && 'key' in list[0]) return list as PrInfo[];
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
  try {
    return await resolvePrGh(pr);
  } catch (e) {
    if (!isSso(e)) throw e;
    warnSso(pr.owner!);
    const { owner, repo, number } = pr as Required<PrInfo>;
    const p = await publicApi(`repos/${owner}/${repo}/pulls/${number}`);
    const cmp = await publicApi(`repos/${owner}/${repo}/compare/${encodeURIComponent(p.base.ref)}...${p.head.sha}?per_page=1`);
    useHttps = true;
    return { ...pr, ...fromRest(owner, repo, p), headSha: p.head.sha, baseSha: cmp.merge_base_commit.sha };
  }
}

const warned = new Set<string>();
function warnSso(owner: string) {
  if (warned.has(owner)) return;
  warned.add(owner);
  console.error(`graph-diff: your gh token isn't SSO-authorized for "${owner}"; using anonymous public API (60 req/h). Run \`gh auth refresh\` / authorize the token for the org to fix.`);
}
let useHttps = false;

async function resolvePrGh(pr: PrInfo): Promise<PrInfo & { baseSha: string; headSha: string }> {
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
  protocol ??= process.env.GRAPH_DIFF_GIT_PROTOCOL
    ? Promise.resolve(process.env.GRAPH_DIFF_GIT_PROTOCOL)
    : pexec('gh', ['config', 'get', 'git_protocol']).then((r) => r.stdout.trim(), () => 'https');
  return !useHttps && (await protocol) === 'ssh' ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
}
