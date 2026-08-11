import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OPERATOR_QUERY_LIMITS } from "./api/query-limits";
import { PUBLIC_AGENDA_LIMITS } from "./embed-schedule-view";

/**
 * S20 bounds on the four agenda reads this slice changed.
 *
 * Each one must read cap-plus-one under a stable total order, render exactly
 * the cap, and report the overflow — an unbounded read of a large event is the
 * failure mode, and a silently truncated one is the worse failure mode after
 * it. None of this is observable from a pure function, and the smoke that would
 * exercise it needs an event bigger than any fixture, so it is pinned here.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const reads = source("lib/data/reads.ts");
const publicAgenda = reads.slice(
  reads.indexOf("export const getPublicAgenda"),
  reads.indexOf("export const getPublicSpeakers"),
);
// Bounded at the next export on purpose: an open-ended slice runs to EOF and
// would let `getEventSettings`'s own caps satisfy an assertion about this
// function's, which is exactly the gap P-01 was.
const agendaData = reads.slice(
  reads.indexOf("export async function getAgendaData"),
  reads.indexOf("export type RubricCriterionView"),
);
const publicRoute = source("app/api/agenda/public/route.ts");
const adminRoute = source("app/api/agenda/route.ts");

test("both public agenda reads share one bound, one order, and one overflow rule", () => {
  for (const [name, text] of [["getPublicAgenda", publicAgenda], ["/api/agenda/public", publicRoute]] as const) {
    assert.match(text, /take: PUBLIC_AGENDA_LIMITS\.sessions \+ 1/, `${name} reads cap-plus-one`);
    assert.match(
      text,
      /orderBy: \[\{ startsAt: "asc" \}, \{ id: "asc" \}\]/,
      `${name} orders totally, with an id tiebreak`,
    );
    assert.match(
      text,
      /slots\.length > PUBLIC_AGENDA_LIMITS\.sessions/,
      `${name} derives truncation from the extra row`,
    );
    assert.match(
      text,
      /slots\.slice\(0, PUBLIC_AGENDA_LIMITS\.sessions\)/,
      `${name} renders the cap, not the probe row`,
    );
  }
});

test("both admin agenda reads share one bound, one order, and one overflow rule", () => {
  for (const [name, text] of [["getAgendaData", agendaData], ["/api/agenda", adminRoute]] as const) {
    assert.match(text, /take: OPERATOR_QUERY_LIMITS\.agendaSessions \+ 1/, `${name} reads cap-plus-one`);
    assert.match(
      text,
      /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
      `${name} orders totally, with an id tiebreak`,
    );
    assert.match(
      text,
      /sessions\.length > OPERATOR_QUERY_LIMITS\.agendaSessions/,
      `${name} derives truncation from the extra row`,
    );
    assert.match(
      text,
      /sessions\.slice\(0, OPERATOR_QUERY_LIMITS\.agendaSessions\)/,
      `${name} renders the cap, not the probe row`,
    );
  }
});

/**
 * P-01. The sessions were capped; the axes they are laid out on were not. Both
 * admin agenda reads are pinned together because the JSON twin at
 * `/api/agenda` is the parallel path a fix to the server read alone would miss.
 * Rooms and tracks fail closed (`assertEventQueryBound`) rather than truncating
 * with a notice, matching `getEventSettings`, which owns these two resources:
 * a grid quietly missing a column would hide every conflict in it.
 *
 * CRLF-safe: no pattern crosses a line break.
 */
test("both admin agenda reads bound the grid's axes, not just its sessions", () => {
  for (const [name, text] of [["getAgendaData", agendaData], ["/api/agenda", adminRoute]] as const) {
    assert.match(text, /take: OPERATOR_QUERY_LIMITS\.settingsRooms \+ 1/, `${name} bounds rooms`);
    assert.match(text, /take: OPERATOR_QUERY_LIMITS\.settingsTracks \+ 1/, `${name} bounds tracks`);
    assert.match(
      text,
      /assertEventQueryBound\(rooms, OPERATOR_QUERY_LIMITS\.settingsRooms,/,
      `${name} refuses rather than silently dropping a room`,
    );
    assert.match(
      text,
      /assertEventQueryBound\(tracks, OPERATOR_QUERY_LIMITS\.settingsTracks,/,
      `${name} refuses rather than silently dropping a track`,
    );
  }
  // One cap per resource across every surface that reads it: the builder and
  // the settings screen must not disagree about how many rooms an event may
  // have, or the grid would refuse what settings just let an operator create.
  const settings = reads.slice(reads.indexOf("export async function getEventSettings"));
  assert.match(settings, /take: OPERATOR_QUERY_LIMITS\.settingsRooms \+ 1/);
  assert.match(settings, /take: OPERATOR_QUERY_LIMITS\.settingsTracks \+ 1/);
});

test("the agenda builder tells an operator when the grid is incomplete", () => {
  // A conflict among sessions the read never loaded is a conflict the grid
  // cannot warn about, so silence here would read as "no conflicts".
  const builder = source("components/agenda-builder.tsx");
  assert.match(builder, /data\.truncated \? \(/);
  assert.match(builder, /more sessions than this page loads at once/);
  assert.match(builder, /conflict\s*\n?\s*count below cover only the sessions listed here/);
});

test("the public embed tells a reader when the schedule is incomplete", () => {
  const embed = source("components/embed-schedule.tsx");
  assert.match(embed, /agendaTruncationNotice\(agenda\)/);
});

test("the caps are ordered sensibly: an operator sees more than the public page", () => {
  assert.ok(
    OPERATOR_QUERY_LIMITS.agendaSessions >= PUBLIC_AGENDA_LIMITS.sessions,
    "the builder must never hold less of the programme than the public embed shows",
  );
});
