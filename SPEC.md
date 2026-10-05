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
graph-diff export [pr...] -o <dir> [--base --head --repo --number --url --link]
                                   # static site (no server) for GitHub Pages / CI, plus summary.md (see §13)

Common options:
  --port <n>          server port (default 7357, auto-increments if busy)
  --no-open           don't launch the browser
  --depth <n>         initial depth (default 1)
  --coverage <file>   lcov.info for the head commit (optional; see §6)
  --max-files <n>     cap on source files parsed per commit (default 15000)
  --include-generated also parse vendored/generated code (excluded by default: vendor/, node_modules/, *.pb.go, generated/ …)
  --no-cache          ignore the on-disk analysis cache
```

Flow for `review` / `list`:
1. Query PRs through `gh` (JSON output).
2. If stdin is a TTY, show an interactive, type-to-filter picker (repo#num, draft flag, title, author). Otherwise print a table and start at the first PR. (+/− isn't shown: GitHub's search API doesn't return it.)
3. Start the server with the **whole PR list** as the "queue", select the picked PR, open the browser.
4. **N+1 flow** — the server makes `n` (next PR) instant:
   - *network warm-up*: all queue PRs are resolved concurrently and **all their commits fetched in one batched `git fetch`** at startup (network lane, independent of analysis);
   - *look-ahead*: after a PR is served, the next **3** are analysed in the background;
   - *priority*: an on-demand request jumps ahead of queued prefetches (analyses are CPU-bound and run one at a time).

## 4. Analysis pipeline

1. **Resolve PR** → `{owner, repo, number, baseSha, headSha, baseRef, headRef, title, author, url}` (via `gh pr view --json`). Base SHA = merge-base from GitHub's compare API (`merge_base_commit`), so the diff matches GitHub's "Files changed" without needing history locally.
2. **Fetch**: an empty bare repo per GitHub repo in the cache; `git fetch --depth=1 origin <baseSha> <headSha>`: only the two trees, never the history (fast for huge monorepos). Fetches into one repo are serialized (shallow-file lock).
3. **Changed files**: `git diff --numstat -M base head` → per-file added/removed lines, renames.
4. **Parse**: for each commit, list source files (`git ls-tree -r`) with supported extensions, read blobs (`git cat-file --batch`), parse with tree-sitter in a **worker-thread pool** (≤ 8 workers; in-process below 250 files). Parse results are cached in memory by `path@blob` and shared between base/head and across PRs; function source text is kept only for files in the diff.
5. **Call graph** per commit (§5).
6. **Diff** (§5.3) → `GraphDiff`.
7. Cache result as JSON at `~/.cache/graph-diff/analyses/<owner>_<repo>_<baseSha>_<headSha>_v<N>.json`.

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
  kind: 'function' | 'method' | 'module';   // 'module' = synthetic <module> node: top-level code of a file
  startLine: number; endLine: number;
  hash: string;            // hash of body text with whitespace normalised
  code: string;            // source text
  calls: string[];         // "recv|name" ('' = bare call, '?' = complex receiver) or "@tf.address"
  imports?: string[];      // module nodes: identifiers bound by imports
}

interface CallGraph { nodes: Map<FnId, FnNode>; edges: Set<`${FnId}->${FnId}`>; }
```

### 5.1 Call resolution (heuristic, static, untyped)

For a call `recv.name(...)` / `name(...)` (precision over recall: a missing edge is better than a wrong one):
1. `this/self/super` (and Go receiver variables) or a bare call inside a class → method of the same container.
2. `Type.method()` / `Type::new()` / `new Type()` / `Lib.fn()` → method of that container.
3. Bare call → same file, then a type name → its constructor (`constructor`, `__init__`, `new`).
4. Global by name, with filters: production code never links into test/mock files; `pkg.Fn()` prefers functions in a directory/file named `pkg`; a receiver that is an **imported package not found in the repo** is external (dropped); bare calls prefer the same directory (Go package).
5. Member calls on unknown receivers (`x.Close()`, `a.b.c()`) link only to methods, only for ≤ 2 candidates, and never for ubiquitous names (`Lock`, `Close`, `String`, `Error`, `New`, …).
6. Otherwise ≤ 3 candidates repo-wide; else dropped. Terraform references resolve by address within the same directory (module).

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

Server includes functions up to `maxDepth = 6` hops (undirected BFS over the union of base+head call edges) from changed functions, capped at 4000 nodes (nearest first); the UI filters by the current depth without a round-trip.

**Hub damping** (keeps depth ≥ 2 readable): context functions with > 25 call-graph neighbours are shown but not expanded (tooltip: "hub (N links)"); any single node pulls in ≤ 60 neighbours, changed ones first. On a chainlink PR this took depth 2 from ~1,880 to 109 functions.

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
- Queue status dots (prefetched / analysing / error), `?` shortcut sheet, empty state for PRs without function-level changes (folder layer switched on), responsive layout (queue folds into a top-bar prev/next below 980px).
- Changed-function list (j/k order) and changed-file list in the side panel; click to fly to the node.

## 8. HTTP API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/queue` | PR list (queue) + current index |
| GET | `/api/graph?key=<prKey>` | `GraphPayload` (computes or reads cache) |
| GET | `/api/status?key=<prKey>` | analysis progress text |
| GET | `/api/statuses` | state of every known analysis (queue dots) |
| GET | `/api/queue?refresh=1` | re-runs the PR listing |

Prefetching is automatic (§3), so there is no explicit prefetch endpoint.

## 9. Error handling
- `gh` missing / not authenticated → clear message with `gh auth login` hint.
- Grammar parse failures on a file → file skipped, counted in `stats.skippedFiles`.
- Huge repos → `--max-files` cap; files in the diff and their directory neighbourhood are kept first when capped.
- `gh` blocked by org **SAML SSO** (token not authorized) → for public repos fall back to the anonymous REST API (60 req/h) + anonymous HTTPS fetch, with a one-time warning explaining how to authorize the token.

## 10. Performance

Benchmarked on PRs of a large monorepo (`smartcontractkit/chainlink`, Go; ~3.2k source files parsed per commit after excluding generated code). Targets:
- cold analysis (repo already cloned) of a typical PR < 30 s; warm (parse cache hot, next PR in same repo) < 10 s; cached result < 200 ms.
- Techniques: blob-SHA keyed parse cache shared by base/head and across PRs, worker-thread parsing, numeric node-type dispatch (no type strings out of WASM), `git cat-file --batch` streaming, indexed call resolution, shallow 2-commit fetches, queue warm-up and 3-PR look-ahead.
- Measured (see BENCHMARKS.md): single PR 18.3 s → **2.4 s** (parse 10.1 s → 1.1 s; call graph 4.5 s → 0.8 s). In the browser, cycling 7 never-seen PRs with 1.5 s per PR: first PR 6.7 s (cold network), then **87–350 ms per `n`**.
- `npm run bench -- <owner/repo> [n]` prints a per-phase timing table (fetch, ls-tree, read blobs, parse, graph, diff, payload) to `BENCHMARKS.md`.

## 11. Testing
- Unit tests (node:test) for: parser extraction per language, call resolution, diff classification, stats.
- Fixture-based end-to-end test: create a temp git repo with two commits, run `local` analysis, assert payload; lcov line coverage of added lines.
- Browser checks (headless Chrome / Claude in Chrome): hover diff tooltip, folder layer, depth, N+1 timing, static export.
- `scripts/publish-pages.sh` tested against a local bare remote incl. concurrent publishers.

## 12. Milestones (all done for v0.1)
1. Spec (this file) + repo scaffold on GitHub.
2. Parser + call graph + diff + tests.
3. Git/GitHub integration + CLI picker.
4. Server + 3D UI (hover diff, depth, folder layer, stats, cycling).
5. Coverage, caching, prefetch, polish, README.

## 13. GitHub integration (one click from the PR)

See [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md) for the options analysis. Implemented: composite action `action.yml`:
`graph-diff export` in the checkout → publish to `gh-pages/pr/<n>/` → **commit status `graph-diff` with a Details link** (one click from the PR checks box) + sticky stats comment; removed on PR close.
Private repos are never published to (possibly public) Pages without explicit opt-in; they get a private artifact + job summary instead.

## 14. Conformance audit (v0.1)

| Spec item | Status | Notes |
|---|---|---|
| G1 list review-requested / all open PRs | ✅ | `review` (default), `list --all [--repo/--owner]`, `involves:@me` fallback; verified against a real account |
| G2 pick a PR, next/prev in browser | ✅ | TTY type-to-filter picker; `n`/`p`, buttons, queue list |
| G3 parse base + head into AST / call graph | ✅ | 7 languages + Java; tree-sitter WASM |
| G4 function & edge diff statuses | ✅ | renames mapped; per-function patches |
| G5 3D graph, hover shows local change | ✅ | hover tooltip with old/new line numbers; click pins full diff |
| G6 depth control | ✅ | 0–6, `[`/`]`; hub damping |
| G7 toggleable file/folder layer | ✅ | `f`; folders → files → functions |
| G8 stats: files, lines, coverage | ✅ | + functions, call edges, languages; static test reach + lcov |
| G9 fast cycling | ✅ | 87–350 ms per next PR on chainlink after warm-up (§10) |
| Interactive picker shows +/− | ⚠️ | not available from GitHub search API; shown in the UI after analysis |
| Hover file → GitHub | ⚠️ | file nodes show stats on hover; GitHub link lives in the pinned detail of functions |
| Type-accurate call resolution | ⛔ non-goal | heuristic; precision-first rules in §5.1 |
