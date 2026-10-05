/**
 * Benchmark the analysis pipeline on real PRs of a (large) repository.
 *   npm run bench -- smartcontractkit/chainlink 8
 * Writes BENCHMARKS.md with per-phase timings. The first PR is "cold" (empty parse cache);
 * later PRs reuse parsed files (as when cycling PRs in the UI). A final pass re-opens the
 * first PR to measure the on-disk analysis cache.
 */
import { writeFileSync } from 'node:fs';
import { analyze } from '../src/analyze.js';
import { listPrs } from '../src/github.js';

const [repo = 'smartcontractkit/chainlink', nArg = '6', ...rest] = process.argv.slice(2);
const n = Number(nArg);
const explicit = rest.map(Number).filter(Boolean);

const PHASES = ['resolve', 'fetch', 'diff', 'lsTree', 'select', 'readBlobs', 'parse', 'callGraph', 'graphDiff', 'writeCache'];
const fmt = (ms: number | undefined) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const mb = () => Math.round(process.memoryUsage().rss / 1e6);

const prs = (await listPrs({ all: true, repo, limit: 40 }))
  .filter((p) => !explicit.length || explicit.includes(p.number!))
  .slice(0, n);
console.log(`Benchmarking ${prs.length} PRs of ${repo}`);

const rows: string[] = [];
for (const [i, pr] of prs.entries()) {
  const t0 = Date.now();
  const p = await analyze(pr, { noCache: true, onProgress: (m) => process.stdout.write(`\r  ${pr.key}: ${m}`.padEnd(80)) });
  const total = Date.now() - t0;
  const s = p.stats;
  const fns = p.nodes.filter((x) => x.type === 'function').length;
  const row = [
    `[#${pr.number}](${pr.url})`,
    i === 0 ? 'cold' : 'warm',
    s.filesChanged,
    `+${s.linesAdded}/−${s.linesRemoved}`,
    s.parsedFiles.head,
    `${s.fnAdded}/${s.fnModified}/${s.fnRemoved}`,
    fns,
    ...PHASES.map((k) => fmt(p.timings[k])),
    `**${fmt(total)}**`,
    `${mb()} MB`,
  ];
  rows.push(`| ${row.join(' | ')} |`);
  console.log(`\r  ${pr.key}: ${fmt(total)}  parse=${fmt(p.timings.parse)} files=${s.parsedFiles.head} rss=${mb()}MB`.padEnd(80));
}

let cacheRow = '';
if (prs[0]) {
  const t0 = Date.now();
  await analyze(prs[0], {});
  cacheRow = `Re-opening ${prs[0].key} from the analysis cache: **${fmt(Date.now() - t0)}** (incl. GitHub API round-trips to resolve the PR).`;
}

const md = `# Benchmarks

Repository: \`${repo}\` · ${new Date().toISOString().slice(0, 10)} · Node ${process.version} · ${process.platform}/${process.arch}

Timings are wall-clock per phase. **cold** = first PR (empty in-memory parse cache, objects not yet fetched);
**warm** = subsequent PRs reusing parsed files from the same process, as when cycling PRs in the UI.
\`fetch\` includes downloading the two commits (shallow) from GitHub.

| PR | cache | files Δ | lines | files parsed | fns +/~/− | graph fns | ${PHASES.join(' | ')} | total | RSS |
|---|---|---|---|---|---|---|${PHASES.map(() => '---').join('|')}|---|---|
${rows.join('\n')}

${cacheRow}
`;
writeFileSync('BENCHMARKS.md', md);
console.log('\nWrote BENCHMARKS.md');
process.exit(0);
