# How this was built

This document is written for a reader who intends to check it. Every claim below
carries a receipt that resolves inside this repository or its pull request
history: a PR number, a GitHub comment id, a `file:line`, or an exact test name.
Where a receipt could not be produced, the claim was removed rather than
softened — the deliberate exclusions and honest gaps at the end are part of that
same discipline.

Scope of the record: 101 pull requests, all merged, none closed unmerged
(`gh pr list --state all`); 722 commits on `main`, 177 of them merges
(`git rev-list --count origin/main`, `--merges`).

---

## 1. Two tracks, one auditing the other

The build ran as two agent teams working from separate worktrees against the
same repository. One track implemented features; a second track — designated
Track A in the PR record — ran independent admission gates against the *exact
head commit* of the other track's pull request and could refuse the merge.

The receipts are GitHub comments on the pull requests they held:

| PR | Track A comment id | Outcome |
| --- | --- | --- |
| #93 | `5256076383`, `5256377286`, `5256745952` | three successive **HOLD**s |
| #93 | `5257072156` | admission granted at exact head `1bcadb2` |
| #95 | `5258355726` | binding receipt at exact head `05aacf9` |

PR #93 is the clearest example of the process doing work that a single track
would not have done. The feature under review was the C33 provisioning/fan-out
lock. Track A did not re-read the diff; it reproduced the concurrency proof in a
**different database environment** — a uniquely named fresh local PostgreSQL 16
instance rather than the shared hosted Postgres the building track used: the
same engine, a different target. All four product outcomes were correct in both
interleavings, but the test's own
blocking observer did not reproduce, and Track A held the merge on that alone
(comment `5256377286`). In the same review it found a defect the building track
had not: an observer or setup exception raised after the first racer parks could
bypass the barrier release, strand that transaction, and block cleanup.

That finding is closed by an executable test that is in the repository today. The
fault is injected while the first transaction is parked
(`lib/services/session-provisioning-fanout-race.test.ts:490-564`) and the
release-settle-cleanup sequence is asserted at
`lib/services/session-provisioning-fanout-race.test.ts:624-667`, under the test name
`"C33 lifecycle: a fault while the first transaction is parked still releases, settles and cleans up"`.
That the test genuinely exercises the liveness defect rather than restating it is
recorded in commit `5dd3273`, which captures the red 300-second timeout produced
when the release is moved after the cleanup.
Admission followed at comment `5257072156` with the C33 matrix at **5/5**,
proving `pg_blocking_pids` and `Lock:advisory`, with post-run residue of zero
events, zero users, and zero connections.

The reviewing track also **rejected** findings. On PR #95, an automated
reviewer's diagnostics finding was adjudicated false by Track A on three stated
grounds — raw error logging would expose PII, the console is not durable
telemetry, and the mock-safe fallback was deliberate — and the finding was
recorded as rejected rather than quietly applied (PR #95 body, "Review-round
corrections absorbed (Track A findings)").

**One process failure, recorded rather than hidden.** PR #78 exists because two
independently green pull requests turned `main` red together: #76 pinned the
abstract serializer's speaker projection at four fields and #77 added a fifth
(`role`). `main` sat red at 825 passing of 826; PR #78 named all five projected
fields and restored 826/826. The PR body names the cause of the escape — the
schema-window union gate had run build and smoke but *not* the full unit suite —
and records that the union procedure was changed to include it.
PR #78 is a one-line receipt for why the gate stack below is ordered the way it
is.

---

## 2. The gate stack

Once this stack was established, every change admitted through PR #103 passed
these gates in this order:

1. Full unit suite
2. Fresh production build
3. Typecheck (application and E2E)
4. Backend and frontend smokes, serialized
5. Browser proof (Playwright / Chromium)
6. Automated review pinned to the exact head (through PR #103)
7. Cross-track admission

After PR #103, Jeremy disabled the automated-review service because its cost no
longer justified a third opinion. PRs #104 and #105 retained the rest of the
stack and replaced that unavailable step with an independent exact-head xhigh
reviewer distinct from the author lane, followed by Track A's separate binding
gate. This is a dated process boundary, not a retroactive claim that the earlier
automated reviews did not run.

The scoping in that first sentence is deliberate. The stack was not complete
from the first commit, and PR #78 is the receipt for the gap: the schema-window
union procedure at that time ran build and smoke but not the full unit suite,
which is how two independently green pull requests merged into a red `main`.
The unit suite was added to that procedure in response. Claiming the stack held
for *every* change in the project's history would be false, and this document
does not claim it.

Two of these orderings are not arbitrary, and both have mechanical receipts.

### Why the build runs before the typecheck

`tsconfig.json:35-36` includes `.next/types/**/*.ts` and
`.next/dev/types/**/*.ts` in the compilation. Those files are generated route
types — `tsc --noEmit` reads them but does not produce them. A typecheck run
against a stale or absent `.next` therefore validates the route surface of a
*previous* build, not the current one, and passes for the wrong reason. The
build is what refreshes the validator's own inputs.

### Why the smokes are serialized

All workers shared a single database. `docs/DECISIONS.md:68-73` records the rule
and the symptom that produced it: concurrent seeds and smokes caused P2002
unique-constraint collisions and Postgres deadlocks. The mitigation is written
into the harness rather than left to convention —
`scripts/_frontend-smoke.mjs:4` states that the script is "Scoped entirely to
the `scratch-frontend` event per the DB concurrency rule", and `:19`, `:84-99`
define its per-scenario scratch event ids. Running two smokes at once against
one database produces failures that are artifacts of the harness, not of the
product.

The same discipline is enforced for destructive test paths by a guard that fails
closed rather than trusting an environment variable: `e2e/db-guard.ts:57`
(`assertDisposableDatabase`), pinned by
`lib/e2e-safety-contract.test.ts:8`,
`"the disposable-database guard refuses missing and mismatched assertions"`.
The C33 race proof is gated behind the same guard plus an explicit `RACE_PROOF=1`
opt-in (`lib/services/session-provisioning-fanout-race.test.ts:93-96`), which is
why `npm test` needs no database at all.

### Gate counts

Two separate runs, labelled separately rather than merged into one number.

**Product baseline** — commit `14c2d40`, the merge this document's branch is
based on, run before any edit in this branch existed:

| Gate | Result |
| --- | --- |
| `npm test` | **1,960 pass / 0 fail / 5 skipped** (1,965 total) |
| `npm run typecheck` | pass |
| E2E typecheck | pass |
| `npm run build` | pass |

**Documentation-only receipt tree** — the same four gates were re-run after the
process-document edits and returned identical results. Those results cover
`ff2e32c`, the documentation-only source head, not the later landing-page
runtime change in the combined judge-extension integration. The process
documentation does not alter product behavior or invalidate captured evidence;
no result in this block is presented as a receipt for the combined tree or its
eventual deployment.

The suite grew across the cycles, and the counts are traceable: **1,507** at
PR #93's admission (comment `5257072156`), **1,671** at PR #95's binding receipt
(comment `5258355726`), and **1,960** at PR #100 and PR #101 (both PR bodies)
and at commit `14c2d40`.

Smoke and browser results are not re-run here — this lane touches documentation
only and runs no database tests. They are attributed to their own receipts:
backend/frontend **446/446 + 594/594** and focused Chromium **2/2** at reviewed
head `e259d5a` (PR #100 body).

---

## 3. Evidence discipline: dual provenance instead of relabelling

Screenshots, the clean-install rehearsal, and the twice-run golden-path E2E were
captured at one exact product commit, `7f34b6e`. Additive reviewed work merged
afterwards, which meant the deployed head no longer equalled the captured head.

The artifacts were not re-captured, re-dated, or relabelled. PR #101 added a
provenance section that separates the deployed tree from the captured product
and states what each one covers:
[`docs/judging/README.md`](README.md#post-release-deployment-provenance),
"Post-release deployment provenance". The current addendum names `14c2d40` as
the pre-polish deployment basis, keeps PR #100 receipts attached to reviewed
head `e259d5a`, and says explicitly that the later landing-page runtime change
is not depicted by the preserved screenshots.

The same file's header carries separate identities rather than collapsing them
into one: pre-polish deployment basis, captured evidence product, evidence
tooling/artifacts, and the two judge-extension source heads.
`docs/judging/PERFORMANCE.md:10-15`
applies the same rule to measurements, marking its public-route numbers as
historical to a pre-cutover deployment rather than presenting them as current.

---

## 4. Patterns an auditor may want to check

Each entry names where the behaviour lives and the test that pins it.

### Fail-closed on missing configuration

Signing refuses rather than falling back: `lib/auth.ts:151-152` throws when no
adequate `SESSION_SECRET` is configured. Pinned by `lib/auth.test.ts:37`,
`"production fails closed when its configured secret is missing or too short"`.

Environment validation runs at boot and rethrows, so a misconfigured deployment
does not start: `lib/env.ts:145` (`throw new ServerEnvError`), wired through
Next's `register()` hook at `instrumentation.ts:30-44`. That the wiring itself
exists is pinned by `lib/env.test.ts:139`,
`"D-02: getServerEnv is actually wired to Next's boot hook"`.

The optional AI provider is disabled, never faked, when unconfigured:
`lib/assistant/client.ts:434-438` returns before both the fetch and the log.
Pinned by `lib/assistant/client.test.ts:110`,
`"with no key the assistant is disabled: no provider call, no fabricated draft"`.

### Event-scoped authorization and tenant isolation

`lib/api/v1.ts:219-221` (`v1EventWhere`): a per-event credential ANDs its own
`eventId` into the query predicate, so another event's row is excluded by the
*absence of a row* rather than read and then rejected. The comment at `:215-217`
states the reason — the alternative would make a per-event credential an
enumeration oracle. Pinned by `lib/services/api-credential.test.ts:327`,
`"a per-event credential constrains the event query itself"`, and `:347`,
`"cross-event and unknown selectors are 401 for a per-event credential, 404 only for a global key"`.

The general rule is INV-EVENT-001 (`docs/INVARIANTS.md:4`): every protected read
and write re-resolves the `EventMember` row server-side. The signed session does
carry identity, active-event, and asserted-role claims, but none grants
authority: `getResolvedSession` re-reads the current membership and its role
from Postgres (`lib/auth.ts:223-244`). As the source states at `:254`, "a signed
claim identifies someone, it never grants them anything."

### Concurrency, with a real blocking proof

Writers take transaction-scoped Postgres advisory locks —
`lib/services/abstract-lock.ts:22` and `lib/services/onboarding-task-lock.ts:49`
both issue `pg_advisory_xact_lock(hashtextextended(...))`. The invariant is
INV-ABSTRACT-001 (`docs/INVARIANTS.md:10`).

What makes this checkable rather than asserted is that the proof does not use
sleeps or mocks. `lib/services/session-provisioning-fanout-race.test.ts` drives
two Prisma clients through both interleavings of a four-cell matrix against a
real Postgres, then asks the **server** whether the second writer is blocked:
`:601-610` unconditionally asserts `secondWriterBlocked: true` from
`pg_blocking_pids`. Where the server populates the wait-state field,
`:613-615` additionally asserts that it matches `/advisory/i` — "the block must
be on the advisory fan-out lock". Test name (a template, expanding to four):
`` `C33 (${mode}, ${order}): the new confirmed speaker holds the new required task exactly once` ``.
The lock ordering is separately pinned statically by
`lib/services/session-provisioning-lock.source.test.ts:146`,
`"C33: no writer takes the abstract lock after the fan-out lock"`.
`docs/DECISIONS.md:207-235` records why the lock is taken at the entry points
rather than in the routes or the low-level fan-out.

### Sanitization and privacy boundaries

`lib/sanitize-html.ts:43` (`sanitizeHtml`) is an allowlist sanitizer that
removes dangerous elements including their contents. Pinned by
`lib/sanitize-html.test.ts:28`,
`"blocks javascript: and data: hrefs but keeps http(s)"`, and `:34`,
`"blocks obfuscated javascript URLs using control characters"`.

It runs at both ends deliberately. `docs/DECISIONS.md:193-199` records that
authored bodies are sanitized before storage *and* again on render, because rows
also arrive from the seed and could arrive from a future importer, so neither end
may assume the other cleaned the bytes.

### What reaches the AI provider

The projection sent for a decision note is a hand-built type with exactly four
fields — event name, title, decision, bounded comments —
`lib/assistant/decision-note.ts:284-290`. No speaker address, reviewer identity,
score, user id, or event id can ride along. Pinned by
`lib/assistant/decision-note.test.ts:154`,
`"the prompt carries the four allowed facts and nothing adjacent to them"`, and
against prompt injection by `:242`,
`"a hostile comment appears only as delimited data and forges no field"`.

The product does not claim more than this. `docs/DECISIONS.md:249-251` states
plainly that free-text reviewer excerpts can themselves contain identifying
text, "so the UI says so instead of claiming that names or addresses can never
leave."

### Non-retention on the provider call

`lib/assistant/client.ts:452-454` sets `store: false`, with the reason in the
comment: reviewer comments must not become a conversation held on the provider's
side. This is pinned twice — behaviourally by
`lib/assistant/client.test.ts:150`,
`"the outbound request is non-retained, capped, and carries no tools, stream, or history"`
(the assertion at `:169` checks `body.store` is a real `false`, not merely
absent), and at source level by `lib/assistant/client.test.ts:827`,
`"the request stays non-retained, tool-free, stateless, and abort-bounded"`, so
the flag cannot be silently removed.

Note for accuracy: this is an OpenAI-style Responses API `store: false`, not a
vendor zero-retention header.

### Split-token API credentials

An issued token is `grk_<lookupId>_<secret>` built from two independent CSPRNG
draws (`lib/services/api-credential.ts:101-108`); only the SHA-256 digest of the
secret half is stored (`:112-114`). Verification is a keyed point read on the
indexed `lookupId` — never a scan, never a prefix match —
`lib/services/api-credential-store.ts:76-78`, followed by a constant-time
comparison of two fixed-size digests via `timingSafeEqual`
(`lib/services/api-credential.ts:151-158`).

Two details worth reading the source for. The token is split **positionally**,
not by `split("_")`, because base64url's alphabet contains `_` and the secret
half may legitimately contain the separator (`:116-141`). And the length guard
before `timingSafeEqual` is not an early exit around constant time — the
reasoning is stated at `:143-150`.

Pinned by `lib/services/api-credential.test.ts:63`,
`"an issued token is CSPRNG material in two halves, and only the secret's digest is stored"`;
`:159`, `"secret verification compares fixed-size digests and rejects everything else"`;
and `:294`,
`"unknown, revoked, and wrong-secret credentials are one indistinguishable refusal"`.

### Keyset pagination where the data moves — and offset where it does not

This is a per-surface decision, not a blanket rule, and the repository shows
both choices.

The email dispatch log pages by keyset. `lib/comms/email-history.ts:402-421`
(`emailHistoryKeysetWhere`) writes the row-value comparison the long way —
`createdAt < a OR (createdAt = a AND id < b)` — because Prisma has no tuple
operator and its own `cursor:` requires a unique index that `(createdAt, id)` is
not. `docs/DECISIONS.md:277-295` records that this was a **correctness fix found
in review of PR #97**, not a preference: offset over a growing log makes one
inserted row shift every later page, and one `queued` row resolving to `sent`
under a status chip shifts them the other way, so a row is never rendered at
all. Neither failure announces itself.

The three failure modes are proved literally, not argued —
`lib/comms/email-history-stability.test.ts:188`,
`"a dispatch inserted between two page requests neither duplicates nor omits a row"`;
`:260`, `"a bulk send sharing one millisecond pages exactly, tie by tie"`; and
`:306`, `"a stale anchor asking for newer reads the newest page, not the oldest one"`.
The `id` tie-break is load-bearing rather than defensive: a bulk send writes many
rows inside one millisecond.

The public v1 API deliberately keeps **bounded offset** paging
(`lib/api/v1.ts:55-56`, `hasMore`/`nextOffset`), pinned by `lib/api/v1.test.ts:73`,
`"v1 query requires an event and bounds offset pagination"`. `docs/DECISIONS.md:422`
states the position: offset remains the stable browse contract for that surface.

---

## 5. Deliberate exclusions

Each of these was decided and recorded, not overlooked. Several are enforced by
tests, which is the difference between a scope decision and an absence.

- **Outbox pattern.** Email and Airtable delivery run serially in-request.
  `docs/judging/README.md:241-243` states this is adequate at demo scale and
  names an outbox as the real-scale answer.
- **Webhooks and agent writes.** `docs/DECISIONS.md:431-434` holds generic
  webhooks and agent writes on the post-release roadmap explicitly.
- **Full CSP.** Route-aware `nosniff`, HSTS, referrer, permissions, and
  frame-ancestors headers are set (`next.config.mjs:22-23`, `:61`); a full
  `script-src`/`style-src` CSP is not. The reason is at `next.config.mjs:4-13`:
  `frame-ancestors 'none'` would break the product's own embed feature, so embed
  paths are excluded from that rule rather than the feature being dropped. The
  exclusion is itself test-enforced — `lib/security-headers.test.ts:129`,
  `"no full CSP is smuggled in — script-src is explicitly out of scope"`, and
  `:102`, `"embeds stay frameable — the whole reason the policy is route-aware"`.
- **Versioned migrations.** Schema changes apply through audited `db push`
  windows; `prisma/` contains `schema.prisma` and `seed.ts` and no `migrations/`
  directory. Recorded as an accepted audit finding at
  `docs/judging/README.md:240-242`. The windows themselves are logged on the PRs
  that used them (PR #98 comments `5261283853` and `5261291002`, open and close).
- **Incremental sync.** `docs/DECISIONS.md:422-429` states why it is unshipped
  rather than pending: a fixed application-time watermark alone cannot prove that
  a transaction with an earlier `updatedAt` committed before every page query. It
  needs a database-level snapshot design first.
- **A public demo API credential.** `docs/DECISIONS.md:398-404` records that the
  existing `/submissions` projection is integration-private — it includes
  proposal text, answers, and speaker contact fields — so no current key is safe
  to publish, and publishing the deployment-wide key would be worse because it
  reaches every event. The stated conclusion is that documentation alone cannot
  narrow a credential.

---

## 6. Honest gaps

**Accessibility evidence is mostly automated.** Every audited route scored 100
on Lighthouse accessibility at the recorded measurement
(`docs/judging/PERFORMANCE.md`), and automated tooling is not an accessibility
review.

A **partial** manual screen-reader pass was performed on production on
2026-08-12 by the project owner, using NVDA with Brave on Windows. Results, as
recorded in `docs/judging/PERFORMANCE.md`:

- Journey 1 (sign-in / demo persona login through to the admin dashboard):
  6 of 6 checkpoints PASS.
- Journey 2 (admin shell — landmarks and navigation): CP2.1–CP2.2 and CP2.4–CP2.7
  PASS; **CP2.3 is a minor FAIL** — reaching the main landmark took 6 <kbd>D</kbd>
  presses against a threshold of 5 or fewer.
- Journey 3 (review queue → accept a proposal): CP3.1–CP3.7 PASS, CP3.8
  **not confirmed**, CP3.9 **not run**.
- Journeys 4–10: **not run**.

The cause of the CP2.3 miss is known and checkable in this repository: there is
**no skip link anywhere in the application**, so landmarks are the only bypass
mechanism a screen-reader user has. A search of `app/`, `components/`, and
`lib/` returns no skip-link implementation, against 14 `<main>` landmark
elements — every bypass therefore costs landmark presses, and on the admin shell
that count exceeds the threshold by one.

Scope limits that still stand: NVDA on Brave on Windows only. No VoiceOver, no
JAWS, no real mobile screen reader, no braille display, and this is not a WCAG
conformance audit.

**Other gaps**, each already recorded in the
[limitations list](README.md#current-limitations): admin profile edits use last-write-wins rather
than version checks; orphaned uploaded bytes accumulate with no reaper
(`docs/DECISIONS.md:343-345`); the v1 API's `profile.slideDeckUrl` still reports
only the global value, not the per-event one
(`docs/judging/README.md:187-194`); and the demo deployment intentionally hands
out admin, with the blast radius argued at `docs/judging/README.md:228-235`.

**Two external code audits** were commissioned and triaged. Confirmed defects
were fixed and regression-tested; the remaining accepted findings are the
roadmap items listed above rather than hidden ones
(`docs/judging/README.md:236-248`).

---

## 7. Reproducing the gates

From a checked-out repository, in this order:

```bash
npm ci
npm test
npm run build       # generates .next/types, which the typecheck reads
npm run typecheck
npx tsc -p e2e/tsconfig.json
```

The unit suite requires no database.

The two database-touching suites are guarded differently, and the difference is
worth stating precisely. The E2E suite calls `assertDisposableDatabase()` before
it seeds (`e2e/harness.ts:42`, via `guardAndReseed`), so it refuses to run
against a database the operator has not named as disposable in
`E2E_EXPECTED_DB`. The concurrency race proof adds an opt-in on top of that
guard: without `RACE_PROOF=1` every case **skips**, which is why `npm test`
never looks for a database; with `RACE_PROOF=1` set, the same disposable-database
assertion must then pass, and a missing or mismatched one **fails** the run
rather than skipping it. Both halves are documented at
`lib/services/session-provisioning-fanout-race.test.ts:60-96` and implemented at
`:93-96`. The stated reason for failing rather than skipping after opt-in is
that "opting in and being quietly skipped is exactly the outcome a race proof
must never have."

Smoke and production verification commands are listed in
[the root README](../../README.md#repeatable-verification).
