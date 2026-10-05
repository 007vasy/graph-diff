# graph-diff — Specification

> Review pull requests as a **3D call graph diff** instead of a wall of text.
> Pick a PR, see which functions changed, how they connect, and hop to the next PR in seconds.

## 1. Goals

| # | Goal |
|---|------|
| G1 | A CLI that lists PRs the user should look at: **review-requested** (default) or **all open PRs** they can see in a repo / across their account. |
| G2 | The user picks a PR (interactive picker in the terminal, or in the browser) and can jump to **next / previous** PR without leaving the browser. |
| G3 | Both the **base** and the **head** commit are parsed into an AST and a **call graph** (functions/methods + call edges). |
| G4 | The graph **diff** marks every function as `added`, `removed`, `modified`, or `unchanged`, and every call edge as `added`, `removed`, or `unchanged`. |
| G5 | A **3D force-directed graph** in the browser shows the diff. **Hovering** a function shows its local code change (unified diff of that function only). |
| G6 | A **depth** control sets how many call-graph hops around changed functions are shown (0 = only changed functions). |
| G7 | A toggleable **file/folder layer**: folder and file nodes attached to the functions they contain. |
| G8 | A **stats panel**: files changed, lines added/removed, functions added/removed/modified, and **coverage**. |
| G9 | Optimised for **fast cycling**: keyboard shortcuts for next/prev PR and next/prev changed function; analyses cached on disk. |

Non-goals (v1): posting review comments, type-accurate call resolution, monorepo-scale (> ~5k source files) performance tuning.

## 2. Architecture

```
┌─────────────┐   gh CLI (auth reused)    ┌──────────────┐
│  graph-diff │ ────────────────────────▶ │   GitHub     │
│    CLI      │   git fetch base/head     └──────────────┘
│ (Node/TS)   │ ──▶ ~/.cache/graph-diff/repos/<owner>/<repo>  (bare mirror)
│             │
│  analyzer   │  tree-sitter (WASM) → per-commit CallGraph → GraphDiff
│  server     │  http://localhost:<port>  (JSON API + static UI)
└─────────────┘
        ▲  fetch /api/...
┌───────┴──────────────────────────────────────────────────────────────┐
│ Browser UI: PR list · 3D graph (3d-force-graph / three.js) · stats   │
│ hover tooltip with per-function diff · depth slider · folder toggle  │
└──────────────────────────────────────────────────────────────────────┘
```

Language: **TypeScript on Node ≥ 20**, shipped as an npm package with a `graph-diff` bin.

### 2.1 Modules

| Module | Responsibility |
|---|---|
| `src/cli.ts` | Command parsing (commander), interactive PR picker (@inquirer/prompts), starts server, opens browser. |
| `src/github.ts` | Wraps `gh` CLI: list PRs, fetch PR metadata (base/head SHA, repo, title, author, url). |
| `src/git.ts` | Maintains a cached bare clone per repo; fetches `pull/<n>/head` and base SHA; lists files and reads blobs at a commit; `git diff --numstat` for line stats. |
| `src/parser/` | tree-sitter loader + per-language queries. Extracts **definitions** (functions, methods, classes as containers) and **call sites**. |
| `src/callgraph.ts` | Builds a `CallGraph` for one commit: nodes = functions, edges = resolved calls. |
| `src/diff.ts` | Compares two `CallGraph`s → `GraphDiff` with per-function status and per-function unified patch; edge statuses; stats. |
| `src/coverage.ts` | Coverage computation (see §6). |
| `src/server.ts` | HTTP server: static UI + JSON API, analysis cache. |
| `web/` | Static UI (vanilla JS + 3d-force-graph UMD, no build step). |

## 3. CLI

```
graph-diff                         # = graph-diff review
graph-diff review                  # PRs where review is requested from me (all repos)
graph-diff list [--all] [--repo o/r] [--author @me] [--limit 50]
                                   # --all: every open PR I can see (in --repo, or the current repo,
                                   #        or across my account via `gh search prs --involves @me`)
graph-diff open <pr>               # <pr> = URL | owner/repo#123 | 123 (current repo)
graph-diff local [--base main] [--head HEAD]   # diff two local refs in the cwd repo, no GitHub needed

Common options:
  --port <n>          server port (default 7357, auto-increments if busy)
  --no-open           don't launch the browser
  --depth <n>         initial depth (default 1)
  --coverage <file>   lcov.info for the head commit (optional; see §6)
  --max-files <n>     cap on source files parsed per commit (default 4000)
```

Flow for `review` / `list`:
1. Query PRs through `gh` (JSON output).
2. If stdin is a TTY, show an interactive picker (title, repo#num, author, +/−). Otherwise print a table.
3. Start the server with the **whole PR list** as the "queue", select the picked PR, open the browser.
4. The browser can step through the queue (next/prev) — analyses are computed lazily and the **next PR is pre-fetched in the background**.

## 4. Analysis pipeline

1. **Resolve PR** → `{owner, repo, number, baseSha, headSha, baseRef, headRef, title, author, url}` (via `gh pr view --json`). Base SHA = merge-base of base branch and head (`git merge-base`) so the diff matches GitHub's "Files changed".
2. **Fetch**: `git clone --bare --filter=blob:none` once into the cache, then `git fetch origin <baseRef> pull/<n>/head`.
3. **Changed files**: `git diff --numstat -M base head` → per-file added/removed lines, renames.
4. **Parse**: for each commit, list source files (`git ls-tree -r`) with supported extensions, read blobs (`git cat-file --batch`), parse with tree-sitter. Unchanged files are parsed once and shared between both sides (keyed by blob SHA).
5. **Call graph** per commit (§5).
6. **Diff** (§5.3) → `GraphDiff`.
7. Cache result as JSON at `~/.cache/graph-diff/analyses/<owner>_<repo>_<baseSha>_<headSha>.json`.

### 4.1 Supported languages (tree-sitter WASM grammars)

Primary: **Go, Python, Rust, JavaScript, TypeScript/TSX, Solidity, Terraform**. (Java is also wired up; others can be added by registering a grammar + spec.) Files in unsupported languages still count in file/line stats and appear in the folder view.

| Language | "Function" nodes | Containers | Call / reference sites |
|---|---|---|---|
| Go | `func`, methods (receiver type = container) | — | `f()`, `x.f()` |
| Python | `def` | `class` | `f()`, `x.f()`, `Cls()` → `__init__` |
| Rust | `fn` | `impl T`, `trait` | `f()`, `x.f()`, `T::f()` |
| JS / TS | function decls, methods, arrow/function expressions bound to a name | `class` | `f()`, `x.f()`, `new C()` → `constructor` |
| Solidity | `function`, `modifier`, `constructor`, `fallback/receive` | `contract`, `interface`, `library` | `f()`, `x.f()`, modifier invocations, `new C()` |
| Terraform | `resource`, `data`, `module`, `variable`, `output`, each `locals` entry, `provider` | module = directory | references `var.x`, `local.y`, `module.m`, `data.t.n`, `type.name` (resolved within the same directory) |

## 5. Data model

```ts
type FnId = string;   // "<path>::<Container.>name"  e.g. "src/a.ts::Foo.bar"
                       // duplicates in one file get a "#2" suffix

interface FnNode {
  id: FnId; name: string; container?: string; file: string; lang: string;
  kind: 'function' | 'method';
  startLine: number; endLine: number;
  hash: string;            // hash of body text with whitespace normalised
  code: string;            // source text
  calls: string[];         // raw callee names from call sites
}

interface CallGraph { nodes: Map<FnId, FnNode>; edges: Set<`${FnId}->${FnId}`>; }
```

### 5.1 Call resolution (heuristic, static, untyped)

For a call to `name` (identifier, or the property of a member call `x.name(...)`):
1. Same container (method of the same class) → that method.
2. Same file → definition with that name.
3. Otherwise all definitions with that name repo-wide **if ≤ 3 candidates** (avoids noise from `get`, `map`, ...).
4. Unresolved calls (library/builtin) are dropped.

### 5.2 Function identity across commits

Primary key = `FnId`. File renames detected by `git diff -M` are applied to base ids before matching, so a renamed file does not appear as delete + add.

### 5.3 Diff

| Status | Rule |
|---|---|
| `added` | id only in head |
| `removed` | id only in base |
| `modified` | in both, `hash` differs |
| `unchanged` | in both, same hash |

Edges: present in head only → `added`; base only → `removed`; both → `unchanged`.
Each `added/removed/modified` function carries a **unified patch** (function-scoped, with real line numbers) and `+/-` line counts.

### 5.4 Graph sent to the UI

```ts
interface GraphPayload {
  pr: PrInfo;
  stats: Stats;
  nodes: Array<{ id; label; type: 'function'|'file'|'folder'; status; file; lang;
                 depth: number;          // hops from nearest changed function (0 = changed)
                 added?: number; removed?: number; patch?: string; covered?: boolean|null }>;
  links: Array<{ source; target; type: 'call'|'contains'; status }>;
}
```

Server includes functions up to `maxDepth = 6` hops (undirected BFS over the union of base+head call edges) from changed functions; the UI filters by the current depth without a round-trip.

## 6. Stats & coverage

Side panel shows:
- **Files changed** (with per-language breakdown), **lines +/−**, **functions** added/removed/modified, **call edges** added/removed.
- **Coverage**, two modes:
  1. **Static test reach (always)**: a changed function counts as *covered* if any function defined in a test file (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_test.py`) reaches it in the head call graph (any depth). Shown as `covered changed fns / changed fns` (%).
  2. **lcov (optional `--coverage` / auto-detected `coverage/lcov.info` in the cwd for `local`)**: line coverage of added lines in changed functions.
- Coverage is also drawn on the graph: uncovered changed functions get a red ring.

## 7. Browser UI

Layout: **left** PR queue · **centre** 3D graph · **right** stats + controls · bottom-left tooltip.

### 7.1 Visual encoding
| Element | Encoding |
|---|---|
| Added fn | green sphere |
| Removed fn | red sphere |
| Modified fn | amber sphere, size ∝ lines changed |
| Unchanged (context) fn | small grey sphere, opacity decreasing with depth |
| File / folder node | blue / violet cube (only when folder layer is on) |
| Call edge | directional arrow + particles; colour by edge status |
| Contains edge | thin dashed-looking dim line |

### 7.2 Interactions
- **Hover** function → tooltip: name, file:line, status, +/−, coverage, and the **function-level diff** (syntax-coloured +/− lines). Hover file → file stats.
- **Click** → focus camera on node, pin tooltip; click on file opens it on GitHub at head SHA.
- **Depth slider** 0–6 (keys `[` / `]`).
- **Folder layer toggle** (key `f`); **labels toggle** (key `l`); **hide unchanged** is implied by depth 0.
- **Next / prev PR** buttons + keys `n` / `p`; **next / prev changed function** keys `j` / `k` (camera flies to it, tooltip pinned).
- Search box to filter/focus a function by name.
- Status filter checkboxes (added / removed / modified / context).
- Loading state per PR with progress messages streamed from the server.

## 8. HTTP API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/queue` | PR list (queue) + current index |
| GET | `/api/graph?key=<prKey>` | `GraphPayload` (computes or reads cache) |
| GET | `/api/prefetch?key=<prKey>` | starts background analysis, returns 202 |
| GET | `/api/status?key=<prKey>` | analysis progress text |

## 9. Error handling
- `gh` missing / not authenticated → clear message with `gh auth login` hint.
- Grammar parse failures on a file → file skipped, counted in `stats.skippedFiles`.
- Huge repos → `--max-files` cap; only files within changed directories + direct importers are prioritised when capped.

## 10. Performance

Benchmarked on PRs of a large monorepo (`smartcontractkit/chainlink`, Go + Solidity, ~10k source files). Targets:
- cold analysis (repo already cloned) of a typical PR < 30 s; warm (parse cache hot, next PR in same repo) < 10 s; cached result < 200 ms.
- Techniques: blob-SHA keyed parse cache shared by base/head and across PRs, `git cat-file --batch` streaming, tree-cursor walk that only materialises interesting nodes, background prefetch of the next PR.
- `npm run bench -- <owner/repo> [n]` prints a per-phase timing table (fetch, ls-tree, read blobs, parse, graph, diff, payload) to `BENCHMARKS.md`.

## 11. Testing
- Unit tests (node:test) for: parser extraction per language, call resolution, diff classification, stats.
- Fixture-based end-to-end test: create a temp git repo with two commits, run `local` analysis, assert payload.

## 12. Milestones
1. Spec (this file) + repo scaffold on GitHub.
2. Parser + call graph + diff + tests.
3. Git/GitHub integration + CLI picker.
4. Server + 3D UI (hover diff, depth, folder layer, stats, cycling).
5. Coverage, caching, prefetch, polish, README.
