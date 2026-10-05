# Benchmarks

Repository: `smartcontractkit/chainlink` · 2026-10-05 · Node v22.14.0 · linux/x64

Timings are wall-clock per phase. **cold** = first PR (empty in-memory parse cache, objects not yet fetched);
**warm** = subsequent PRs reusing parsed files from the same process, as when cycling PRs in the UI.
`fetch` includes downloading the two commits (shallow) from GitHub.

| PR | cache | files Δ | lines | files parsed | fns +/~/− | graph fns | resolve | fetch | diff | lsTree | select | readBlobs | parse | callGraph | graphDiff | writeCache | total | RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [#23897](https://github.com/smartcontractkit/chainlink/pull/23897) | cold | 7 | +82/−29 | 3241 | 2/14/0 | 4000 | 0ms | 9ms | 12ms | 31ms | 5ms | 166ms | 1.5s | 1.1s | 211ms | 34ms | **3.1s** | 648 MB |

Re-opening smartcontractkit/chainlink#23897 from the analysis cache: **31ms** (incl. GitHub API round-trips to resolve the PR).

## Optimisation history (chainlink #23897, same machine)

| version | parse | callGraph | total |
|---|---|---|---|
| single-threaded, string node-type dispatch | 10.1s | 4.5s | 18.3s |
| worker pool (8) + numeric type dispatch + indexed resolution | 1.1s | 0.8s | **2.4s** |

## N+1 review cycling (browser, end to end)

Measured in Chrome via `graph-diff open` on 7 chainlink PRs never analysed before (`--no-cache`, commits not fetched yet).
The reviewer spends 1.5 s on each PR, then presses `n`; time = keypress → next graph rendered.

| PR | files Δ | fns Δ | `n` → graph | prefetch state at keypress |
|---|---|---|---|---|
| #23884 | – | – | 6.7 s | first PR (cold: resolve + fetch + parse) |
| #23882 | 29 | 69 | 114 ms | done |
| #23880 | 3 | 14 | 225 ms | done |
| #23878 | 5 | 54 | 139 ms | done |
| #23877 | 1 | 0 | 350 ms | done (empty state) |
| #23865 | 2 | 8 | 149 ms | done |
| #23858 | 6 | 19 | 87 ms | done |

Before queue warm-up + 3-PR look-ahead (only 1 PR prefetched, network per PR): **4.6–6.1 s** per `n`.
Per-PR server time then was ~6.5 s, of which resolve 1.8 s + fetch 2.9 s were network; parse 0.3 s (warm cache), call graph 1.0 s.
