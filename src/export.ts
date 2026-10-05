import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, type AnalyzeOptions } from './analyze.js';
import type { GraphPayload, PrInfo } from './types.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * Write a self-contained static site (no server needed): index.html + assets + one graph JSON per PR.
 * Used for GitHub Pages / CI artifacts. Also writes summary.md, a Markdown stats block for PR comments.
 */
export async function exportSite(queue: PrInfo[], out: string, opts: AnalyzeOptions & { link?: string }) {
  mkdirSync(join(out, 'dist'), { recursive: true });
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8').replace(
    '<script type="module"',
    '<script>window.GRAPH_DIFF_STATIC = true</script>\n  <script type="module"',
  );
  writeFileSync(join(out, 'index.html'), html);
  copyFileSync(join(WEB_DIR, 'style.css'), join(out, 'style.css'));
  copyFileSync(join(WEB_DIR, 'favicon.svg'), join(out, 'favicon.svg'));
  copyFileSync(join(WEB_DIR, 'dist', 'app.js'), join(out, 'dist', 'app.js'));

  const payloads: GraphPayload[] = [];
  for (const [i, pr] of queue.entries()) {
    const p = await analyze(pr, opts);
    payloads.push(p);
    writeFileSync(join(out, `graph-${i}.json`), JSON.stringify(p));
  }
  writeFileSync(join(out, 'queue.json'), JSON.stringify({ queue: payloads.map((p) => p.pr), index: 0, initialDepth: 1 }));
  writeFileSync(join(out, 'summary.md'), summaryMarkdown(payloads[0], opts.link));
  return payloads;
}

export function summaryMarkdown(p: GraphPayload, link?: string): string {
  const s = p.stats;
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
  const changed = p.nodes
    .filter((n) => n.type === 'function' && n.status !== 'unchanged' && n.kind !== 'module')
    .sort((a, b) => (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0)));
  // Production code first: that's what needs review attention; tests are summarised in one line.
  const prod = changed.filter((n) => !n.isTest);
  const tests = changed.filter((n) => n.isTest);
  const uncovered = prod.filter((n) => n.covered === false);
  const icon = { added: '🟢', modified: '🟡', removed: '🔴', unchanged: '' } as const;
  const top = prod
    .slice(0, 10)
    .map(
      (n) =>
        `| ${icon[n.status]} \`${n.label}\` | \`${n.file}:${n.line}\` | +${n.added} −${n.removed} | ${n.covered === true ? '✅' : n.covered === false ? '⚠️ none' : '—'} |`,
    );
  const lines = [
    '<!-- graph-diff -->',
    `### ◆ graph-diff${link ? ` — [open the 3D call-graph diff](${link})` : ''}`,
    '',
    `| files | lines | functions (+ / ~ / −) | call edges (+ / −) | test reach |`,
    `|---|---|---|---|---|`,
    `| ${s.filesChanged} | +${s.linesAdded} / −${s.linesRemoved} | ${s.fnAdded} / ${s.fnModified} / ${s.fnRemoved} | ${s.edgesAdded} / ${s.edgesRemoved} | ${pct(s.coverage.staticCovered, s.coverage.staticTotal)} (${s.coverage.staticCovered}/${s.coverage.staticTotal})${s.coverage.lcov ? ` · lcov ${pct(s.coverage.lcov.coveredLines, s.coverage.lcov.totalLines)}` : ''} |`,
  ];
  if (uncovered.length) {
    lines.push('', `⚠️ **${uncovered.length} changed function${uncovered.length > 1 ? 's' : ''} not reached by any test:** ${uncovered.slice(0, 8).map((n) => `\`${n.label}\``).join(', ')}${uncovered.length > 8 ? ', …' : ''}`);
  }
  if (top.length) {
    lines.push(
      '',
      `<details><summary>Largest changed functions (${prod.length} in code${tests.length ? `, ${tests.length} in tests` : ''})</summary>`,
      '',
      '| function | location | lines | test reach |',
      '|---|---|---|---|',
      ...top,
      '',
      '</details>',
    );
  }
  return lines.join('\n') + '\n';
}
