#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COORD="${SPRINT_COORDINATION_DIR:-$(cd "$ROOT/.." && pwd)/SAAS-sprint-coordination}"
mkdir -p "$COORD/status" "$COORD/requests" "$COORD/merge-queue"

if [ ! -f "$COORD/STATE.md" ]; then
  cat > "$COORD/STATE.md" <<'EOF'
# Sprint State

> Live local coordination. Entries may be stale; include timestamps and commit SHAs.

## Golden path
- [TBD after reveal]

## Locked contracts
- [TBD — Architect is sole writer]

## Active workstreams
- Architect: waiting for reveal
- Backend: blocked on contract lock
- Frontend: blocked on contract lock
- Ops: blocked on contract lock

## Requests to Architect
- None

## Merge queue
- Empty
EOF
fi

if [ ! -f "$COORD/JEREMY-INBOX.md" ]; then
  cp "$ROOT/docs/INBOX_TEMPLATE.md" "$COORD/JEREMY-INBOX.md"
fi

for role in architect backend frontend ops; do
  if [ ! -f "$COORD/status/$role.md" ]; then
    printf '# %s status\n\n- Not started.\n' "$role" > "$COORD/status/$role.md"
  fi
done

printf '%s\n' "$COORD"
