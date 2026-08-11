/**
 * The shared status vocabulary behind the abstracts chips and the `/admin`
 * funnel that links into them.
 *
 * What is guarded here is agreement, not aesthetics: a segment on the dashboard
 * is only honest if its label is the chip's own label, its href names a chip
 * the page will actually preselect, and no status is quietly missing from
 * either list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSTRACT_FUNNEL_STATUSES,
  ABSTRACT_STATUS_ALL,
  ABSTRACT_STATUS_META,
  ABSTRACT_STATUS_TABS,
  abstractStatusFilterHref,
  parseAbstractStatusFilter,
} from "./abstract-status";

/**
 * The enum as Prisma generates it. Written out rather than imported so a
 * schema change that adds a status fails HERE with a readable message, instead
 * of silently agreeing with whatever the code happens to list.
 */
const SCHEMA_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
] as const;

test("every schema status has meta, a chip, and a funnel segment", () => {
  assert.deepEqual(Object.keys(ABSTRACT_STATUS_META).sort(), [...SCHEMA_STATUSES].sort());

  const tabKeys = ABSTRACT_STATUS_TABS.map((tab) => tab.key);
  assert.equal(tabKeys[0], ABSTRACT_STATUS_ALL, "the unfiltered chip comes first");
  assert.deepEqual(tabKeys.slice(1).sort(), [...SCHEMA_STATUSES].sort());
  assert.deepEqual([...ABSTRACT_FUNNEL_STATUSES].sort(), [...SCHEMA_STATUSES].sort());

  // No duplicates: a repeated chip would double-count a status in the funnel.
  assert.equal(new Set(tabKeys).size, tabKeys.length);
});

test("the funnel walks the chips in chip order, minus the unfiltered one", () => {
  assert.deepEqual(ABSTRACT_FUNNEL_STATUSES, [
    "SUBMITTED",
    "UNDER_REVIEW",
    "MAYBE",
    "ACCEPTED",
    "REJECTED",
    "DRAFT",
    "WITHDRAWN",
  ]);
});

test("REJECTED reads as a decline and WITHDRAWN keeps its own word", () => {
  // The organizer-facing wording an existing screen already ships; renaming a
  // stored value here would silently rename it on four surfaces.
  assert.equal(ABSTRACT_STATUS_META.REJECTED.label, "Declined");
  assert.equal(ABSTRACT_STATUS_META.WITHDRAWN.label, "Withdrawn");
  assert.equal(ABSTRACT_STATUS_META.UNDER_REVIEW.label, "Under review");
  // A decided proposal is tone-coded so status is never colour alone plus a
  // shape-free pill; every tone is one the stylesheet defines.
  for (const status of SCHEMA_STATUSES) {
    assert.ok(
      ["neutral", "info", "warn", "good", "bad"].includes(ABSTRACT_STATUS_META[status].tone),
      `${status} carries an unknown pill tone`,
    );
  }
});

test("parse accepts exactly the chip keys and falls back to ALL", () => {
  for (const status of SCHEMA_STATUSES) {
    assert.equal(parseAbstractStatusFilter(status), status);
  }
  assert.equal(parseAbstractStatusFilter("ALL"), ABSTRACT_STATUS_ALL);

  // Everything unrecognized renders the unfiltered table rather than an empty
  // one: a stale or mistyped link is routine, not a fault.
  assert.equal(parseAbstractStatusFilter(undefined), ABSTRACT_STATUS_ALL);
  assert.equal(parseAbstractStatusFilter(""), ABSTRACT_STATUS_ALL);
  assert.equal(parseAbstractStatusFilter("accepted"), ABSTRACT_STATUS_ALL, "case is not guessed at");
  assert.equal(parseAbstractStatusFilter("NOT_A_STATUS"), ABSTRACT_STATUS_ALL);
  // A repeated parameter is ambiguous; picking one would be a guess.
  assert.equal(parseAbstractStatusFilter(["ACCEPTED", "REJECTED"]), ABSTRACT_STATUS_ALL);
  // Surrounding whitespace from a hand-edited URL still resolves.
  assert.equal(parseAbstractStatusFilter("  ACCEPTED  "), "ACCEPTED");
});

test("the href names the page and the parameter the page reads", () => {
  assert.equal(abstractStatusFilterHref("ACCEPTED"), "/admin/abstracts?status=ACCEPTED");
  assert.equal(abstractStatusFilterHref("UNDER_REVIEW"), "/admin/abstracts?status=UNDER_REVIEW");
  // The unfiltered chip is the page's own default; a no-op parameter is noise.
  assert.equal(abstractStatusFilterHref(ABSTRACT_STATUS_ALL), "/admin/abstracts");
});

test("every funnel href round-trips back to the status it came from", () => {
  for (const status of ABSTRACT_FUNNEL_STATUSES) {
    const href = abstractStatusFilterHref(status);
    const value = new URL(href, "https://example.test").searchParams.get("status");
    assert.equal(parseAbstractStatusFilter(value ?? undefined), status);
  }
});
