# <img src="web/favicon.svg" width="28" align="top"> graph-diff

Review pull requests as a **3D call-graph diff**. Pick a PR and see which functions were added, changed
or removed, what calls them, and what they call. Hover a node to read its diff, then press `n` for the next PR.

- **Languages:** Go, Python, Rust, JavaScript, TypeScript/TSX, Solidity, Terraform (and Java), via tree-sitter.
- **Graph:** functions coloured by diff status, call edges added/removed, adjustable depth, toggleable file/folder layer.
- **Stats:** files, lines ±, functions ±, call edges ±, test reach (static), and lcov line coverage of new lines.
- **Fast N+1 review:** the whole PR queue is resolved and fetched up front, and the next 3 PRs are pre-analysed, so `n` is ~100 ms ([BENCHMARKS.md](BENCHMARKS.md)).

## Install

```sh
git clone git@github.com:007vasy/graph-diff.git && cd graph-diff
npm ci && npm run build && npm link     # puts `graph-diff` on your PATH
```

Requires Node ≥ 20, git, and the [GitHub CLI](https://cli.github.com) (`gh auth login`).

## Use

```sh
graph-diff                                # PRs waiting for your review → pick one → browser opens
graph-diff list --all --repo owner/repo   # all open PRs of a repo
graph-diff list --all --owner my-org      # all open PRs of an org
graph-diff open owner/repo#123 https://github.com/o/r/pull/45
graph-diff local --base main --head HEAD  # two local refs, no GitHub needed (auto-uses coverage/lcov.info)
graph-diff export -o site/ owner/repo#123 # static site for hosting
```

| key | action |
|---|---|
| `n` / `p` | next / previous PR |
| `j` / `k` | next / previous changed function |
| `[` / `]` | call-graph depth |
| `f` | file / folder layer |
| `l` | all labels |
| `/` | find function |
| `?` | help |

Hover a node to see its function-level diff. Click it to pin the full diff, with a link to the code on GitHub.

## GitHub Action: one click from the PR

```yaml
# .github/workflows/graph-diff.yml (full example: examples/graph-diff.yml)
on: { pull_request: { types: [opened, synchronize, reopened, closed] } }
permissions: { contents: write, pull-requests: write, statuses: write }
jobs:
  graph-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: 007vasy/graph-diff@main
```

Each PR gets a `graph-diff` commit status whose **Details** link opens the graph on GitHub Pages, plus a sticky stats comment.
Private repos are not published to Pages unless you opt in. See [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md).

## How it works

[SPEC.md](SPEC.md) covers the details. In short, it does a shallow fetch of the merge-base and head commits, parses both
trees with tree-sitter in worker threads (cached by blob SHA), resolves calls with precision-first heuristics, and diffs the
two graphs per function. It then serves the result to a [3d-force-graph](https://github.com/vasturiano/3d-force-graph) UI.

```sh
npm test                                       # unit + end-to-end tests
npm run bench -- smartcontractkit/chainlink 6  # per-phase timings → BENCHMARKS.md
```
