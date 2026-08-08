#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a Git repository. Run git init and create the baseline commit first." >&2
  exit 1
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "The repository needs at least one commit before worktrees can be created." >&2
  exit 1
fi

mkdir -p .worktrees

create_worktree() {
  local role="$1" branch="$2" path=".worktrees/$1"
  if [ -e "$path/.git" ]; then
    if [ -n "$(git -C "$path" status --porcelain)" ]; then
      echo "$role worktree has uncommitted changes; refusing to sync it to main." >&2
      exit 1
    fi
    git -C "$path" merge --ff-only main
    echo "$role worktree synced to main"
  elif git worktree list --porcelain | grep -Fq "worktree $ROOT/$path"; then
    echo "$role worktree is registered at an unexpected path representation; inspect 'git worktree list'." >&2
    exit 1
  elif git show-ref --verify --quiet "refs/heads/$branch"; then
    git worktree add "$path" "$branch"
  else
    git worktree add -b "$branch" "$path" main
  fi
}

create_worktree backend feat/backend-api
create_worktree frontend feat/frontend-ui
create_worktree ops feat/ops-demo

echo "Worktrees ready under $ROOT/.worktrees"
