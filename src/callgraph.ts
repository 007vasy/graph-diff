import { posix } from 'node:path';
import type { CallGraph, FnId, FnNode } from './types.js';
import { LANGS } from './parser/languages.js';

const MAX_GLOBAL_CANDIDATES = 3;
/** Member calls on an unknown receiver (`x.Close()`) are ambiguous; only link when nearly unique. */
const MAX_MEMBER_CANDIDATES = 2;
/** Method names so common (mostly stdlib/framework) that an unknown receiver says nothing about the target. */
const UBIQUITOUS = new Set(
  'Lock Unlock RLock RUnlock Wait Done Close Context Error String Err Add Inc Dec Load Store Get Set Len Reset Write Read Start Stop Run Name Value Bytes Equal Cmp Copy Next New Debug Info Warn Warnf Infof Debugf Errorf Fatal Fatalf Logf Helper Cleanup Parallel Skip push pop append get set keys values items toString valueOf then catch finally map filter forEach reduce join split log emit on off'.split(' '),
);
const MOCK_RE = /(^|\/)(mocks?|fakes?|testutils?|testhelpers?)\/|(^|\/|_)mock[^/]*$|_mock\.go$/i;
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
  const byDir = new Map<string, FnNode[]>(); // "lang:dir|name"
  const byPkg = new Map<string, FnNode[]>(); // "lang:pkgOrModule|name" (dir basename or file stem)

  for (const f of fns) {
    nodes.set(f.id, f);
    if (f.kind === 'module') continue;
    if (f.lang === 'terraform') {
      tfByDir.set(`${posix.dirname(f.file)}|${f.name}`, f);
      continue;
    }
    push(byName, `${family(f.lang)}:${f.name}`, f);
    push(byFile, `${f.file}|${f.name}`, f);
    const fdir = posix.dirname(f.file);
    push(byDir, `${family(f.lang)}:${fdir}|${f.name}`, f);
    const pkg = posix.basename(fdir);
    const stem = posix.basename(f.file).split('.')[0];
    push(byPkg, `${family(f.lang)}:${pkg}|${f.name}`, f);
    if (stem !== pkg) push(byPkg, `${family(f.lang)}:${stem}|${f.name}`, f);
    if (f.container) push(byContainer, `${family(f.lang)}:${f.container}.${f.name}`, f);
  }

  const testFileCache = new Map<string, boolean>();
  const testFile = (p: string) => {
    let v = testFileCache.get(p);
    if (v === undefined) testFileCache.set(p, (v = isTestFile(p) || MOCK_RE.test(p)));
    return v;
  };
  const callerIsTest = new Map<FnNode, boolean>();
  const importsByFile = new Map<string, Set<string>>();
  for (const f of nodes.values()) {
    callerIsTest.set(f, testFile(f.file));
    if (f.imports?.length) importsByFile.set(f.file, new Set(f.imports));
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
      const member = recv !== '' && !SELF_RECV.has(recv);
      // Production code doesn't call into tests or mocks.
      const prodOnly = (xs: FnNode[] | undefined) => (xs && !callerIsTest.get(f) ? xs.filter((c) => !testFile(c.file)) : xs);
      cands = prodOnly(cands)!;
      if (!cands.length) continue;
      const sameDir = prodOnly(byDir.get(`${fam}:${dir}|${name}`));
      if (member) {
        // pkg.Fn() in Go / module.fn() in Python: prefer candidates whose directory or file is named after recv.
        const pkg = recv !== '?' ? prodOnly(byPkg.get(`${fam}:${recv}|${name}`))?.filter((c) => !c.container) : undefined;
        if (pkg?.length) cands = pkg;
        else {
          // pkg.Fn() on a package we couldn't find in the repo → external library.
          if (importsByFile.get(f.file)?.has(recv)) continue;
          // obj.method(): only methods qualify, and only when nearly unique.
          if (UBIQUITOUS.has(name)) continue;
          cands = cands.filter((c) => c.container);
          if (cands.length > MAX_MEMBER_CANDIDATES) continue;
        }
      } else if (!recv && sameDir?.length) {
        // Bare call: same package/directory wins (Go packages, Python siblings).
        cands = sameDir;
      }
      if (cands.length > MAX_GLOBAL_CANDIDATES) {
        if (sameDir?.length && sameDir.length <= MAX_GLOBAL_CANDIDATES) cands = sameDir;
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
