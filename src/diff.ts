import { posix } from 'node:path';
import { structuredPatch } from 'diff';
import { isTestFile } from './callgraph.js';
import type {
  CallGraph,
  FileChange,
  FnNode,
  GraphLink,
  GraphNode,
  GraphPayload,
  PatchLine,
  PrInfo,
  Stats,
  Status,
} from './types.js';
import type { LcovData } from './coverage.js';

export const MAX_DEPTH = 6;
const MAX_NODES = 4000;
const MAX_PATCH_LINES = 400;
/** Context nodes with more call-graph neighbours than this are shown but not expanded (keeps depth ≥2 readable). */
const HUB_DEGREE = 25;
/** Max neighbours pulled in from any single node; changed neighbours always come first. */
const MAX_FANOUT = 60;

export interface DiffOptions {
  pr: PrInfo;
  files: FileChange[];
  lcov?: LcovData;
  parsedFiles: { base: number; head: number };
  skippedFiles: number;
  startedAt: number;
}

export function fnStatus(base: FnNode | undefined, head: FnNode | undefined): Status {
  if (!base) return 'added';
  if (!head) return 'removed';
  return base.hash === head.hash ? 'unchanged' : 'modified';
}

/** Function-scoped unified diff with real file line numbers. */
export function fnPatch(base: FnNode | undefined, head: FnNode | undefined) {
  const a = base?.code ?? '';
  const b = head?.code ?? '';
  const p = structuredPatch('a', 'b', a ? a + '\n' : '', b ? b + '\n' : '', '', '', { context: 3 });
  const oOff = (base?.startLine ?? 1) - 1;
  const nOff = (head?.startLine ?? 1) - 1;
  const lines: PatchLine[] = [];
  let added = 0;
  let removed = 0;
  for (const h of p.hunks) {
    let o = h.oldStart + oOff;
    let n = h.newStart + nOff;
    lines.push({ t: '@', s: `@@ -${o},${h.oldLines} +${n},${h.newLines} @@` });
    for (const l of h.lines) {
      const t = l[0];
      const s = l.slice(1);
      if (t === '+') {
        lines.push({ t: '+', n: n++, s });
        added++;
      } else if (t === '-') {
        lines.push({ t: '-', o: o++, s });
        removed++;
      } else if (t === ' ') lines.push({ t: ' ', o: o++, n: n++, s });
    }
  }
  const truncated = lines.length > MAX_PATCH_LINES;
  return { lines: truncated ? lines.slice(0, MAX_PATCH_LINES) : lines, truncated, added, removed };
}

export function diffGraphs(base: CallGraph, head: CallGraph, opts: DiffOptions): GraphPayload {
  const ids = new Set([...base.nodes.keys(), ...head.nodes.keys()]);
  const status = new Map<string, Status>();
  for (const id of ids) status.set(id, fnStatus(base.nodes.get(id), head.nodes.get(id)));

  // Edge statuses over the union of both graphs. A call edge only counts as added/removed when at least
  // one endpoint changed: between two untouched functions a difference can only come from name-based
  // resolution shifting (e.g. the PR added another function with the same name elsewhere), not from code.
  const endpointsUnchanged = (e: string) => {
    const [a, b] = e.split('->');
    return status.get(a) === 'unchanged' && status.get(b) === 'unchanged';
  };
  const edgeStatus = new Map<string, Status>();
  for (const e of head.edges) edgeStatus.set(e, base.edges.has(e) || endpointsUnchanged(e) ? 'unchanged' : 'added');
  for (const e of base.edges) if (!head.edges.has(e)) edgeStatus.set(e, endpointsUnchanged(e) ? 'unchanged' : 'removed');

  const adj = new Map<string, string[]>();
  for (const e of edgeStatus.keys()) {
    const [a, b] = e.split('->');
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  // BFS from changed functions (undirected), nearest first.
  const depth = new Map<string, number>();
  let frontier: string[] = [];
  for (const [id, s] of status) {
    if (s !== 'unchanged') {
      depth.set(id, 0);
      frontier.push(id);
    }
  }
  let reachedDepth = 0;
  const isChanged = (id: string) => status.get(id) !== 'unchanged';
  for (let d = 1; d <= MAX_DEPTH && frontier.length && depth.size < MAX_NODES; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const nbs = adj.get(id) ?? [];
      if (!isChanged(id) && nbs.length > HUB_DEGREE) continue; // hub: visible, not expanded
      const ordered = nbs.length > MAX_FANOUT ? [...nbs.filter(isChanged), ...nbs.filter((x) => !isChanged(x))].slice(0, MAX_FANOUT) : nbs;
      for (const nb of ordered) {
        if (depth.has(nb) || depth.size >= MAX_NODES) continue;
        depth.set(nb, d);
        next.push(nb);
      }
    }
    if (next.length) reachedDepth = d;
    frontier = next;
  }

  // Static test reach over the head graph.
  const covered = new Set<string>();
  const stack: string[] = [];
  const headOut = new Map<string, string[]>();
  for (const e of head.edges) {
    const [a, b] = e.split('->');
    (headOut.get(a) ?? headOut.set(a, []).get(a)!).push(b);
  }
  for (const n of head.nodes.values()) if (isTestFile(n.file)) stack.push(n.id);
  while (stack.length) {
    const id = stack.pop()!;
    for (const nb of headOut.get(id) ?? []) {
      if (!covered.has(nb)) {
        covered.add(nb);
        stack.push(nb);
      }
    }
  }

  const nodes: GraphNode[] = [];
  const stats: Stats = {
    filesChanged: opts.files.length,
    linesAdded: 0,
    linesRemoved: 0,
    fnAdded: 0,
    fnRemoved: 0,
    fnModified: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    languages: {},
    parsedFiles: opts.parsedFiles,
    skippedFiles: opts.skippedFiles,
    coverage: { staticCovered: 0, staticTotal: 0 },
    analysisMs: 0,
  };
  for (const f of opts.files) {
    stats.linesAdded += f.added;
    stats.linesRemoved += f.removed;
    const ext = posix.extname(f.path) || posix.basename(f.path);
    stats.languages[ext] = (stats.languages[ext] ?? 0) + 1;
  }
  let lcovCovered = 0;
  let lcovTotal = 0;

  for (const [id, d] of depth) {
    const b = base.nodes.get(id);
    const h = head.nodes.get(id);
    const fn = (h ?? b)!;
    const s = status.get(id)!;
    const test = isTestFile(fn.file);
    const node: GraphNode = {
      id,
      label: fn.kind === 'module' ? `‹${posix.basename(fn.file)}›` : fn.container ? `${fn.container}.${fn.name}` : fn.name,
      type: 'function',
      kind: fn.kind,
      status: s,
      file: fn.file,
      lang: fn.lang,
      line: fn.startLine,
      depth: d,
      isTest: test,
      degree: (adj.get(id)?.length ?? 0) > HUB_DEGREE ? adj.get(id)!.length : undefined,
    };
    if (s !== 'unchanged') {
      const p = fnPatch(b, h);
      node.patch = p.lines;
      node.patchTruncated = p.truncated;
      node.added = p.added;
      node.removed = p.removed;
      if (s === 'added') stats.fnAdded++;
      else if (s === 'removed') stats.fnRemoved++;
      else stats.fnModified++;
      if (s !== 'removed' && !test && fn.kind !== 'module') {
        node.covered = covered.has(id);
        stats.coverage.staticTotal++;
        if (node.covered) stats.coverage.staticCovered++;
        if (opts.lcov) {
          const hits = opts.lcov.files.get(fn.file);
          let c = 0;
          let t = 0;
          for (const l of p.lines) {
            if (l.t !== '+' || l.n === undefined) continue;
            const v = hits?.get(l.n);
            if (v === undefined) continue;
            t++;
            if (v > 0) c++;
          }
          node.lcov = hits ? { covered: c, total: t } : null;
          lcovCovered += c;
          lcovTotal += t;
        }
      } else node.covered = null;
    }
    nodes.push(node);
  }
  if (opts.lcov) stats.coverage.lcov = { coveredLines: lcovCovered, totalLines: lcovTotal, source: opts.lcov.source };

  const links: GraphLink[] = [];
  for (const [e, s] of edgeStatus) {
    if (s === 'added') stats.edgesAdded++;
    else if (s === 'removed') stats.edgesRemoved++;
    const [a, b] = e.split('->');
    if (depth.has(a) && depth.has(b)) links.push({ source: a, target: b, type: 'call', status: s });
  }

  addFileTree(nodes, links, opts.files);
  stats.analysisMs = Date.now() - opts.startedAt;
  return { pr: opts.pr, stats, files: opts.files, nodes, links, maxDepth: Math.max(reachedDepth, 1) };
}

/** Attach folder → file → function containment nodes (rendered only when the folder layer is on). */
function addFileTree(nodes: GraphNode[], links: GraphLink[], files: FileChange[]) {
  const fileStatus = new Map<string, Status>();
  const fileChange = new Map<string, FileChange>();
  for (const f of files) {
    fileStatus.set(f.path, f.status === 'renamed' ? 'modified' : f.status);
    fileChange.set(f.path, f);
  }
  const fileDepth = new Map<string, number>();
  for (const n of nodes) {
    if (n.type !== 'function' || !n.file) continue;
    fileDepth.set(n.file, Math.min(fileDepth.get(n.file) ?? Infinity, n.depth));
    links.push({ source: `file:${n.file}`, target: n.id, type: 'contains', status: 'unchanged' });
  }
  for (const f of files) if (!fileDepth.has(f.path)) fileDepth.set(f.path, 0);

  const dirDepth = new Map<string, number>();
  const dirChanged = new Set<string>();
  for (const [path, d] of fileDepth) {
    const fc = fileChange.get(path);
    nodes.push({
      id: `file:${path}`,
      label: posix.basename(path),
      type: 'file',
      status: fileStatus.get(path) ?? 'unchanged',
      file: path,
      depth: d,
      added: fc?.added,
      removed: fc?.removed,
    });
    let child = `file:${path}`;
    let dir = posix.dirname(path);
    while (true) {
      const id = `dir:${dir}`;
      links.push({ source: id, target: child, type: 'contains', status: 'unchanged' });
      if (fc) dirChanged.add(dir);
      dirDepth.set(dir, Math.min(dirDepth.get(dir) ?? Infinity, d));
      if (dir === '.') break;
      child = id;
      dir = posix.dirname(dir);
    }
  }
  // Ancestors of changed dirs are changed too.
  for (const d of [...dirChanged]) {
    let p = d;
    while (p !== '.') {
      p = posix.dirname(p);
      dirChanged.add(p);
    }
  }
  for (const [dir, d] of dirDepth) {
    nodes.push({
      id: `dir:${dir}`,
      label: dir === '.' ? '/' : posix.basename(dir) + '/',
      type: 'folder',
      status: dirChanged.has(dir) ? 'modified' : 'unchanged',
      file: dir,
      depth: d,
    });
  }
  // Dedupe contains links (the walk above can revisit dir→dir pairs).
  const seen = new Set<string>();
  const kept = links.filter((l) => {
    if (l.type !== 'contains') return true;
    const k = `${l.source}>${l.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  links.length = 0;
  for (const l of kept) links.push(l);
}
