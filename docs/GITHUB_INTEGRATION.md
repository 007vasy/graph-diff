# GitHub integration: one click from the PR

Goal: a reviewer opens a PR on github.com and gets to the 3D call-graph diff in **one click**,
with nothing to install. GitHub only hosts static files (Pages), so graph-diff has a **static export**
(`graph-diff export`): `index.html` + JS bundle + one `graph-N.json` per PR, no server needed.

## Options considered

| # | Approach | One click? | Private code safe? | Fork PRs | Effort | Verdict |
|---|---|---|---|---|---|---|
| A | **Action → `gh-pages/pr/<n>/` + commit status "Details" link + sticky comment** | ✅ checks box & comment | ⚠️ Pages is public unless Enterprise Cloud private Pages | needs 2-workflow variant | low | **Recommended (implemented)** |
| B | Action → workflow artifact + job summary | ❌ download + unzip + local server | ✅ | ✅ | low | fallback for private repos (implemented, `publish: artifact`) |
| C | Action → `actions/deploy-pages` | ✅ | ⚠️ same as A | ❌ | low | ❌ each deploy *replaces* the whole site, so concurrent PRs clobber each other |
| D | Hosted viewer on Pages that pulls the analysis from the Actions artifact API | ✅ | ✅ (token needed) | ✅ | medium | needs the viewer to hold a GitHub token (OAuth app) → later |
| E | GitHub App + Checks API (`details_url`, rich check summary) | ✅ | depends on hosting | ✅ | high | the "product" version; same static site underneath |
| F | Browser extension: "Open in graph-diff" button on PR pages → `graph-diff open <url>` via local protocol handler | ✅ | ✅ (all local) | ✅ | medium | best for private monorepos; works with the existing CLI/server |
| G | Cloudflare Pages / S3+CloudFront with SSO in front | ✅ | ✅ | ✅ | medium | private-repo version of A; swap `publish-pages.sh` for a `wrangler pages deploy` |

## What's implemented (A + B)

`action.yml` (composite action) + `examples/graph-diff.yml`:

1. On `pull_request` (opened / synchronize / reopened / ready_for_review) it builds graph-diff, runs
   `graph-diff export --base origin/<base> --head <head sha>` inside the checkout (local mode — no extra API calls),
   and writes `summary.md` to the job summary.
2. **Publish** the site to `gh-pages` under `pr/<number>/` with `scripts/publish-pages.sh`, which only touches
   that directory and retries on push races (tested with concurrent publishers).
3. **Commit status** `graph-diff` on the head SHA: description `fns +2 ~14 −0 · calls +3 −9 · test reach 100%`,
   **Details →** opens `https://<owner>.github.io/<repo>/pr/<n>/`. It shows in the PR's checks box: that's the one click.
4. **Sticky comment** (marker `<!-- graph-diff -->`, updated in place on every push) with the stats table,
   the largest changed functions and their test reach, and the link.
5. On `closed`, `pr/<n>/` is removed from `gh-pages`.

### Safety rails
- **Private repos**: GitHub Pages sites are public on Free/Pro/Team plans, even for private repositories, and the
  export contains the changed code. The action **refuses to publish private repos to Pages** unless
  `allow-private-pages: 'true'` is set; otherwise it uses `publish: artifact` (private), job summary and comment.
- **Forks**: `pull_request` runs from forks get a read-only token, so the example workflow skips fork PRs.
  To cover them, split into two workflows: (1) `pull_request` runs the export and uploads the site as an artifact;
  (2) `workflow_run` (trusted, has write token) downloads it and runs the publish/status/comment steps.
  Never check out and *execute* fork code in the `workflow_run` job; it only moves static files.
- `concurrency` per PR cancels outdated runs; the publish script handles cross-PR races.

### Setup (target repository)
1. Copy `examples/graph-diff.yml` to `.github/workflows/`.
2. Settings → Pages → *Deploy from a branch* → `gh-pages` / root (the branch is created on first run).
3. Optional: run tests with coverage first and pass `coverage: coverage/lcov.info`.

> `uses: 007vasy/graph-diff@main` only works from other repositories if this repository is **public**
> (or shared via *Settings → Actions → Access* within the same org/user on paid plans).

## Next steps
- **D/E** for private code without Enterprise: viewer on Pages + the Actions artifact API, or a small GitHub App.
- **F** browser extension: a button on `github.com/*/pull/*` that hands the URL to the local `graph-diff open`
  (via a `graph-diff://` protocol handler registered by `graph-diff install`). Zero hosting, works for any repo
  the user can clone, and keeps the fast N+1 queue/prefetch flow.
- Index page on `gh-pages` listing open PRs (newest first) so reviewers can cycle through PRs on Pages too.
