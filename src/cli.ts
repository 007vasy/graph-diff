#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentRepo, listPrs, parsePrRef, prKey, type ListOptions } from './github.js';
import { git } from './git.js';
import { startServer } from './server.js';
import type { PrInfo } from './types.js';

interface Common {
  port: string;
  open: boolean;
  depth: string;
  coverage?: string;
  maxFiles: string;
  includeGenerated?: boolean;
  cache: boolean;
}

const program = new Command()
  .name('graph-diff')
  .description('Review pull requests as a 3D call-graph diff')
  .version('0.1.0');

function common(cmd: Command) {
  return cmd
    .option('--port <n>', 'server port', '7357')
    .option('--no-open', "don't open the browser")
    .option('--depth <n>', 'initial call-graph depth', '1')
    .option('--coverage <lcov>', 'lcov.info for the head commit')
    .option('--max-files <n>', 'max source files parsed per commit', '15000')
    .option('--include-generated', 'also parse vendored/generated code')
    .option('--no-cache', 'ignore cached analyses');
}

async function serve(queue: PrInfo[], index: number, o: Common, refresh?: () => Promise<PrInfo[]>) {
  const { url } = await startServer({
    queue,
    index,
    port: Number(o.port),
    initialDepth: Number(o.depth),
    refresh,
    analyze: {
      coverage: o.coverage,
      maxFiles: Number(o.maxFiles),
      includeGenerated: o.includeGenerated,
      noCache: !o.cache,
    },
  });
  console.log(`\n  graph-diff → ${url}\n  keys: n/p next/prev PR · j/k next/prev change · [ ] depth · f folders · l labels\n  Ctrl+C to quit`);
  if (o.open) {
    const { default: open } = await import('open');
    await open(url);
  }
}

async function pick(prs: PrInfo[]): Promise<number> {
  if (!process.stdin.isTTY) {
    // Non-interactive (piped / CI): print the queue and start at the first PR.
    const w = Math.max(...prs.map((p) => p.key.length));
    for (const [i, p] of prs.entries()) console.log(`${String(i + 1).padStart(3)}  ${p.key.padEnd(w)}  ${p.isDraft ? '[draft] ' : ''}${p.title}  — @${p.author}`);
    return 0;
  }
  if (prs.length <= 1) return 0;
  const { search } = await import('@inquirer/prompts');
  const width = Math.max(...prs.map((p) => p.key.length));
  const choices = prs.map((p, i) => ({
    value: i,
    name: `${p.key.padEnd(width)}  ${p.isDraft ? '[draft] ' : ''}${p.title}  — @${p.author}`,
  }));
  return search({
    message: `Pick a PR (${prs.length}; type to filter)`,
    pageSize: 20,
    source: (term) => (term ? choices.filter((c) => c.name.toLowerCase().includes(term.toLowerCase())) : choices),
  });
}

async function listAndServe(opts: ListOptions, o: Common) {
  const fetch = () => listPrs(opts);
  process.stderr.write('Fetching pull requests…\r');
  const prs = await fetch();
  process.stderr.write('\x1b[2K');
  if (!prs.length) {
    console.log(opts.all ? 'No open pull requests found.' : 'No pull requests are waiting for your review. 🎉  (try `graph-diff list --all`)');
    return;
  }
  const index = await pick(prs);
  await serve(prs, index, o, fetch);
}

const fail = (e: unknown) => {
  console.error(`graph-diff: ${(e as Error)?.message ?? e}`);
  process.exit(1);
};

common(program.command('review', { isDefault: true }).description('PRs where your review is requested (default)'))
  .option('--repo <owner/repo>', 'limit to one repository')
  .option('--limit <n>', 'max PRs', '50')
  .action((o) => listAndServe({ repo: o.repo, limit: Number(o.limit) }, o).catch(fail));

common(program.command('list').description('List open PRs and pick one'))
  .option('--all', 'all open PRs (in --repo / the current repo / --owner / involving you)')
  .option('--repo <owner/repo>', 'repository')
  .option('--owner <org>', 'all open PRs in an org/user')
  .option('--author <login>', 'filter by author')
  .option('--limit <n>', 'max PRs', '50')
  .action(async (o) => {
    try {
      let repo = o.repo;
      if (o.all && !repo && !o.owner) repo = await currentRepo();
      await listAndServe({ all: o.all ?? !!(repo || o.owner), repo, owner: o.owner, author: o.author, limit: Number(o.limit) }, o);
    } catch (e) {
      fail(e);
    }
  });

common(program.command('open <pr...>').description('Open one or more PRs (URL, owner/repo#123 or 123)')).action(
  async (refs: string[], o) => {
    try {
      const queue: PrInfo[] = [];
      for (const r of refs) {
        const { owner, repo, number } = await parsePrRef(r);
        queue.push({ key: prKey(owner, repo, number), owner, repo, number, title: `${owner}/${repo}#${number}` });
      }
      await serve(queue, 0, o);
    } catch (e) {
      fail(e);
    }
  },
);

common(program.command('local').description('Diff two refs of the git repo in the current directory'))
  .option('--base <ref>', 'base ref', 'main')
  .option('--head <ref>', 'head ref', 'HEAD')
  .action(async (o) => {
    try {
      const cwd = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
      if (!o.coverage && existsSync(join(cwd, 'coverage', 'lcov.info'))) o.coverage = join(cwd, 'coverage', 'lcov.info');
      await serve([{ key: `local:${o.base}..${o.head}`, title: `${o.base} … ${o.head}`, local: { cwd, base: o.base, head: o.head } }], 0, o);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('export [pr...]')
  .description('Write a static site (for GitHub Pages / CI). Without <pr>, diffs --base..--head of the local repo.')
  .requiredOption('-o, --out <dir>', 'output directory')
  .option('--base <ref>', 'base ref (local mode)', 'main')
  .option('--head <ref>', 'head ref (local mode)', 'HEAD')
  .option('--title <text>', 'title (local mode)')
  .option('--link <url>', 'public URL of the exported site (used in summary.md)')
  .option('--repo <owner/repo>', 'GitHub repo, for source links (local mode)')
  .option('--number <n>', 'PR number (local mode)')
  .option('--url <url>', 'PR URL (local mode)')
  .option('--coverage <lcov>', 'lcov.info for the head commit')
  .option('--max-files <n>', 'max source files parsed per commit', '15000')
  .option('--include-generated', 'also parse vendored/generated code')
  .action(async (refs: string[], o) => {
    try {
      const { exportSite } = await import('./export.js');
      const queue: PrInfo[] = [];
      if (refs.length) {
        for (const r of refs) {
          const { owner, repo, number } = await parsePrRef(r);
          queue.push({ key: prKey(owner, repo, number), owner, repo, number, title: `${owner}/${repo}#${number}` });
        }
      } else {
        const cwd = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
        const [owner, repo] = (o.repo ?? '').split('/');
        queue.push({
          key: o.repo && o.number ? prKey(owner, repo, Number(o.number)) : `local:${o.base}..${o.head}`,
          title: o.title ?? `${o.base} … ${o.head}`,
          owner: owner || undefined,
          repo: repo || undefined,
          number: o.number ? Number(o.number) : undefined,
          url: o.url,
          local: { cwd, base: o.base, head: o.head },
        });
      }
      const [p] = await exportSite(queue, o.out, {
        coverage: o.coverage,
        maxFiles: Number(o.maxFiles),
        includeGenerated: o.includeGenerated,
        link: o.link,
      });
      const s = p.stats;
      console.log(`Exported to ${o.out}: ${s.filesChanged} files, +${s.linesAdded}/−${s.linesRemoved}, fns +${s.fnAdded}/~${s.fnModified}/−${s.fnRemoved}`);
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync().catch(fail);
