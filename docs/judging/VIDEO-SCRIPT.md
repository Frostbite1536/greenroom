# Walkthrough video — shot list and narration

For Jeremy's voice-narrated fallback video. **Target: 8–9 minutes.** Everything
below is on the deployed demo, `https://greenroom-omega-dusky.vercel.app`; no
local setup appears on camera.

**Before recording**
- Use a clean browser profile (no other logins), window at 1440×900 or larger.
- Have two tabs ready: the app, and a terminal for the one API shot (§8).
- Pick a distinctive throwaway talk title and use it every time it is typed.
  Suggested: **"Backstage: Running a 3,000-Person Conference"**.
- Recording adds one abstract → session → schedule slot to the demo event. That
  is fine and repeatable; the Architect can reseed afterwards.
- Speak to a **non-technical event professional**, not an engineer. Say
  "submission", "reviewer", "programme", not "endpoint", "schema", "invariant".

Narration lines are written to be read aloud. Stage directions are in *italics*.

---

## 1. Cold open — the public call for speakers (0:00–0:50)

*Start logged out on* `/cfp/call-for-speakers`.

> "This is Greenroom — open-source event program management. Everything you're
> about to see is the real deployed app, and I'm starting completely logged out,
> exactly like a speaker who just clicked a link in your call for papers."

*Scroll the form slowly: title, abstract, track/category dropdown, custom
questions, co-speaker fields.*

> "The programme team built this form themselves — the questions, the track
> options, the speaker limits. One form can carry as many tracks as you need."

## 2. Submit a proposal (0:50–1:40)

*Fill in the title, a short abstract, pick a track, answer the required
questions, add your name and email as the speaker. Submit.*

> "I'll submit a proposal the same way a speaker would."

*Land on the thank-you screen.*

> "That's it. No account, no password. The team is notified by email — we
> deliberately don't promise speakers a login they don't have yet."

## 3. The proposal arrives for review (1:40–2:40)

*Go to* `/login`*, click the* **Event admin** *one-click persona.*

> "Now I'm the event admin. These one-click personas exist so you can see every
> role without me typing passwords on camera."

*Open* **Abstracts** *from the sidebar. Find the new submission — sort or scan
for the distinctive title.*

> "Here's the submission that just came in, alongside forty others in the demo
> event, at every stage of the pipeline."

*Select the row; show the detail drawer with the answers and speaker.*

> "Everything the speaker typed, including your custom questions, in one place."

## 4. Review and score (2:40–3:40)

*Sign out; log in as the* **Evaluator** *persona. Open* **Evaluations**.

> "Reviewers get their own queue. This is Ravi, one of the programme committee."

*Open an assigned abstract, score it against the rubric criteria, save.*

> "The rubric is defined per review round — criteria, weights, and score ranges.
> Scores are checked against that rubric on the server, so a reviewer can't
> submit a seven out of five, and nobody can score a proposal they weren't
> assigned."

## 5. Accept and turn it into a session (3:40–4:30)

*Back to the* **Event admin** *persona →* **Abstracts** *→ select the new row →*
**Accept** *→ then* **Create session**.

> "The admin accepts the proposal. Accepting doesn't schedule anything — it
> creates a confirmed session, which is the thing that goes on the agenda. We
> keep those two ideas separate on purpose: a proposal is what the speaker sent,
> a session is what you've committed to run."

## 6. Schedule it — and let it refuse a conflict (4:30–6:00)

*Open* **Agenda builder***. Show the* **Day** *and* **Week** *tabs, then the*
**Unscheduled backlog** *with the new session in it.*

> "Here's the programme. Day view, week view, tracks, and a conflicts view."

*Deliberately schedule the new session into a room and time that is already
occupied. Let the conflict message appear.*

> "Watch this — I'm going to put it in a room that's already booked."

*Pause on the refusal.*

> "The server refuses it and tells me exactly what it collides with. That check
> runs inside the database transaction, so two people scheduling at the same
> time still can't double-book a room or a speaker. This is the failure mode
> that ruins real conferences, so we made it impossible rather than merely
> discouraged."

*Now drag the session into a free slot (or use the form).*

> "In a free slot, it just lands."

## 7. The speaker's side (6:00–6:50)

*Sign out; log in as the* **Speaker** *persona (Sofia). Land on* `/portal`.

> "Speakers get their own workspace: profile completeness, their confirmed
> sessions, their submissions, and the onboarding tasks you need from them."

*Tick a task off; show the progress update.*

*Then navigate to* `/admin/speakers` *(type the URL) as the admin persona.*

> "And the programme team sees the other side of that — who's onboarded, who
> hasn't uploaded a headshot, whose sessions still aren't scheduled. This is the
> chase list, sorted so the people who need a nudge are at the top."

## 8. Public embeds and calendar export (6:50–8:00)

*Sign out. Open* `/embed/schedule?event=forward-2026` *while logged out.*

> "This is the public schedule, and I'm signed out — this is what your attendees
> see. It's built to be embedded in your existing event site."

*Click* **Add to calendar** *on a session; show the downloaded `.ics` opening in
the calendar app, with the room in the location field.*

> "Every session exports to a calendar file. If a room has been assigned it comes
> through as the location; if it hasn't, we leave it out rather than invent one."

*Open* `/embed/speakers?event=forward-2026`.

> "Same for the speaker lineup."

*As admin, open* **Embeds** *in the sidebar and show the copyable iframe snippet.*

> "The team copies one line of HTML to put either of those on their own site."

## 9. The public API (8:00–8:40)

*Switch to the terminal. Run:*

```bash
curl -H "Authorization: Bearer gr_live_WXOfTCCYVp9zZQ8QQCqZ-YxGhNbf_P0x" \
  "https://greenroom-omega-dusky.vercel.app/api/v1/schedule?event=forward-2026"
```

> "There's also a read-only API, so the schedule can feed a mobile app or a
> website build."

*Then run the same URL with no key:*

```bash
curl -i "https://greenroom-omega-dusky.vercel.app/api/v1/schedule?event=forward-2026"
```

> "Without a key, it's a 401. It fails closed — if no key is configured at all,
> the API stays switched off instead of becoming public."

**Note:** `?event=forward-2026` is required; without it the API answers 400
`EVENT_REQUIRED`. Judges receive this key deliberately; it is demo-scope only.

## 10. Close (8:40–9:00)

> "Call for papers, review, acceptance, speaker onboarding, a conflict-safe
> agenda, public embeds, calendar export, and an API — the whole life of a
> conference programme, open source, and it installs from a clean clone in about
> four minutes."

---

## Shot checklist

| # | Shot | Must be visible |
| --- | --- | --- |
| 1 | Public CFP, logged out | custom questions, track dropdown |
| 2 | Submission + thank-you | the distinctive title |
| 3 | Admin → Abstracts | the new row among the 40 seeded |
| 4 | Evaluator → Evaluations | rubric scoring saved |
| 5 | Accept → Create session | both actions |
| 6 | Agenda | **the refused conflict**, then a clean placement |
| 7 | Portal + `/admin/speakers` | a task ticked; the chase list |
| 8 | `/embed/*` logged out + `.ics` | signed-out state, downloaded file, Embeds snippet |
| 9 | Terminal | 200 with key, 401 without |

## If something goes wrong on camera

- **The CFP says submissions are closed** — the seeded window drifted; stop and
  tell the team before recording (it needs a reseed, not a retake).
- **A row won't accept** — reload; the abstracts table refreshes after the
  decision, and the row must still be selected for **Create session**.
- **The conflict doesn't trigger** — pick a slot you can see is occupied in the
  Day view; the demo event ships exactly one deliberate room conflict already.
- **`/admin/speakers` isn't in the sidebar** — it is reached by URL; the nav
  entry is a queued change.
