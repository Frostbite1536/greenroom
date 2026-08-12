import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Source contract for the organizer-facing halves of both features: the
 * attachment fold in the abstracts drawer, and per-event deck resolution
 * wherever an admin reads a deck.
 *
 * These are PROVENANCE properties — one resolution function shared by the
 * speaker's portal and the organizer's roster, one authorization matrix shared
 * by the drawer and the serving route, bounds keyed on rendered ids rather than
 * on an event. None is visible to a unit test of any single function.
 *
 * CRLF-safe: no pattern crosses a line break.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const reads = read("lib/data/reads.ts");
const table = read("components/abstracts-table.tsx");
const rosterRead = read("lib/speakers/roster-read.ts");
const rosterPage = read("app/(app)/admin/speakers/page.tsx");
const portalForm = read("app/(app)/portal/profile-form.tsx");
const exportRoute = read("app/api/admin/speakers/export/route.ts");

// ---- drawer attachments ---------------------------------------------------

test("the drawer's attachment read is bounded by the product's own per-proposal cap", () => {
  assert.match(reads, /take: MAX_ATTACHMENTS_PER_ABSTRACT \* materializedIds\.length,/);
  // Scoped to the same at-most-101 ids as every other child read on this page,
  // never grouped by event.
  assert.match(reads, /where: childWhere,\r?\n\s*orderBy: \[\{ abstractId: "asc" \}, \.\.\.attachmentOrderBy\],/);
  // Deterministic order, so a bounded take can never be a different slice.
  assert.match(reads, /\.\.\.attachmentOrderBy/);
});

test("the drawer decides nothing about who may open a document", () => {
  // The read projects through the shared matrix the serving route enforces.
  assert.match(reads, /viewAttachments\(\[toAttachmentSubject\(row\)\], ctx, \{ editable: false \}\)/);
  // `editable: false` is the point: an organizer never removes a speaker's file.
  assert.doesNotMatch(reads, /viewAttachments\([^)]*editable: true/);
  // And the component renders that answer rather than recomputing it.
  assert.match(table, /attachment\.canOpen \? \(/);
  assert.doesNotMatch(table, /canReadStoredFile|role === "ADMIN"/);
  // No remove control exists on the organizer surface at all.
  assert.doesNotMatch(table, /canRemove/);
});

test("the drawer states an empty list rather than omitting the section", () => {
  assert.match(table, /<SubmissionAttachments abstract=\{abstract\} \/>/);
  assert.match(table, /The speakers attached no supporting documents to this proposal\./);
  // Sizes come from the shared formatter, never re-derived in the component.
  assert.match(table, /formatAttachmentSize\(attachment\.size\)/);
  assert.doesNotMatch(table, /1024 \* 1024/);
});

// ---- per-event deck resolution -------------------------------------------

test("the roster resolves a deck with the one shared function, keyed on rendered ids", () => {
  assert.match(rosterRead, /const rosterUserIds = rows\.map\(\(row\) => row\.userId\);/);
  for (const model of ["prisma.eventSpeakerDeck.findMany", "prisma.speakerProfile.findMany"]) {
    const at = rosterRead.indexOf(model);
    assert.ok(at > 0, `${model} must exist`);
  }
  // Both deck reads are bounded by the ids this read returns — never by event.
  assert.match(rosterRead, /where: \{ eventId, userId: \{ in: rosterUserIds \} \},/);
  assert.match(rosterRead, /where: \{ userId: \{ in: rosterUserIds \} \},/);
  // Empty roster short-circuits rather than issuing an `in: []` pair.
  assert.match(rosterRead, /rosterUserIds\.length === 0/);
  // Resolution is the pure function, not an inline `??` chain.
  assert.match(rosterRead, /resolveRosterDecks\(/);
  assert.doesNotMatch(rosterRead, /deckUrl \?\? .*slideDeckUrl/);
});

test("the global column stays out of the profile-completeness projection", () => {
  // `profileSelect` feeds SpeakerProfileInput, whose four prose fields are what
  // "profile complete" counts. A deck is not one of them, and adding it there
  // would silently change every completeness percentage on this screen.
  const projection = rosterRead.slice(rosterRead.indexOf("const profileSelect = {"), rosterRead.indexOf("export type SpeakerRosterView"));
  assert.doesNotMatch(projection, /slideDeckUrl/);
});

test("the deck rides beside the roster rows, not on them", () => {
  // SpeakerStatusRow is shared with the /admin dashboard card, the CSV export
  // and the report metrics. None asked for a deck.
  const status = read("lib/speakers/status.ts");
  assert.doesNotMatch(status, /slideDeckUrl|deckUrl|SpeakerDeckSource/);
  assert.match(rosterRead, /decks: Record<string, ResolvedSpeakerDeck>;/);
  // The CSV export is unchanged: narrower than the screen is allowed, wider is
  // not, and a private deck URL is not an export column.
  assert.doesNotMatch(exportRoute, /deck|Deck/);
});

test("every surface that shows a deck names where it came from", () => {
  // Organizer roster.
  assert.match(rosterPage, /speakerDeckSourceLabel\(deck\.source\)/);
  assert.match(rosterPage, /speakerDeckSourceHint\(deck\.source\)/);
  assert.match(rosterPage, /No slide deck/);
  // Speaker portal, resolved by the SAME function so the two cannot disagree.
  assert.match(portalForm, /resolveSpeakerDeck\(\{/);
  assert.match(portalForm, /eventDeckUrl: baseline\.eventSlideDeckUrl,/);
  assert.match(portalForm, /profileDeckUrl: baseline\.slideDeckUrl,/);
  // Neither surface hand-rolls the precedence.
  for (const [name, source] of [["roster page", rosterPage], ["portal form", portalForm]] as const) {
    assert.doesNotMatch(source, /eventSlideDeckUrl \|\| |eventDeckUrl \?\? profile/, name);
  }
});
