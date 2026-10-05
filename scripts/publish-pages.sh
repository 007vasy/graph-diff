#!/usr/bin/env bash
# Add or remove one directory on the GitHub Pages branch without touching anything else on it.
#   publish-pages.sh add    <branch> <dest-dir> <src-dir>
#   publish-pages.sh remove <branch> <dest-dir>
# Runs inside a checkout of the repository; uses a temporary worktree and retries on push races
# (several PRs publishing at once).
set -euo pipefail

op=$1 branch=$2 dest=$3 src=${4:-}
remote=${PUBLISH_REMOTE:-origin}
wt=$(mktemp -d)
trap 'git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"' EXIT

git config user.name >/dev/null || git config user.name "graph-diff[bot]"
git config user.email >/dev/null || git config user.email "graph-diff[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  if git fetch --quiet "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch" 2>/dev/null; then
    git worktree add --quiet --force --detach "$wt" "$remote/$branch"
  else
    # First publish: create an orphan Pages branch.
    git worktree add --quiet --force --detach "$wt"
    git -C "$wt" checkout --quiet --orphan "$branch"
    git -C "$wt" rm -rf --quiet . >/dev/null 2>&1 || true
    touch "$wt/.nojekyll"
    printf '<!doctype html><meta charset="utf-8"><title>graph-diff</title><p>Per-PR call-graph diffs live under <code>/pr/&lt;number&gt;/</code>.</p>\n' > "$wt/index.html"
  fi

  rm -rf "${wt:?}/$dest"
  if [ "$op" = add ]; then
    mkdir -p "$wt/$dest"
    cp -R "$src"/. "$wt/$dest/"
  fi
  touch "$wt/.nojekyll"

  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then
    echo "graph-diff: nothing to publish for $dest"
    exit 0
  fi
  git -C "$wt" commit --quiet -m "graph-diff: $op $dest"
  if git -C "$wt" push --quiet "$remote" "HEAD:refs/heads/$branch"; then
    echo "graph-diff: $([ "$op" = add ] && echo published || echo removed) $dest on $branch"
    exit 0
  fi
  echo "graph-diff: push raced with another publish (attempt $attempt), retrying…" >&2
  git worktree remove --force "$wt"
  wt=$(mktemp -d)
  sleep $((attempt * 2))
done
echo "graph-diff: failed to publish after retries" >&2
exit 1
