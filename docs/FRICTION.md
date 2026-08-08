# Friction Log

Reproducible tooling/workflow papercuts hit during the sprint. Plain markdown
(frog CLI was abandoned — see entry 4). No secrets, no one-off mistakes.

## 1. `taskkill /IM node.exe` kills every pi agent (major)
pi agents are Node processes. A worker ran `taskkill /F /IM node.exe` to free a
stale dev-server port and force-killed all three worker agents plus the idle
orchestrator mid-turn (the 04:18 incident); one coordination file write was
lost. **Mitigation:** never kill Node by image name. Use `npx kill-port <port>`
or find the exact PID (`netstat -ano | findstr :<port>`) and
`taskkill /PID <pid> /T /F`. Give each worker a dedicated port range
(backend 321x, frontend 322x, ops 323x).

## 2. Missing `node_modules` makes `npm run typecheck` false-green (major)
In a fresh Git worktree without `node_modules`, `npm run typecheck` can resolve
a globally-installed `tsc` and "pass" without project dependencies or the
generated Prisma client, producing a false-green verification gate.
**Mitigation:** run `npm install` (and `prisma generate`) in every worktree
before trusting any check; verify `node_modules/@prisma/client` exists.

## 3. `server.kill()` orphans listeners on Windows under `shell: true` (minor)
`child_process.spawn(..., { shell: true })` wraps the command in a shell;
`server.kill()` kills the shell but not the grandchild Node server, orphaning
the listener and holding the port across smoke-test runs. **Mitigation:** track
the spawned PID and kill the whole tree (`taskkill /PID <pid> /T /F`), as
`scripts/_smoke.mjs` now does.

## 4. frog CLI: `STORE_ROOT_MISMATCH` on Windows + git-bash (upstream bug)
`frog log` fails with `STORE_ROOT_MISMATCH` because the store root resolves as
`C:\Users\...` while git-bash passes `--cwd` as `/c/Users/...` and the string
comparison fails. Also note `frog init` creates `.github/ISSUE_TEMPLATE/`
(repository automation) as a side effect. Friction logging for this repo is
plain markdown in this file instead. Needs an upstream fix or wrapper; not
sprint-worthy.
