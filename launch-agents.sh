#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SPRINT_COORDINATION_DIR="${SPRINT_COORDINATION_DIR:-$(cd "$ROOT/.." && pwd)/SAAS-sprint-coordination}"

"$ROOT/scripts/init-coordination.sh" >/dev/null
"$ROOT/scripts/setup-worktrees.sh"

if ! command -v pi >/dev/null 2>&1; then
  echo "Pi is not on PATH. Install @earendil-works/pi-coding-agent first." >&2
  exit 1
fi

launch() {
  local title="$1" dir="$2" prompt="$3"
  if command -v wt.exe >/dev/null 2>&1; then
    wt.exe -w 0 new-tab --title "$title" -d "$(cygpath -w "$dir")" bash -lc "export SPRINT_COORDINATION_DIR='$(cygpath -u "$SPRINT_COORDINATION_DIR")'; pi --name '$title' '$prompt'; exec bash" >/dev/null 2>&1 &
  else
    echo "$title: cd '$dir' && export SPRINT_COORDINATION_DIR='$SPRINT_COORDINATION_DIR' && pi --name '$title' '$prompt'"
  fi
}

launch "Sprint Architect" "$ROOT" "Run /architect after the target brief is available. First inspect the sprint documentation and coordination state."
launch "Sprint Backend" "$ROOT/.worktrees/backend" "You are the backend worker. Wait for contract lock, then use /backend."
launch "Sprint Frontend" "$ROOT/.worktrees/frontend" "You are the frontend worker. Wait for contract lock, then use /frontend."
launch "Sprint Ops" "$ROOT/.worktrees/ops" "You are the ops worker. Wait for contract lock, then use /ops."

echo "Coordination: $SPRINT_COORDINATION_DIR"
