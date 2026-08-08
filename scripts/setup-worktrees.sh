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
  if [ -e "$path/.git" ] || git worktree list --porcelain | grep -Fq "worktree $ROOT/$path"; then
    echo "$role worktree already exists"
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
