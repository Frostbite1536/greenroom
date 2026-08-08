#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COORD="${SPRINT_COORDINATION_DIR:-$(cd "$ROOT/.." && pwd)/SAAS-sprint-coordination}"

echo "== Worktrees =="
git -C "$ROOT" worktree list || true
for role in backend frontend ops; do
  dir="$ROOT/.worktrees/$role"
  if [ -d "$dir" ]; then
    echo
echo "== $role =="
    git -C "$dir" status --short --branch
  fi
done

echo
echo "== Coordination =="
echo "$COORD"
for file in "$COORD"/status/*.md; do
  [ -e "$file" ] && echo "- $(basename "$file")"
done
