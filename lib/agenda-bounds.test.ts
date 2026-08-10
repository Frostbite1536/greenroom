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
const agendaData = reads.slice(reads.indexOf("export async function getAgendaData"));
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
