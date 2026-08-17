import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  INTERNAL_SESSION_DESCRIPTIONS,
  PUBLIC_SESSION_SUMMARY_FALLBACK,
  publicSessionDescription,
  publicSessionSummary,
} from "@/lib/public-session-copy";

test("a real attendee-facing summary reaches the public surface untouched", () => {
  const summary = "We rebuilt our vector index and cut p99 latency by 40%. Here is how.";
  assert.equal(publicSessionDescription(summary), summary);
  assert.equal(publicSessionSummary(summary), summary);
});

test("an internal provenance sentence is treated exactly like a missing summary", () => {
  for (const provenance of INTERNAL_SESSION_DESCRIPTIONS) {
    assert.equal(publicSessionDescription(provenance), null, provenance);
    assert.equal(publicSessionSummary(provenance), PUBLIC_SESSION_SUMMARY_FALLBACK, provenance);
  }
});

test("the two provenance sentences the seed writes are the ones covered", () => {
  // Pinned against the seed itself rather than restated from memory: if the
  // seed's wording drifts, this fails instead of the guard quietly going blind.
  const seed = readFileSync(new URL("../lib/demo/seed.ts", import.meta.url), "utf8");
  for (const provenance of INTERNAL_SESSION_DESCRIPTIONS) {
    assert.ok(seed.includes(provenance), `seed no longer writes: ${provenance}`);
  }
});

test("surrounding whitespace does not smuggle provenance text through", () => {
  assert.equal(publicSessionDescription(`  ${INTERNAL_SESSION_DESCRIPTIONS[0]}\n`), null);
});

test("the guard matches whole strings only, never substrings", () => {
  // A speaker whose real summary happens to quote the phrase keeps their copy.
  // Widening this to `includes()` would silently delete real descriptions.
  const real = `${INTERNAL_SESSION_DESCRIPTIONS[0]} That is why this talk exists.`;
  assert.equal(publicSessionDescription(real), real);
});

test("a blank or absent description is null, not an empty paragraph", () => {
  assert.equal(publicSessionDescription(null), null);
  assert.equal(publicSessionDescription(undefined), null);
  assert.equal(publicSessionDescription(""), null);
  assert.equal(publicSessionDescription("   \n  "), null);
});

test("the printable form always says something honest", () => {
  assert.equal(publicSessionSummary(null), PUBLIC_SESSION_SUMMARY_FALLBACK);
  assert.equal(publicSessionSummary("   "), PUBLIC_SESSION_SUMMARY_FALLBACK);
  // It states the absence; it does not describe a talk nobody described.
  assert.match(PUBLIC_SESSION_SUMMARY_FALLBACK, /not been published/);
});

test("every public description path reads through the sanitizer", () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  // The server-rendered projection, its JSON twin, and the calendar file are
  // the three ways a Session.description leaves the building. Each must go
  // through the guard rather than printing the column directly.
  assert.match(source("lib/data/reads.ts"), /description: publicSessionDescription\(slot\.session\.description\)/);
  assert.match(
    source("app/api/agenda/public/route.ts"),
    /description: publicSessionDescription\(slot\.session\.description\)/,
  );
  assert.match(source("app/api/comms/calendar/route.ts"), /description: publicSessionSummary\(s\.description\)/);

  for (const path of ["app/api/agenda/public/route.ts", "app/api/comms/calendar/route.ts"]) {
    assert.doesNotMatch(source(path), /description: (?:slot\.)?s(?:ession)?\.description/, path);
  }

  // `lib/data/reads.ts` holds admin reads as well, so the guard is scoped to the
  // public projection rather than the whole file (W24). Everything from the
  // public agenda onwards must still go through the sanitizer.
  const reads = source("lib/data/reads.ts");
  const publicReads = reads.slice(reads.indexOf("export const getPublicAgenda"));
  assert.doesNotMatch(
    publicReads,
    /description: (?:slot\.)?s(?:ession)?\.description/,
    "lib/data/reads.ts (public projections)",
  );
});

test("the admin agenda read carries the stored column, deliberately unsanitized", () => {
  // The builder's "Edit session" dialog writes this value back, so it has to
  // show what is actually stored: routing an editor's initial value through the
  // public guard would blank an internal provenance sentence on screen and turn
  // the next save into a silent deletion. The guard belongs on the way out to a
  // reader, which is what the test above pins.
  const reads = readFileSync(new URL("../lib/data/reads.ts", import.meta.url), "utf8");
  const adminAgenda = reads.slice(
    reads.indexOf("export async function readAgendaData"),
    reads.indexOf("export const getPublicAgenda"),
  );
  assert.match(adminAgenda, /description: s\.description,/);
  assert.doesNotMatch(adminAgenda, /publicSessionDescription/);
});
