# A3 — Authenticated production walkthrough (evidence)

Run 2026-08-08 ~12:15–12:25 CDT by the Architect against
`https://greenroom-omega-dusky.vercel.app` at production commit `0bb4aad`,
inside an announced single-writer window. This was the first **persisted
admin-mutation sweep** on the final signed-session implementation.

Authentication used the app's own `/login` server action over HTTPS (the same
one-click persona flow a judge uses) — no forged cookies; the signed
`sb_session` cookie was issued by production itself.

## Results — 14/14 PASS

| # | Check | Result |
|---|---|---|
| 1 | Public form resolves logged out (`/api/cfp/public/call-for-speakers`) | 200 |
| 2 | Logged-out CFP submit (throwaway distinctive title) | 201 SUBMITTED |
| 3 | Admin persona login issues signed session | ✓ |
| 4 | Submission visible in the admin pipeline | ✓ |
| 5 | Accept decision | 200 → ACCEPTED |
| 6 | Convert to session | 201, `created: true` |
| 7 | Overlapping placement refused | 409 + conflict list |
| 8 | Clean placement (Grand Ballroom, last event day) | 200 |
| 9 | Talk visible on `/embed/schedule` logged out | ✓ |
| 10 | `.ics` export contains the talk with `LOCATION:` room | ✓ |
| 11 | Evaluator persona scores an assigned abstract | 200 persisted |
| 12 | Speaker persona profile edit persists | 200 |
| 13 | Speaker persona task check-off persists | 200 |
| 14 | `/api/admin/reset` refused in production | 403 RESET_DISABLED |

## Post-walkthrough reseed

The authorized transactional (advisory-locked) reseed rebuilt `demo-event`
immediately afterwards. Verified by read-only query: 40 abstracts / 13
sessions / 11 slots, exactly 1 deliberate room conflict, 0 walkthrough
residue, event boundaries `2026-05-12` → `2026-05-14` (America/Los_Angeles),
first slot 9:00 AM local, speaker persona restored to demo defaults.
`scripts/prod-verify.mjs` passed **5/5** after the reseed.

Note for judges: the deliberate room conflict in the seeded agenda is
intentional — it demonstrates the conflict banner in the agenda builder.
