import { posix } from 'node:path';
import type { CallGraph, FnId, FnNode } from './types.js';
import { LANGS } from './parser/languages.js';

const MAX_GLOBAL_CANDIDATES = 3;
const SELF_RECV = new Set(['this', 'self', 'super', 'Self']);
const CTOR_NAMES = new Map(LANGS.map((l) => [l.id, l.ctorNames ?? []]));

const family = (lang: string) => (lang === 'typescript' || lang === 'tsx' || lang === 'javascript' ? 'js' : lang);

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Resolve call sites to definitions with a static, untyped heuristic (see SPEC §5.1). */
export function buildCallGraph(fns: Iterable<FnNode>): CallGraph {
  const nodes = new Map<FnId, FnNode>();
  const byName = new Map<string, FnNode[]>();
  const byContainer = new Map<string, FnNode[]>(); // "lang:Container.name"
  const byFile = new Map<string, FnNode[]>(); // "file|name"
  const tfByDir = new Map<string, FnNode>(); // "dir|address"

  for (const f of fns) {
    nodes.set(f.id, f);
    if (f.kind === 'module') continue;
    if (f.lang === 'terraform') {
      tfByDir.set(`${posix.dirname(f.file)}|${f.name}`, f);
      continue;
    }
    push(byName, `${family(f.lang)}:${f.name}`, f);
    push(byFile, `${f.file}|${f.name}`, f);
    if (f.container) push(byContainer, `${family(f.lang)}:${f.container}.${f.name}`, f);
  }

  const edges = new Set<string>();
  const link = (from: FnNode, to: FnNode[]) => {
    for (const t of to) if (t.id !== from.id) edges.add(`${from.id}->${t.id}`);
  };

  for (const f of nodes.values()) {
    const fam = family(f.lang);
    const dir = posix.dirname(f.file);
    for (const call of new Set(f.calls)) {
      if (call.startsWith('@')) {
        const t = tfByDir.get(`${dir}|${call.slice(1)}`);
        if (t) link(f, [t]);
        continue;
      }
      const bar = call.indexOf('|');
      const recv = call.slice(0, bar);
      const name = call.slice(bar + 1);

      // 1. this.foo() / self.foo() / bare foo() inside a class → same container.
      if (f.container && (SELF_RECV.has(recv) || recv === '')) {
        const m = byContainer.get(`${fam}:${f.container}.${name}`);
        if (m) {
          link(f, preferFile(m, f.file));
          continue;
        }
        if (SELF_RECV.has(recv) && recv !== 'super') continue;
      }
      // 2. Type.method() / new Type() / Lib.fn()
      if (recv && !SELF_RECV.has(recv)) {
        const m = byContainer.get(`${fam}:${recv}.${name}`);
        if (m) {
          link(f, m);
          continue;
        }
      }
      // 3. Same file.
      const local = byFile.get(`${f.file}|${name}`);
      if (local && !recv) {
        link(f, local);
        continue;
      }
      // 4. Calling a type → its constructor.
      if (!recv) {
        const ctor = (CTOR_NAMES.get(f.lang) ?? [])
          .map((c) => byContainer.get(`${fam}:${name}.${c}`))
          .find(Boolean);
        if (ctor) {
          link(f, ctor);
          continue;
        }
      }
      // 5. Global by name.
      let cands = byName.get(`${fam}:${name}`);
      if (!cands) continue;
      if (recv && !SELF_RECV.has(recv)) {
        // pkg.Fn() in Go / module.fn() in Python: prefer candidates whose directory or file is named after recv.
        const byPkg = cands.filter(
          (c) => posix.basename(posix.dirname(c.file)) === recv || posix.basename(c.file).split('.')[0] === recv,
        );
        if (byPkg.length) cands = byPkg;
      } else if (!recv) {
        // Bare call: same package/directory wins (Go packages, Python siblings).
        const sameDir = cands.filter((c) => posix.dirname(c.file) === dir);
        if (sameDir.length) cands = sameDir;
      }
      if (cands.length > MAX_GLOBAL_CANDIDATES) {
        const sameDir = cands.filter((c) => posix.dirname(c.file) === dir);
        if (sameDir.length && sameDir.length <= MAX_GLOBAL_CANDIDATES) cands = sameDir;
        else continue;
      }
      link(f, cands);
    }
  }
  return { nodes, edges };
}

function preferFile(m: FnNode[], file: string) {
  const same = m.filter((x) => x.file === file);
  return same.length ? same : m;
}

const TEST_RE =
  /(^|\/)(tests?|__tests__|spec|testdata|test_utils?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|\.t\.sol$|(^|\/)conftest\.py$/;

export function isTestFile(path: string) {
  return TEST_RE.test(path);
}
