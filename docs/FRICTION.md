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

## 5. Vercel bakes environment variables at deploy time (major)
Editing a variable in Project → Settings → Environment Variables changes nothing
for the running deployment: the values are baked into the build. A corrected
`AIRTABLE_BASE_ID` looked "applied" in the dashboard while production kept
failing with the old value. **Mitigation:** treat every env edit as a two-step
operation — save, then **redeploy**, then re-verify the behaviour that depends
on it. The same applies to `SESSION_SECRET`, `GREENROOM_API_KEY`, and `APP_URL`.

## 6. Airtable base id vs. what you actually copied (moderate)
Two pastes in a row produced two different production failures. Pasting the
base **URL** into `AIRTABLE_BASE_ID` yields a table-level `404 NOT_FOUND` on
every table (it looks exactly like "the tables are named wrong"); a truncated or
whitespace-damaged PAT then yields `401`. **Mitigation:** `AIRTABLE_BASE_ID` is
only the `app…` segment of the base URL, never the whole URL and never the token
id; verify credentials with a single `curl` against the Airtable API before
redeploying, and read the status code — 404 means base/table, 401 means key.

## 7. Stale `.next/types` fails typecheck after switching branches (minor)
After building one worker branch and then checking out another, Next's generated
`.next/types/` still references routes that no longer exist, so `npm run
typecheck` fails with a phantom missing module in code you did not touch. It is
not a code defect and it bites whoever verifies two branches in either order.
**Mitigation:** `rm -rf .next tsconfig.tsbuildinfo` before re-running the gate.
