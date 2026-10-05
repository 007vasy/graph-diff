# Benchmarks

Repository: `smartcontractkit/chainlink` · 2026-10-05 · Node v22.14.0 · linux/x64

Timings are wall-clock per phase. **cold** = first PR (empty in-memory parse cache, objects not yet fetched);
**warm** = subsequent PRs reusing parsed files from the same process, as when cycling PRs in the UI.
`fetch` includes downloading the two commits (shallow) from GitHub.

| PR | cache | files Δ | lines | files parsed | fns +/~/− | graph fns | resolve | fetch | diff | lsTree | select | readBlobs | parse | callGraph | graphDiff | writeCache | total | RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [#23897](https://github.com/smartcontractkit/chainlink/pull/23897) | cold | 7 | +82/−29 | 3241 | 2/14/0 | 4000 | 0ms | 9ms | 12ms | 31ms | 5ms | 166ms | 1.5s | 1.1s | 211ms | 34ms | **3.1s** | 648 MB |

Re-opening smartcontractkit/chainlink#23897 from the analysis cache: **31ms** (incl. GitHub API round-trips to resolve the PR).
