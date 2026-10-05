# graph-diff review handbook

A 10-minute hands-on test. Each step has an **expected** result; if one doesn't hold, note it.

## 0. Setup (2 min)

```sh
git clone https://github.com/007vasy/graph-diff && cd graph-diff
npm ci && npm run build && npm link   # `graph-diff` on PATH
npm test                              # expect: # pass 5, # fail 0
gh auth status                        # must be logged in
```

## 1. Hosted view: one click from a PR (1 min)

1. Open https://github.com/007vasy/go-ethereum/pull/1 → checks box → **graph-diff → Details**.
   *Expect:* 3D graph opens on `007vasy.github.io`, title "[replay #35873] …".
2. Scroll the PR to the **graph-diff comment**.
   *Expect:* stats table, an "⚠️ not reached by any test" line, and a collapsible list of the largest changed functions.

## 2. Reading the graph (3 min)

| Try | Expect |
|---|---|
| Open **Legend ▾** (bottom-left) | explains every node and edge colour/shape |
| Hover a **yellow/green node** | tooltip with that function's diff (old/new line numbers) |
| Hover an **edge** | `caller → callee` + "new / removed / existing call" |
| **Click** a node | camera flies to it, full diff pinned bottom-right with a GitHub link |
| `j` / `k` | cycles through changed functions |
| `]` twice, then `[` | more / less call-graph context around the changes |
| `f` | file (blue) and folder (violet) nodes attach to functions |
| `?` | shortcut sheet |
| Right panel | files, lines ±, functions ±, call edges ±, test-reach %, changed-function list |

Sanity checks:
- Red/green edges should only touch a coloured (changed) node, never two grey ones.
- Red-ringed nodes = changed code that no test reaches. Spot-check one: is there really no test calling it?

## 3. Local CLI: the fast N+1 flow (3 min)

```sh
graph-diff                                         # your review requests → pick one
graph-diff list --all --repo ethereum/go-ethereum  # or any big public repo
```

1. Pick a PR in the terminal picker (type to filter). The browser opens.
   *Expect:* first PR ready in roughly 5–10 s (it downloads the two commits).
2. Spend a few seconds, then press **`n`** repeatedly.
   *Expect:* each next PR appears in **well under a second**. Queue dots turn green as PRs are pre-analysed.
3. `p` goes back instantly. Click any PR in the left list to jump to it.

Other modes:

```sh
graph-diff open https://github.com/owner/repo/pull/123
graph-diff local --base main --head HEAD          # inside any git repo, no GitHub
graph-diff local --coverage coverage/lcov.info    # adds lcov line coverage of new lines
```

## 4. Add it to a repo (1 min)

Copy `examples/graph-diff.yml` to `.github/workflows/`, open a PR, then:
*Expect:* a `graph-diff` status + comment within ~30 s, and the site at `https://<owner>.github.io/<repo>/pr/<n>/`
(Pages turns on automatically when `gh-pages` is first pushed; otherwise Settings → Pages → `gh-pages`).
⚠️ Private repo: the action deliberately does **not** publish to Pages (it could be public) unless `allow-private-pages: 'true'`.

## Known limits

- Call edges are **heuristic** (name-based, precision-first): some real calls are missing, rarely a wrong one.
- Languages: Go, Python, Rust, JS/TS, Solidity, Terraform (+ Java). Other files only count in file stats.
- Org with SAML SSO: authorize your `gh` token for the org, or only public repos work (anonymous API, 60 req/h).
- Fork PRs aren't covered by the example workflow (read-only token); see `docs/GITHUB_INTEGRATION.md`.

## Reporting

For anything odd, note the PR URL, what you did, what you expected vs saw, and a screenshot.
Open an issue at https://github.com/007vasy/graph-diff/issues.
