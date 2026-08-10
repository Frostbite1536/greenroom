import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boundedCount, boundedCountLabel, derivedBoundedCount } from "./bounded-count";

test("a complete read prints an exact number, unchanged from before", () => {
  assert.equal(boundedCount(0, false), "0");
  assert.equal(boundedCount(12, false), "12");
  assert.equal(boundedCountLabel(1, false, "session"), "1 session");
  assert.equal(boundedCountLabel(12, false, "session"), "12 sessions");
});

test("a capped read prints a floor, never a total", () => {
  assert.equal(boundedCount(500, true), "500+");
  assert.equal(boundedCountLabel(500, true, "session"), "500+ sessions");
});

test("a floor is always plural, because there are at least that many", () => {
  // "1+ session" would read as a total of one. The qualifier means "one or
  // more", so the noun has to agree with the more.
  assert.equal(boundedCountLabel(1, true, "session"), "1+ sessions");
});

test("an irregular plural is spelled out rather than guessed", () => {
  assert.equal(boundedCountLabel(2, false, "person", "people"), "2 people");
  assert.equal(boundedCountLabel(200, true, "person", "people"), "200+ people");
});

test("a count derived from a capped array carries the same qualifier", () => {
  // The landing page's speaker tally is a distinct-set size over the capped
  // sessions: past the cap it can only undercount.
  assert.equal(derivedBoundedCount(87, true), "87+");
  assert.equal(derivedBoundedCount(87, false), "87");
});

/**
 * Source contract. The defect this closes is a *rendering* one — a capped array
 * whose `.length` is printed as a total — and no pure function can observe a
 * consumer that forgot to consult the flag. These pin every consumer of the two
 * capped reads, so adding a fifth metric off `sessions.length` without the
 * qualifier fails here rather than shipping a confident wrong number.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no consumer issues a second count() to 'get the real number'", () => {
  // The email-history rule: one cap-plus-one read is the single source of both
  // the rows and the volume language. A second query would let two values
  // disagree with each other as well as with what is on screen.
  for (const path of [
    "app/page.tsx",
    "app/(app)/admin/agenda/page.tsx",
    "app/api/agenda/public/route.ts",
    "app/api/agenda/route.ts",
  ]) {
    assert.doesNotMatch(source(path), /\.count\(/, `${path} must not issue a count() query`);
  }
  // Sliced to each function's own body — `reads.ts` holds many other reads,
  // several of which legitimately count.
  const reads = source("lib/data/reads.ts");
  const bodyOf = (start: string) => {
    const from = reads.indexOf(start);
    assert.notEqual(from, -1, `${start} not found in reads.ts`);
    const next = reads.indexOf("\nexport ", from + start.length);
    return reads.slice(from, next === -1 ? undefined : next);
  };
  assert.doesNotMatch(bodyOf("export const getPublicAgenda"), /\.count\(/);
  assert.doesNotMatch(bodyOf("export async function getAgendaData"), /\.count\(/);
});

test("the landing metrics qualify both counts taken off the capped session read", () => {
  const landing = source("app/page.tsx");
  assert.match(landing, /boundedCount\(sessionCount, programmeTruncated\)/);
  assert.match(landing, /derivedBoundedCount\(speakerCount, programmeTruncated\)/);
  assert.match(landing, /const programmeTruncated = agenda\?\.truncated \?\? false/);
  // Tracks come from their own uncapped read, so that one stays an exact number.
  assert.match(landing, /<strong>\{trackCount\}<\/strong>/);
});

test("the admin agenda totals qualify both session figures", () => {
  const page = source("app/(app)/admin/agenda/page.tsx");
  assert.match(page, /boundedCount\(scheduled, data\.truncated\)/);
  assert.match(page, /boundedCount\(data\.sessions\.length - scheduled, data\.truncated\)/);
  // Rooms and tracks are separate uncapped reads and stay exact.
  assert.match(page, /\{data\.rooms\.length\} · \{data\.tracks\.length\}/);
});

test("every count the agenda builder prints branches on the flag", () => {
  const builder = source("components/agenda-builder.tsx");
  assert.match(builder, /boundedCount\(conflicts\.length, data\.truncated\)/);
  assert.match(builder, /boundedCountLabel\(conflicts\.length, data\.truncated, "scheduling conflict"\)/);
  assert.match(builder, /boundedCount\(unscheduled\.length, data\.truncated\)/);
  assert.match(builder, /unpublishedNotice\(sessions\.map\(\(s\) => s\.contentStatus\), data\.truncated\)/);
  // A bare `.length` inside a rendered expression is exactly the defect.
  assert.doesNotMatch(builder, /\{conflicts\.length\}/);
  assert.doesNotMatch(builder, /\{unscheduled\.length\}/);
});

test("the two public embeds qualify their headline counts", () => {
  assert.match(
    source("components/embed-schedule.tsx"),
    /resultSummary\(agenda\.sessions\.length, filtered\.length, isFiltered, agenda\.truncated \?\? false\)/,
  );
  assert.match(
    source("components/embed-speakers.tsx"),
    /boundedCountLabel\(gallery\.speakers\.length, gallery\.truncated, "speaker"\)/,
  );
});

test("a truncated conflicts view does not clear the whole event", () => {
  const builder = source("components/agenda-builder.tsx");
  // The unqualified copy still exists for the complete case, and the truncated
  // branch must not reuse it.
  assert.match(builder, /Every room and speaker has a clear schedule\./);
  assert.match(builder, /No conflicts in the sessions loaded here/);
  assert.match(builder, /not a clear bill of health/);
});
