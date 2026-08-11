/**
 * The `/admin` dashboard's folds.
 *
 * Each test pins the definition the dashboard borrowed from a linked page, so
 * a change on that page that silently diverges here shows up as a failure
 * rather than as two screens quoting different numbers to an organizer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeAbstractFunnel,
  summarizeProgrammeHealth,
  summarizeReviewProgress,
  summarizeRoundTotals,
  type AbstractStatusCount,
  type ProgrammeSession,
  type ReviewAssignmentGroup,
} from "./metrics";

const group = (status: AbstractStatusCount["status"], n: number): AbstractStatusCount => ({
  status,
  _count: { _all: n },
});

// ---- CFP funnel ------------------------------------------------------------

test("the funnel keeps a segment for a status with no rows", () => {
  const funnel = summarizeAbstractFunnel([group("ACCEPTED", 3)]);
  assert.equal(funnel.segments.length, 7);
  // "Zero declined" is information, and a disappearing row would make the
  // funnel reorder itself as decisions land.
  const declined = funnel.segments.find((segment) => segment.status === "REJECTED");
  assert.equal(declined?.count, 0);
  assert.equal(declined?.label, "Declined");
});

test("the funnel total counts drafts and `submitted` excludes them", () => {
  const funnel = summarizeAbstractFunnel([
    group("DRAFT", 4),
    group("SUBMITTED", 6),
    group("UNDER_REVIEW", 2),
    group("ACCEPTED", 3),
    group("REJECTED", 1),
    group("WITHDRAWN", 1),
    group("MAYBE", 2),
  ]);
  assert.equal(funnel.total, 19);
  // "Submissions" is what an organizer means by the word: a draft nobody sent
  // is not one, and counting it would overstate the call on the headline strip.
  assert.equal(funnel.submitted, 15);
});

test("an empty event funnels to all zeroes rather than to nothing", () => {
  const funnel = summarizeAbstractFunnel([]);
  assert.equal(funnel.total, 0);
  assert.equal(funnel.submitted, 0);
  assert.equal(funnel.segments.length, 7);
  assert.ok(funnel.segments.every((segment) => segment.count === 0));
});

test("each segment links to the chip it counted", () => {
  const funnel = summarizeAbstractFunnel([group("MAYBE", 2)]);
  const maybe = funnel.segments.find((segment) => segment.status === "MAYBE");
  assert.equal(maybe?.href, "/admin/abstracts?status=MAYBE");
  assert.equal(maybe?.count, 2);
});

test("duplicate status groups are summed, never overwritten", () => {
  // Defensive: a grouped read that ever returns a status twice must not lose a
  // partition's rows.
  const funnel = summarizeAbstractFunnel([group("ACCEPTED", 2), group("ACCEPTED", 3)]);
  assert.equal(funnel.segments.find((segment) => segment.status === "ACCEPTED")?.count, 5);
  assert.equal(funnel.total, 5);
});

// ---- review rounds ---------------------------------------------------------

const assignment = (
  planId: string,
  abstractId: string,
  status: string,
  n = 1,
): ReviewAssignmentGroup => ({ planId, abstractId, status, _count: { _all: n } });

test("round totals count assigned and completed reviews per round", () => {
  const totals = summarizeRoundTotals(
    [
      assignment("p1", "a1", "PENDING", 2),
      assignment("p1", "a1", "COMPLETED", 1),
      assignment("p1", "a2", "COMPLETED", 3),
      assignment("p2", "a1", "PENDING", 1),
    ],
    () => false,
  );
  assert.deepEqual(totals.get("p1"), { assigned: 6, completed: 4 });
  assert.deepEqual(totals.get("p2"), { assigned: 1, completed: 0 });
});

test("a withdrawn proposal's assignments leave the round entirely", () => {
  // Withdrawn work can no longer be scored. Counting it as assigned-not-done
  // would pin a finished round below 100% forever — the exact rule
  // getEvaluationSetup applies to the evaluations screen.
  const totals = summarizeRoundTotals(
    [
      assignment("p1", "gone", "PENDING", 3),
      assignment("p1", "live", "COMPLETED", 2),
    ],
    (id) => id === "gone",
  );
  assert.deepEqual(totals.get("p1"), { assigned: 2, completed: 2 });
});

test("review progress reports a round with no assignments as zero, not as missing", () => {
  const progress = summarizeReviewProgress(
    [
      { id: "p1", ordinal: 1, name: "Round 1 — Program Committee" },
      { id: "p2", ordinal: 2, name: "Round 2 — Final panel" },
    ],
    summarizeRoundTotals([assignment("p1", "a1", "COMPLETED", 4)], () => false),
  );
  assert.equal(progress.rounds.length, 2);
  assert.deepEqual(
    progress.rounds.map((round) => [round.ordinal, round.assigned, round.completed, round.outstanding]),
    [[1, 4, 4, 0], [2, 0, 0, 0]],
  );
  assert.equal(progress.assigned, 4);
  assert.equal(progress.completed, 4);
  assert.equal(progress.outstanding, 0);
});

test("outstanding never goes negative", () => {
  // Completed can only be a subset of assigned, but a floor here means a data
  // oddity renders as "0 left" rather than as a negative review count.
  const progress = summarizeReviewProgress(
    [{ id: "p1", ordinal: 1, name: "Round 1" }],
    new Map([["p1", { assigned: 1, completed: 3 }]]),
  );
  assert.equal(progress.rounds[0].outstanding, 0);
  assert.equal(progress.outstanding, 0);
});

test("no rounds at all is an empty progress, not a fabricated round", () => {
  const progress = summarizeReviewProgress([], new Map());
  assert.deepEqual(progress, { rounds: [], assigned: 0, completed: 0, outstanding: 0, truncatedRounds: false });
});

// ---- programme health ------------------------------------------------------

const talk = (contentStatus: "DRAFT" | "PUBLISHED", roomId: string | null): ProgrammeSession => ({
  contentStatus,
  slot: roomId === null ? null : { roomId },
});

test("scheduled means the talk holds a slot, and rooms in use are distinct", () => {
  const health = summarizeProgrammeHealth(
    [
      talk("PUBLISHED", "hall-a"),
      talk("PUBLISHED", "hall-a"),
      talk("DRAFT", "hall-b"),
      talk("DRAFT", null),
      talk("PUBLISHED", null),
    ],
    4,
    0,
    false,
  );
  assert.equal(health.sessions, 5);
  assert.equal(health.scheduled, 3);
  assert.equal(health.unscheduled, 2);
  assert.equal(health.published, 3);
  assert.equal(health.unpublished, 2);
  // Two talks share Hall A; a room is in use once, not twice.
  assert.equal(health.roomsInUse, 2);
  assert.equal(health.roomsTotal, 4);
});

test("publication and placement are independent facts", () => {
  // A published talk with no slot and a placed talk still in draft both exist,
  // and reporting one as the other is the misreading this card must not invite.
  const health = summarizeProgrammeHealth([talk("PUBLISHED", null), talk("DRAFT", "hall-a")], 1, 0, false);
  assert.equal(health.published, 1);
  assert.equal(health.scheduled, 1);
  assert.equal(health.unscheduled, 1);
  assert.equal(health.unpublished, 1);
});

test("the conflict count is passed through, never recomputed", () => {
  // Overlap maths belongs to lib/agenda-conflicts (findConflicts), which is
  // what the builder's Conflicts view itself renders.
  const health = summarizeProgrammeHealth([talk("PUBLISHED", "hall-a")], 1, 7, false);
  assert.equal(health.conflicts, 7);
});

test("truncation is carried so the page can call its figures floors", () => {
  const health = summarizeProgrammeHealth([talk("PUBLISHED", "hall-a")], 1, 0, true);
  assert.equal(health.truncated, true);
});

test("a fresh event's programme is all zeroes", () => {
  const health = summarizeProgrammeHealth([], 0, 0, false);
  assert.equal(health.sessions, 0);
  assert.equal(health.scheduled, 0);
  assert.equal(health.unscheduled, 0);
  assert.equal(health.roomsInUse, 0);
  assert.equal(health.conflicts, 0);
});
