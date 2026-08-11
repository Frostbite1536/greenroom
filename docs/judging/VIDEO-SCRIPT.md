# Walkthrough video — shot list and narration

Voice-narrated walkthrough of the complete operating loop, recorded against the
real deployed application. **Target: 9–11 minutes** (Part A ~9 min, Part B ~1–2
min). No local setup appears on camera.

## Recorded environment

| Field | Value |
| --- | --- |
| Application | <https://greenroom-hq.com> |
| Deployed commit | `9e058f3560a398352bbd48277ef80cb16e8550dc` |
| Demo event | **Forward 2026** (`forward-2026`), 12–14 May 2026, `America/Los_Angeles` |
| Public CFP | `/cfp/forward-2026/call-for-speakers` |
| Recorded by | Jeremy |
| Recording date / timezone | *fill in at capture (ISO 8601 + offset)* |
| Browser / viewport | *fill in at capture (e.g. Edge 1440 × 900)* |

Restate the commit in the video description or an on-screen card. If the
deployment moves before the recording, update this table first — every evidence
artifact must name the same commit.

## Before recording

- **Use a clean browser profile** with no saved session, at 1440 × 900 or
  larger. The logged-out shots are only evidence if the browser was never
  signed in.
- Coordinate an Architect-announced demo write window. This walkthrough creates
  one proposal, one review assignment, one Session, one schedule slot, and one
  event; do not rehearse it against production outside that window.
- Personas sign in with one click and no password. The credential form beside
  them uses the documented, deliberately public demo password — the constant
  `DEMO_PERSONA_PASSWORD` in `lib/demo/seed.ts`. Never read it aloud, type it on
  camera, or paste it into this file.
- Load the read-only API key into `GREENROOM_API_KEY` off-camera. Never paste,
  echo, or record its value.
- Pick one distinctive title and reuse it. Suggested: **"Backstage: Running a
  3,000-Person Conference"**.
- Check the admin pipeline before you start. It may still hold an earlier
  proposal titled *"Live Email Proof — Cycle 5 Consolidated Window"* from a
  verification run; ignore it, or reseed inside the window so the pipeline is
  the deterministic 40 proposals.
- Speak to a non-technical event professional: say "submission", "reviewer",
  "speaker", and "programme", not "endpoint", "schema", or "invariant".

Narration lines are written to be read aloud. Stage directions are in *italics*.

---

# Part A — the operating loop

## 1. Public call for speakers (0:00–0:45)

*Start logged out on* `/cfp/forward-2026/call-for-speakers`.

> "This is Greenroom — an open-source conference programme platform. I'm on the
> real deployed application, completely logged out, exactly like a speaker
> following a call-for-papers link."

*Scroll through the core fields, the topic selector, the custom questions, one
conditional question, and the co-speaker area with its role field.*

> "The programme team controls the questions, the topics, the dates, the
> speaker limit, and which questions appear only when an earlier answer makes
> them relevant. One call can serve several topics, and each co-speaker can
> carry their own role."

## 2. Submit a proposal (0:45–1:30)

*Fill every visible required field, using the distinctive title and an approved
deliverable address, then submit.*

> "The server checks the same rules the page shows, including the questions that
> only become required after another answer. The proposal is saved first; then
> Greenroom records one receipt for its saved primary speaker."

*Pause on the thank-you screen.*

> "A mail-provider problem can't erase the proposal, and an email address never
> creates portal access by itself."

## 3. Inspect and assign it (1:30–2:45)

*Go to* `/login`. *Point out the email-and-password form and the honest note
under it, then sign in with the one-click* **Event admin** *persona.*

> "Organizers sign in with an email and password. Self-service sign-up and
> password reset are on the roadmap — today an organizer provisions accounts.
> For this walkthrough I'll use the demo shortcut."

*Open* **Abstracts** *and select the new row.*

> "The admin sees the proposal's standard fields and every custom answer under
> its original question label. Reviewers never receive these private answers."

*Point at* **Export CSV** *without downloading, then open* **Evaluations**.

> "Decisions and scores export to a spreadsheet whenever the programme team
> wants them outside the app."

*In* **Evaluations***, show the round list with its reviewing-opens/closes dates
and the rubric criteria. Point at the weight line under one criterion —
`Weight 1.5 · 33.3% of rubric weight`.*

> "Admins build a review round here: a rubric, a weight for each criterion —
> shown as its share of the whole rubric, so a weight of one-and-a-half reads as
> a third of the decision — and optional open and close dates for the round."

*Show the* **Review coverage** *table, then select the new proposal and Ravi
Patel and choose* **Assign**.

> "Coverage stays visible for the whole round and sorts by whichever column the
> team is chasing. Assigning the same pair twice cannot create a duplicate."

*Point to the blind-round copy without changing the seeded round.*

> "A round can be blind: assigned reviewers lose speaker profiles. Greenroom is
> honest that a title or free text can still identify someone."

## 4. Review and score (2:45–3:45)

*Sign out, choose the* **Evaluator** *persona, and land on* **Evaluations**.

> "Reviewers see only their own queue — nobody can score work they were not
> assigned."

*Open the new assignment, score every rubric criterion, add a short comment, and
choose* **Submit review**.

> "Scores are checked against this round's rubric and weighted into the
> reviewer's running total."

*Point at* **Declare a conflict** *without pressing it — or press it on a
different assignment and cancel at the confirmation step.*

> "A reviewer who knows the speaker declares a conflict instead of scoring, and
> the server refuses any score on a declined assignment afterwards."

*Optional, only if the event has two or more rounds:* *point at the*
**Review round** *selector.*

> "When an event runs several rounds, the reviewer switches between them here
> and can see how much work is waiting in the others."

**Note for the recorder:** the seeded demo has a single round
("Round 1 — Program Committee"), so the round selector is deliberately hidden.
Either skip this beat or create a second round as admin first.

## 5. Accept and preview the decision (3:45–4:45)

*Return as* **Event admin** → **Abstracts** → *select the new row* → **Accept**.

> "Acceptance is the commitment point. In one transaction Greenroom creates the
> confirmed, unscheduled session, copies its speakers, and gives each speaker
> the event's onboarding checklist. Repeating the action tops up what's missing
> and never duplicates anything."

*Open* **Operations** → **Tell a speaker your decision**. *Choose the decided
proposal and press* **Preview email**. *Do not press* **Send it** *unless this
recording is the approved live-send proof.*

> "Decision mail is preview-first — the send button stays disabled until the
> exact content has been previewed, and the send is tied to that content and
> recipient set. An admin can include written feedback, but never scores or
> reviewer identities."

*Open* **Email history**.

> "Every send is logged with its real outcome — delivered, mocked, or failed with
> the provider's own reason. Nothing here claims a delivery that didn't happen."

## 6. Schedule it, and refuse a collision (4:45–6:15)

*Open* **Agenda builder**. *Show the* **List** *and* **Day** *tabs, then find the
new session in the* **Unscheduled backlog** *strip.*

> "Accepting confirmed the talk; it did not invent a room or a time. That
> scheduling decision starts here, in the unscheduled backlog."

*Deliberate refusal — capture this.* *Schedule the new talk into an occupied
room and time: **Hall A, 12 May 2026, 10:00** is taken in the seeded programme.
Pause on the refusal message and read what it collides with.*

> "The server checks the room and every speaker inside the same transaction that
> would write the slot. A collision is refused outright — it never becomes a
> warning somebody can dismiss."

*Now place it in a free slot. The seeded programme keeps **Grand Ballroom free
on 14 May 2026**, so put the talk there at **10:00** (one seeded session sits in
Hall B that afternoon — the day is populated but the ballroom morning is open).*

> "A free placement lands immediately."

*Point at* **Fill open slots** *in the toolbar and press it to show the preview,
then choose* **Discard**.

> "For a whole backlog there's an assisted option: Greenroom proposes conflict-
> free placements, shows exactly what it could and could not place, and saves
> nothing until you apply it."

*Optional: point at the* **Unpublish** *control on a List row.*

> "A confirmed talk can also be held back from the public programme without
> losing its slot, its speakers, or its tasks."

## 7. Speaker onboarding (6:15–7:30)

*Sign out, choose the* **Speaker** *persona (Sofia Marques), and open the
portal.*

> "Speakers see profile completeness, their confirmed sessions, their editable
> proposals, the event's resources, and the exact onboarding checklist the
> programme team is tracking — each item with its own deadline."

*Open a form-carrying task — **"Claim your flight reimbursement"** or
**"Tell us about your hotel stay"**. Show a conditional question appearing, save
a partial response, then complete every visible required field and choose*
**Save and mark done**.

> "Partial answers survive a closed tab. A form task cannot be checked off while
> its required visible answers are empty or invalid — so 'done' means the
> programme team actually has the information."

*Open Sofia's accepted proposal and show that the text and answers are still
editable while the speaker list is locked.*

> "Speakers keep correcting what attendees will read after acceptance. The
> confirmed lineup is fixed — changing who presents is a programme decision."

*Return as admin and open* **Speaker onboarding**.

> "The programme team gets the other side of it: profile gaps, open tasks, the
> next deadline, who is overdue, and whose talk still has no slot — already
> ordered as a chase list."

## 8. Public programme and calendar export (7:30–8:30)

*Sign out. Open* `/` *(the public landing page), then follow* **View the
schedule** *to* `/embed/schedule?event=forward-2026`.

> "Everything the programme team just did is now public, with no login at all."

*Use the day tabs, type a word into the search box and submit it, open a
session's details, and point at the topic, track and room chips. Then download
one* `.ics` *with* **Add to calendar***.*

> "Attendees browse by day, search the whole programme, open a session for its
> full description, and add any talk — or the whole programme — to their own
> calendar. It works with JavaScript switched off, because the filters are plain
> links and forms."

*Open* `/embed/speakers?event=forward-2026`, *expand one speaker's full profile,
and follow the link to their session.*

*As admin, show the copyable `<iframe>` snippets under* **Website embeds**.

> "The same pages drop straight into an existing event site as an iframe."

## 9. Read-only API (8:30–9:00)

*In PowerShell, with the key already loaded off-camera:*

```powershell
curl.exe -H "Authorization: Bearer $env:GREENROOM_API_KEY" `
  "https://greenroom-hq.com/api/v1/schedule?event=forward-2026"
```

> "The same programme can feed a mobile app or a website build through a scoped,
> read-only API."

*Then omit the header:*

```powershell
curl.exe -i "https://greenroom-hq.com/api/v1/schedule?event=forward-2026"
```

> "Without a valid key it fails closed, and the event is always explicit."

## 10. Close (9:00–9:20)

> "Call for speakers, structured review, acceptance that provisions the session
> and the onboarding in one step, speaker readiness, conflict-safe scheduling, a
> published programme, calendar export, and an API — the whole life of a
> conference programme, open source and self-hostable."

---

# Part B — greenfield organizer proof (9:20–11:00)

This segment proves Greenroom is not a single hard-coded demo. Record it as the
tail of the same video or as a separate short clip.

**Record honestly.** As of `9e058f3` an organizer can create a new event, but the
workspace cannot yet be switched into it — the app says so itself. So the proof
splits into two halves, and the script says which is which.

## B1. Create a new event (and prove isolation)

*As* **Event admin***, open* **Event settings**. *Show the event's own settings —
name, dates, timezone, rooms, and the programme groupings — then choose*
**New event***.*

> "An organizer configures the event they're running here: its name, its dates,
> its timezone, the rooms talks can be placed in, and the tracks and topics the
> programme is grouped by."

*Fill in a name, let the web address fill itself in, set a timezone and optional
dates, and choose* **Create event***. Pause on the confirmation notice and read
it aloud.*

> "A new event is created empty — no rooms, no forms, nothing copied. And
> Greenroom is honest about the limit: this workspace is still showing Forward
> 2026, because switching between events is on the roadmap."

*Try creating it again with the same web address and show the refusal.*

> "The address is unique, so two events can't collide."

*Now sign out and open* `/` *and* `/embed/schedule` *again.*

> "This is the isolation that matters: a brand-new empty event never displaces
> the published programme. The public pages still show Forward 2026 exactly as
> before."

## B2. Create and publish a call for speakers, and receive a submission

*Back as* **Event admin***, open* **CFP forms** *and choose* **New form***.*

> "A call for speakers starts as a draft."

*Name it, accept the generated slug, and choose* **Create form***. In the
builder, add one required question and one conditional question, set the open
and close dates and the submission limit, then turn on* **Published** *and*
**Save***.*

> "The programme team writes its own questions, decides which appear only when
> they're relevant, sets the window and the limit, and then publishes it. Until
> it's published the public page isn't there at all."

*Open the public address in a new tab. The* **New form** *dialog showed it while
you were typing:* `/cfp/forward-2026/<your-slug>`.

> "The public address carries the event and the form, so one organizer can run
> several calls side by side."

**Note for the recorder:** there is no in-app "view public form" button at this
commit — navigate to the address the dialog showed you.

*Sign out, or switch to the clean profile, and submit a proposal with a second
distinctive title.*

*Sign back in as* **Event admin** *and open* **Abstracts***.*

> "It lands in this event's pipeline, against the form it was submitted to —
> a call built from nothing minutes ago, not seeded data."

**Say plainly on camera:** authoring a call inside the *newly created* event
needs event switching, which is on the roadmap; this half of the proof is
recorded in the event the organizer is signed in to.

---

## Shot checklist

| # | Shot | Must be visible |
| --- | --- | --- |
| 1 | Public CFP, logged out | topic selector, a conditional question, co-speaker role |
| 2 | Submission | distinctive title and thank-you state |
| 3 | Login | credential form **and** persona buttons, roadmap note |
| 4 | Admin Abstracts | custom answers under their labels; **Export CSV** |
| 5 | Evaluations setup | weight-share line, round window dates, coverage table, new assignment |
| 6 | Evaluator queue | rubric scored, review submitted, **Declare a conflict** |
| 7 | Accept + Operations | one Accept; **Send it** disabled until **Preview email** |
| 8 | Email history | truthful per-row delivery status |
| 9 | Agenda | **refused collision**, then clean placement; **Fill open slots** preview |
| 10 | Portal | gated task form, accepted proposal still editable, roster locked |
| 11 | Speaker onboarding | chase list with due dates and overdue counts |
| 12 | Public `/`, schedule, speakers | logged out; day tabs, search, session details, `.ics` |
| 13 | Website embeds | copyable iframe snippet |
| 14 | Terminal | 200 with the environment-held key, refusal without; no secret on screen |
| 15 | Greenfield | **New event** created + isolation notice; new form published → submission in the pipeline |

## If something goes wrong on camera

- **CFP page says submissions are closed:** stop. Fix dates or reseed only
  inside the announced writer window.
- **The new proposal is absent from Ravi's queue:** return as admin and confirm
  that exact proposal/evaluator pair was assigned in the round the evaluator is
  looking at.
- **The accepted talk is absent from the backlog:** reload Abstracts and Agenda.
  Do not look for a second "create session" step — acceptance already
  provisioned it.
- **The collision is not refused:** you picked a free slot. Open the **Day** tab
  for 12 May 2026 and aim at a block you can see, then retry.
- **The round selector is missing:** expected — the seeded event has one round.
- **Task form data differs from the script:** stop and confirm the reseed
  completed before recording.
- **The API returns a refusal *with* the header:** confirm the environment
  variable is set in that shell, off-camera. Never paste the credential into the
  command or the recording.
