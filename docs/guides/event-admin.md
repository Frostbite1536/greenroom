# Guide: running your event's programme

For the person who opens the call for speakers, decides what makes the programme, and builds
the schedule. Signed in as **Maya Chen**, event admin for **Forward 2026**.

Everything below happens in the left-hand menu, roughly top to bottom. You can stop and come
back at any point; nothing is lost.

---

## 1. Open your call for speakers

**CFP forms** → pick a form, or choose **New form**.

A form is the page speakers fill in. You control:

- the **name** and the **web address** (the "slug") — Forward 2026 uses
  `/cfp/call-for-speakers`, so you can put that link straight on your event site;
- the **welcome** and **thank-you** messages speakers see before and after they submit;
- **when it opens and closes** — outside those dates the page politely says the window is
  shut, and nothing can be submitted;
- **how many proposals one person may send** (Forward 2026 allows 3);
- **how many speakers** a proposal may list (1 to 4 here), and how long a speaker biography
  may be;
- your **questions**. Add short text, long text, a number, a dropdown, a multi-select, a
  tick-box, or a link. Mark the ones you must have as required. Questions can also be shown
  only when an earlier answer matches, so the form stays short.

Tracks are handled by the **categories** on the form — one form with several track options is
usually all you need, and you can always publish more forms later. Each category also decides
which review team gets those proposals.

When the form looks right, publish it and use **View public form** to see exactly what a
speaker sees. The public page works for people who are not signed in — that is the whole
point.

> **Tip:** the public form is the safest thing to test. Submit a fake proposal with an obvious
> title, then follow it through the steps below.

---

## 2. Read what came in

**Abstracts** shows every proposal for the event, newest first, with filter chips across the
top (All / Submitted / Under review / Accepted / Declined / Drafts) and a search box. Select a
row to read the proposal itself — title, description, form, category, session type and length,
who is speaking, how many reviews are complete, and the score so far.

Two useful facts:

- The status wording here is the same wording the speaker sees in their own portal.
- Proposals brought in from a spreadsheet (CSV import) land here as **Submitted**, exactly
  like ones typed into the form.

> **Coming soon:** the answers to your own custom questions inside this panel (today you see
> the proposal's standard fields there), and a score that is weighted by your rubric and counts
> only completed reviews — the figure shown now is a plain average of every score recorded so
> far.

---

## 3. Get proposals reviewed

**Evaluations** is where scoring happens. An evaluation round ("plan") holds the scoring
rubric and the list of who is reviewing what. Assign proposals to your review team, and each
assigned proposal moves to **In review** automatically.

If a proposal's category has a review team attached, assignments are routed to that team by
default — you do not have to remember who covers what.

Rounds can be **blind**: evaluators then see the proposal without the speaker's name.

---

## 4. Accept, then create the session

Back in **Abstracts**, open a proposal and choose **Accept** or **Decline** (offered on
proposals that are Submitted or Under review). Accepting does not put anything on the schedule
yet — that is deliberate: deciding and scheduling stay separate steps.

Once a proposal is accepted, the same panel offers **Create session**. That creates
the confirmed talk: one session per proposal, carrying its title, description, format, and
speakers. Pressing it twice is harmless — you get the same session back, never a duplicate.

From this point the talk's **speaker list is fixed**. Speakers can still fix typos in their
own text (see the [speaker guide](speaker.md)), but they cannot add or remove co-speakers;
if that needs to change, you change it.

---

## 5. Build the schedule

**Agenda builder** has five tabs:

| Tab | What it is for |
| --- | --- |
| **List** | every placed talk in order — best for a quick read-through |
| **Day** | one day, one column per room. This is where you drag things around. |
| **Week** | the whole event at a glance, read-only |
| **Tracks** | one day, one column per track, to check a track's shape |
| **Conflicts** | everything that currently clashes |

Unplaced talks sit in the **Unscheduled backlog** strip at the top. Choose one, pick a day,
time, room, and (optionally) a track, and schedule it.

**Greenroom will not let you double-book.** Before anything is saved it checks that the room
is free and that none of the speakers is already on stage at that moment. If either is true
the placement is refused and you are told what it clashes with. Talks that touch but do not
overlap — one ending at 10:00, the next starting at 10:00 — are fine.

The same check runs when you **drag** a talk in the Day tab: the block follows your cursor,
and if the server refuses the move it snaps back with a "Move refused" message explaining
why. To take a talk off the schedule, unschedule it; it returns to the backlog and is not
deleted.

---

## 6. Keep speakers on track

**Speaker onboarding** lists everyone with a confirmed talk and shows, per person: how
complete their profile is, how many onboarding tasks they have settled, and whether their
talk has a slot yet. Filter to **Incomplete onboarding**, **Incomplete profile**, or
**Unscheduled sessions** and work the list from the top — it is already sorted with the
people who need chasing first.

A task counts as settled when the speaker finishes it **or** when it has been waived, so
someone who genuinely does not need a task is not a permanent red mark.

---

## 7. Put the programme on your website

**Website embeds** gives you ready-made snippets:

- the **public schedule** and the **speaker gallery**, as `<iframe>` code you paste into your
  site's page editor;
- a direct link to each, if you would rather link than embed.

The public schedule itself carries **calendar (.ics)** buttons — "Add all to calendar" for
the whole programme and one per session — so attendees can add talks to their own calendar.
Each entry carries the room once a room has been assigned.

Copy a snippet, paste it into your site, and you are done. The embeds are public — visitors
do not need an account — and they update themselves as you change the schedule.

---

## Common questions

**Can I accept something without any reviews?** Yes — the Accept button is available as soon
as a proposal is submitted. Scoring is a workflow, not a gate.

**I declined a talk that was already on the schedule — is it off?** No, and Greenroom says so:
the proposal shows a **"Still on the programme"** warning with a link to the Agenda builder.
Nothing is deleted behind your back — take it off the schedule there, or change the decision
back if it should run after all.

**Someone wants to withdraw a proposal.** A speaker can withdraw anything that has not been
accepted yet (their portal button is on the way — until then, do it for them). Once you have
accepted a talk, only you can take it off the programme: decline it and unschedule it. A
withdrawn proposal can no longer be scored — a reviewer who tries is told the speaker pulled
it.

**Can two talks share a room deliberately?** The schedule refuses overlaps by design. If you
genuinely need one (a demo of the conflict view, for instance), that is an administrator
action, not a normal one.
