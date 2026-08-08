# SaaS Replication Sprint Workspace

A lightweight Pi + Git worktree workspace for a 48-hour SaaS replication sprint.

## Workflow

1. Start Pi in the root and reveal the target SaaS to the Architect.
2. Have the Architect lock only the contracts needed for the golden path.
3. Run `./launch-agents.sh` from Git Bash (or `./launch-agents.ps1` from PowerShell).
4. Workers implement non-overlapping vertical areas in their worktrees.
5. Workers commit small slices and write status to the external coordination directory.
6. The Architect merges one branch at a time, runs checks, and keeps `main` demoable.

## Coordination

Live coordination is outside Git at:

```text
../SAAS-sprint-coordination/
```

The launch scripts set `SPRINT_COORDINATION_DIR` to that path. Use `JEREMY-INBOX.md` for decisions and `STATE.md` for current status, requests, and merge notes.

Optional friction logging is documented in `docs/FRICTION_LOGGING.md`; it is intentionally not installed or made a merge gate by this scaffold.

## Quick commands

```bash
pi
./launch-agents.sh
# or from PowerShell:
./launch-agents.ps1
```

## Safety gates

See `REVIEW.md`, `docs/INVARIANTS.md`, and `docs/SPRINT_PLAYBOOK.md`. AI review supplements human review; it never replaces reading changed code and exercising the golden path.
