import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

export interface LcovData {
  source: string;
  /** repo-relative path → line → hit count */
  files: Map<string, Map<number, number>>;
}

export function parseLcov(file: string, repoRoot: string): LcovData {
  const files = new Map<string, Map<number, number>>();
  let cur: Map<number, number> | undefined;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      let p = line.slice(3);
      if (isAbsolute(p)) p = relative(repoRoot, p);
      p = p.replace(/\\/g, '/').replace(/^\.\//, '');
      cur = files.get(p) ?? new Map();
      files.set(p, cur);
    } else if (line.startsWith('DA:') && cur) {
      const [ln, hits] = line.slice(3).split(',');
      const n = Number(ln);
      cur.set(n, (cur.get(n) ?? 0) + Number(hits));
    } else if (line === 'end_of_record') cur = undefined;
  }
  return { source: file, files };
}
