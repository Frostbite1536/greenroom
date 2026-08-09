# Walkthrough video — shot list and narration

For Jeremy's voice-narrated fallback video. **Target: 8–9 minutes.** Everything
below is on the canonical deployed demo, `https://greenroom-hq.com`; no local
setup appears on camera.

## Before recording

- Coordinate an Architect-announced demo write window. The walkthrough creates
  one proposal, review assignment, Session, and schedule slot; do not rehearse it
  against `demo-event` outside that window.
- Use only Jeremy-approved deliverable test addresses. A submitted proposal now
  triggers real receipt/co-speaker/admin mail when production delivery is live.
- Use a clean browser profile at 1440×900 or larger.
- Have the app and a terminal ready. Load the judge-scoped read-only API key into
  `GREENROOM_API_KEY` off-camera; never paste, echo, or record its value.
- Pick one distinctive title and reuse it. Suggested: **“Backstage: Running a
  3,000-Person Conference”**.
- Speak to a non-technical event professional: say “submission”, “reviewer”, and
  “programme”, not “endpoint”, “schema”, or “invariant”.

Narration lines are written to be read aloud. Stage directions are in *italics*.

---

## 1. Public call for speakers (0:00–0:45)

*Start logged out on* `/cfp/call-for-speakers`.

> “This is Greenroom—open-source event program management. I’m starting on the
> real deployed app, completely logged out, exactly like a speaker following a
> call-for-papers link.”

*Scroll through the core and custom fields, category selector, conditional
questions, and co-speaker area.*

> “The programme team controls the questions, track options, conditions, dates,
> and speaker limits. One call can serve several tracks.”

## 2. Submit a proposal (0:45–1:30)

*Use the approved test address, fill every visible required field, and submit.*

> “The server validates the same rules the page shows, including questions that
> become required only after another answer. The proposal is saved first; then
> Greenroom records the submitter receipt, co-speaker notices, and admin alert.”

*Pause on the thank-you screen.*

> “A mail-provider problem can’t erase the proposal, and an email address never
> creates portal access by itself.”

## 3. Inspect and assign it (1:30–2:45)

*Go to* `/login`*, choose* **Event admin**, *open* **Abstracts**, *and select the
new row.*

> “The admin sees the proposal’s standard fields and every custom answer, with
> its original question label. Evaluators do not receive these private form
> answers.”

*Open* **Evaluations**. *Select the active round, select the new proposal and
Ravi Patel, then choose* **Assign**.

> “Admins create review rounds and rubrics here, then assign submitted work to
> event evaluators. Coverage remains visible for the whole round, and assigning
> the same pair twice cannot create duplicates.”

*Point to the blind-round copy without changing the seeded round.*

> “Blind rounds hide speaker profiles in assigned reviewer surfaces. Greenroom
> is honest that a title or free text can still identify someone.”

## 4. Review and score (2:45–3:40)

*Sign out, choose the* **Evaluator** *persona, and open* **Evaluations**. *Select
the new assignment, score every rubric criterion, add a short comment, and
submit.*

> “Reviewers see only their queue. Scores are checked against this round’s
> rubric and weighted for the reviewer’s running total; nobody can score work
> they were not assigned.”

> “If a speaker withdraws, the item becomes archived: no scoring form, no new
> assignment, and no distortion of active progress.”

## 5. Accept and preview the decision (3:40–4:40)

*Return as* **Event admin** → **Abstracts** → *select the new row* → **Accept**.

> “Acceptance is the commitment point. In one transaction Greenroom creates the
> confirmed, unscheduled Session, copies its speakers, and assigns each speaker
> the event’s onboarding checklist. Repeating the action tops up missing rows
> without duplicating anything.”

*Open* **Operations**, *select the decided proposal, and preview its decision
email. Do not press Send unless this recording is the approved live-send proof.*

> “Decision mail is preview-first. The send is cryptographically tied to this
> exact content and recipient set. An admin can include written feedback, but
> never scores or reviewer identities.”

## 6. Schedule it and show a refusal (4:40–6:00)

*Open* **Agenda builder**. *Show Day and Week, then find the new Session in the
Unscheduled backlog.*

> “Accepting confirmed the talk; it did not invent a room or time. That separate
> scheduling decision starts here.”

*Try an occupied room/time and pause on the conflict response. Then choose a
free slot.*

> “The server refuses a room or speaker overlap inside the same transaction that
> writes the slot. A free placement lands; a collision never becomes a warning
> someone can ignore.”

## 7. Speaker onboarding (6:00–7:05)

*Sign out, choose* **Speaker** *(Sofia), and open the portal.*

> “Speakers see profile completeness, confirmed sessions, editable proposals,
> resources, and the exact onboarding tasks the admin is tracking.”

*Open a form-carrying task such as flight reimbursement. Show a conditional
question appearing, save a partial response, then complete every visible
required field and choose* **Save and mark done**.

> “Partial answers survive a closed tab. A form task cannot be checked off while
> its required visible answers are empty or invalid, so completion means the
> programme team actually has the information.”

*Open Sofia’s accepted proposal and show that text/answers remain editable while
the speaker roster is locked.*

> “Speakers can still correct what attendees will read after acceptance. The
> confirmed lineup is fixed; changing presenters is a programme decision.”

*Return as admin and open* **Speaker onboarding**.

> “The programme team gets the other side of that workflow: profile gaps, open
> tasks, and unscheduled sessions, ordered as a chase list.”

## 8. Public embeds and calendar export (7:05–8:00)

*Sign out. Open* `/embed/schedule?event=forward-2026`, *download one `.ics`, then
open* `/embed/speakers?event=forward-2026`.

> “The public programme works without a login and can be embedded in an existing
> event site. Calendar files contain the real room when one is assigned.”

*As admin, show the copyable iframe snippets under* **Website embeds**.

## 9. Read-only API (8:00–8:35)

*In PowerShell, with the key already loaded off-camera, run:*

```powershell
curl.exe -H "Authorization: Bearer $env:GREENROOM_API_KEY" `
  "https://greenroom-hq.com/api/v1/schedule?event=forward-2026"
```

> “The same schedule can feed a mobile app or website build through a scoped,
> read-only API.”

*Then omit the header:*

```powershell
curl.exe -i "https://greenroom-hq.com/api/v1/schedule?event=forward-2026"
```

> “Without the key it fails closed. The event selector is mandatory, too.”

## 10. Close (8:35–9:00)

> “Call for papers, review setup, scoring, acceptance, communications, speaker
> onboarding, a conflict-safe agenda, public embeds, calendar export, and an
> API—the whole life of a conference programme, open source.”

---

## Shot checklist

| # | Shot | Must be visible |
| --- | --- | --- |
| 1 | Public CFP, logged out | custom/conditional questions and category |
| 2 | Submission | distinctive title and thank-you state |
| 3 | Admin Abstracts + Evaluations | custom answers and new reviewer assignment |
| 4 | Evaluator queue | rubric review saved |
| 5 | Accept + Operations | one Accept action; exact decision preview |
| 6 | Agenda | refused conflict, then clean placement |
| 7 | Portal + Speaker onboarding | gated task form, accepted edit, locked roster, chase list |
| 8 | Public embeds + `.ics` | signed-out state and iframe snippet |
| 9 | Terminal | 200 with environment-held key, 401 without; no secret visible |

## If something goes wrong on camera

- **CFP closed:** stop. Fix dates/reseed only in the announced writer window.
- **New proposal is absent from Ravi’s queue:** return as admin and verify the
  exact proposal/evaluator pair was assigned in the active round.
- **Accepted talk is absent from the backlog:** reload Abstracts and Agenda. Do
  not look for a second Create session step; acceptance already provisioned it.
- **Task form data differs:** stop and confirm the consolidated production seed
  completed before recording.
- **Conflict does not trigger:** choose a visibly occupied room/time in Day view.
- **API returns 401 with the header:** confirm the environment variable is set
  off-camera; never paste the credential into the command or recording.
