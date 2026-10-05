import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze } from '../src/analyze.js';
import { buildCallGraph } from '../src/callgraph.js';
import { extractFile } from '../src/parser/index.js';

function repo(files1: Record<string, string>, files2: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), 'gd-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  const write = (fs: Record<string, string | null>) => {
    for (const [p, c] of Object.entries(fs)) {
      if (c === null) rmSync(join(dir, p));
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
    }
    g('add', '-A');
    g('commit', '-qm', 'c');
  };
  write(files1);
  g('checkout', '-qb', 'feature');
  write(files2);
  return dir;
}

const names = async (path: string, src: string) => (await extractFile(path, src))!.map((f) => f.id);

test('extracts definitions per language', async () => {
  assert.deepEqual(await names('a.ts', 'class A { m() { this.n() } n() {} }\nconst f = () => 1;\nfunction g() {}'), [
    'a.ts::<module>', 'a.ts::A.m', 'a.ts::A.n', 'a.ts::f', 'a.ts::g',
  ]);
  assert.deepEqual(await names('a.go', 'package x\nfunc F() { G() }\nfunc (s *S) M() {}'), ['a.go::<module>', 'a.go::F', 'a.go::S.M']);
  assert.deepEqual(await names('a.py', 'class C:\n  def m(self): pass\ndef f(): C()'), ['a.py::<module>', 'a.py::C.m', 'a.py::f']);
  assert.deepEqual(await names('a.rs', 'struct S; impl S { fn new() -> S { S } }\nfn main() { S::new(); }'), ['a.rs::<module>', 'a.rs::S.new', 'a.rs::main']);
  assert.deepEqual(
    await names('a.sol', 'contract A { constructor() {} modifier only() { _; } function f() public only { g(); } function g() internal {} }'),
    ['a.sol::<module>', 'a.sol::A.constructor', 'a.sol::A.only', 'a.sol::A.f', 'a.sol::A.g'],
  );
  assert.deepEqual(
    await names('m/main.tf', 'variable "n" {}\nlocals {\n  t = var.n\n}\nresource "aws_s3_bucket" "b" {\n  bucket = local.t\n}\noutput "arn" {\n  value = aws_s3_bucket.b.arn\n}'),
    ['m/main.tf::var.n', 'm/main.tf::local.t', 'm/main.tf::aws_s3_bucket.b', 'm/main.tf::output.arn'],
  );
});

test('resolves calls', async () => {
  const fns = [
    ...(await extractFile('a.sol', 'contract A { modifier only() { _; } function f() public only { g(); } function g() internal {} }'))!,
    ...(await extractFile('m/main.tf', 'variable "n" {}\nresource "x" "y" {\n  a = var.n\n}'))!,
    ...(await extractFile('p/a.go', 'package p\nfunc F() { G() }'))!,
    ...(await extractFile('p/b.go', 'package p\nfunc G() {}'))!,
    ...(await extractFile('q/c.go', 'package q\nimport "p"\nfunc H() { p.F() }'))!,
  ];
  const g = buildCallGraph(fns);
  for (const e of ['a.sol::A.f->a.sol::A.only', 'a.sol::A.f->a.sol::A.g', 'm/main.tf::x.y->m/main.tf::var.n', 'p/a.go::F->p/b.go::G', 'q/c.go::H->p/a.go::F'])
    assert.ok(g.edges.has(e), `missing ${e}: ${[...g.edges].join(', ')}`);
});

test('analyzes a local diff end to end', async () => {
  const dir = repo(
    {
      'src/a.ts': 'export function a() { return b(); }\nexport function b() { return 1; }\nfunction gone() {}\n',
      'src/c.py': 'def c():\n    return 1\n',
      'test/a.test.ts': "import { a } from '../src/a';\ntest('a', () => a());\n",
    },
    {
      'src/a.ts': 'export function a() { return b() + n(); }\nexport function b() { return 1; }\nfunction n() { return 2; }\n',
      'src/c.py': null,
    },
  );
  const p = await analyze({ key: 'local', title: 't', local: { cwd: dir, base: 'main', head: 'feature' } });
  const st = Object.fromEntries(p.nodes.filter((n) => n.type === 'function').map((n) => [n.id, n.status]));
  assert.equal(st['src/a.ts::a'], 'modified');
  assert.equal(st['src/a.ts::n'], 'added');
  assert.equal(st['src/a.ts::gone'], 'removed');
  assert.equal(st['src/c.py::c'], 'removed');
  assert.equal(st['src/a.ts::b'], 'unchanged'); // depth-1 context
  assert.equal(p.stats.filesChanged, 2);
  assert.equal(p.stats.fnAdded, 1);
  // a() is called from the test module → covered; n() reached through a() → covered.
  assert.equal(p.nodes.find((n) => n.id === 'src/a.ts::a')!.covered, true);
  assert.equal(p.stats.coverage.staticTotal, 2);
  assert.ok(p.links.some((l) => l.source === 'src/a.ts::a' && l.target === 'src/a.ts::n' && l.status === 'added'));
  assert.ok(p.nodes.some((n) => n.id === 'dir:src' && n.type === 'folder'));
  const patch = p.nodes.find((n) => n.id === 'src/a.ts::a')!.patch!;
  assert.ok(patch.some((l) => l.t === '+' && l.n === 1 && l.s.includes('n()')));
  rmSync(dir, { recursive: true, force: true });
});

test('lcov coverage of added lines', async () => {
  const dir = repo(
    { 'src/m.py': 'def f():\n    return 1\n' },
    { 'src/m.py': 'def f():\n    x = 1\n    y = 2\n    return x + y\n' },
  );
  const lcov = join(dir, 'lcov.info');
  // line 2 hit, line 3 not hit, line 4 not instrumented
  writeFileSync(lcov, `SF:${join(dir, 'src/m.py')}\nDA:1,1\nDA:2,4\nDA:3,0\nend_of_record\n`);
  const p = await analyze({ key: 'l', title: 't', local: { cwd: dir, base: 'main', head: 'feature' } }, { coverage: lcov });
  const f = p.nodes.find((n) => n.id === 'src/m.py::f')!;
  assert.deepEqual(f.lcov, { covered: 1, total: 2 });
  assert.deepEqual(p.stats.coverage.lcov && [p.stats.coverage.lcov.coveredLines, p.stats.coverage.lcov.totalLines], [1, 2]);
  rmSync(dir, { recursive: true, force: true });
});

test('resolution churn between unchanged functions is not reported as an edge change', async () => {
  // b.go::caller calls x.Allow(); in base there are 2 Allow methods (linked), the PR adds a 3rd in another
  // package so the ambiguous member call is no longer linked in head. caller and both old methods are untouched.
  const dir = repo(
    {
      'a/a.go': 'package a\ntype A struct{}\nfunc (A) Allow() bool { return true }\n',
      'b/b.go': 'package b\ntype B struct{}\nfunc (B) Allow() bool { return true }\nfunc caller(x B) { x.Allow() }\n',
    },
    { 'c/c.go': 'package c\ntype C struct{}\nfunc (C) Allow() bool { return false }\n' },
  );
  const p = await analyze({ key: 'c', title: 't', local: { cwd: dir, base: 'main', head: 'feature' } });
  const churn = p.links.filter((l) => l.type === 'call' && l.status !== 'unchanged' && !l.target.startsWith('c/'));
  assert.deepEqual(churn, []);
  assert.equal(p.stats.edgesRemoved, 0);
  rmSync(dir, { recursive: true, force: true });
});
