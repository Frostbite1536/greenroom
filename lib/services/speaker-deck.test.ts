import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ApiError } from "@/lib/api/http";
import {
  DECK_FILE_INVALID_CODE,
  DECK_FILE_INVALID_MESSAGE,
  assertOwnEventDeckFile,
  deckFileIsOwnEventDeck,
  deckPointerFileId,
} from "@/lib/services/speaker-deck";

/**
 * A-20260811-1831. `EventSpeakerDeck.deckUrl` accepted any well-formed
 * `/api/files/<id>` string without resolving the row behind it, so a speaker
 * could point THIS event's association at another event's file, another
 * person's file, or a non-deck kind — and the organizer roster then labelled
 * that pointer "This event". No bytes leaked (`/api/files/:id` still decides
 * from the StoredFile row's own uploader/event, so a mispointed link 404s for
 * everyone but its real owner), but the association asserted a provenance the
 * data did not support.
 *
 * These drive the REAL fold, not a re-implementation of it: `assertOwnEventDeckFile`
 * is called with a stub transaction client, so the lookup, the matrix and the
 * thrown refusal are all the shipped code. No database is required or touched.
 */

const OWNER = "user-ada";
const EVENT = "event-forward-2026";
const OWN_DECK = "/api/files/clxownlocaldeck01";

/** A `Pick<Prisma.TransactionClient, "storedFile">` that answers from a map. */
function stubTx(rows: Record<string, { kind: string; uploaderUserId: string; eventId: string | null }>) {
  const seen: string[] = [];
  const tx = {
    storedFile: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        seen.push(where.id);
        return rows[where.id] ?? null;
      },
    },
  };
  return { tx: tx as never, seen };
}

const validRow = { kind: "SLIDE_DECK", uploaderUserId: OWNER, eventId: EVENT };

async function attempt(
  deckUrl: string,
  rows: Record<string, { kind: string; uploaderUserId: string; eventId: string | null }>,
) {
  const { tx, seen } = stubTx(rows);
  try {
    await assertOwnEventDeckFile(tx, { deckUrl, userId: OWNER, eventId: EVENT });
    return { rejected: false as const, seen };
  } catch (error) {
    assert.ok(error instanceof ApiError, "a refusal must be the repo's ApiError");
    return { rejected: true as const, error, seen };
  }
}

// ---- the defect, closed ---------------------------------------------------

test("every bad local deck pointer is refused, and all of them look identical", async () => {
  const cases: Record<string, Record<string, { kind: string; uploaderUserId: string; eventId: string | null }>> = {
    // Another event's file: the exact mislabelling the review found.
    "foreign event": { [deckPointerFileId(OWN_DECK)!]: { ...validRow, eventId: "event-someone-else" } },
    // Another person's file, in this same event.
    "foreign user": { [deckPointerFileId(OWN_DECK)!]: { ...validRow, uploaderUserId: "user-grace" } },
    // The caller's own file, in this event — but a HEADSHOT, whose bytes are
    // world-readable. Labelling it a private event deck would be the worst of
    // the four.
    "wrong kind (HEADSHOT)": { [deckPointerFileId(OWN_DECK)!]: { ...validRow, kind: "HEADSHOT" } },
    // Also not a deck: a proposal attachment.
    "wrong kind (SUPPORTING_DOCUMENT)": {
      [deckPointerFileId(OWN_DECK)!]: { ...validRow, kind: "SUPPORTING_DOCUMENT" },
    },
    // An id that names nothing at all.
    "dangling id": {},
    // An orphaned row whose event was deleted has no event claim left.
    "orphaned row": { [deckPointerFileId(OWN_DECK)!]: { ...validRow, eventId: null } },
  };

  const observed: string[] = [];
  for (const [name, rows] of Object.entries(cases)) {
    const result = await attempt(OWN_DECK, rows);
    assert.equal(result.rejected, true, `${name} must be refused`);
    const error = (result as { error: ApiError }).error;
    assert.equal(error.status, 422, `${name} must be a bounded 422`);
    assert.equal(error.code, DECK_FILE_INVALID_CODE, name);
    observed.push(`${error.status} ${error.code} ${error.message}`);
  }

  // The whole point: a caller cannot tell these six apart, so the route is not
  // an oracle for which file ids exist or which event they belong to.
  assert.equal(
    new Set(observed).size,
    1,
    `refusals must be indistinguishable, saw:\n${[...new Set(observed)].join("\n")}`,
  );
  assert.equal(observed[0], `422 ${DECK_FILE_INVALID_CODE} ${DECK_FILE_INVALID_MESSAGE}`);
  // And the message itself names no id, no event, and no other person.
  assert.doesNotMatch(DECK_FILE_INVALID_MESSAGE, /clx|event-|user-|exist|another/i);
});

test("the caller's own current-event slide deck is accepted", async () => {
  const result = await attempt(OWN_DECK, { [deckPointerFileId(OWN_DECK)!]: validRow });
  assert.equal(result.rejected, false);
  // It really did resolve the row rather than pattern-matching the string.
  assert.deepEqual(result.seen, ["clxownlocaldeck01"]);
});

test("an absolute URL is passed through unchecked and costs no query", async () => {
  for (const url of [
    "https://slides.example.test/ada.pdf",
    "https://docs.example.test/a/b/c?v=2",
    "http://slides.example.test/ada.pdf",
  ]) {
    // Deliberately an EMPTY row map: if the pass-through ever started resolving
    // a row, every one of these would fail.
    const result = await attempt(url, {});
    assert.equal(result.rejected, false, url);
    assert.deepEqual(result.seen, [], `${url} must not hit the database`);
  }
});

test("only this app's own file paths are treated as pointers", () => {
  assert.equal(deckPointerFileId("/api/files/clxownlocaldeck01"), "clxownlocaldeck01");
  // Everything the app's own recognizer rejects is an absolute-URL pass-through,
  // never a half-recognized pointer that skips the check.
  for (const notAPointer of [
    "https://slides.example.test/ada.pdf",
    "/api/files/",
    "/api/files/abc/def",
    "/api/files/abc?x=1",
    "//evil.test/api/files/abc",
    "https://evil.test/api/files/abc",
    "/API/FILES/abc",
  ]) {
    assert.equal(deckPointerFileId(notAPointer), null, notAPointer);
  }
});

test("the pure matrix requires all three facts, never two of them", () => {
  const viewer = { userId: OWNER, eventId: EVENT };
  assert.equal(deckFileIsOwnEventDeck(validRow, viewer), true);
  assert.equal(deckFileIsOwnEventDeck(null, viewer), false);
  assert.equal(deckFileIsOwnEventDeck({ ...validRow, kind: "HEADSHOT" }, viewer), false);
  assert.equal(deckFileIsOwnEventDeck({ ...validRow, uploaderUserId: "user-grace" }, viewer), false);
  assert.equal(deckFileIsOwnEventDeck({ ...validRow, eventId: "event-other" }, viewer), false);
  assert.equal(deckFileIsOwnEventDeck({ ...validRow, eventId: null }, viewer), false);
  // Right kind and right owner is still not enough without the right event —
  // the combination the review found.
  assert.equal(
    deckFileIsOwnEventDeck({ kind: "SLIDE_DECK", uploaderUserId: OWNER, eventId: "event-other" }, viewer),
    false,
  );
});

// ---- source contract ------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(path.join(repoRoot, "app/api/portal/profile/route.ts"), "utf8");

test("the local-path check runs inside the transaction and before the association write", () => {
  const lock = route.indexOf("await lockSpeakerProfile(tx, user.id);");
  const check = route.indexOf("await assertOwnEventDeckFile(tx,");
  const profileWrite = route.indexOf("tx.speakerProfile.upsert(");
  const deckWrite = route.indexOf("tx.eventSpeakerDeck.upsert(");
  assert.ok(lock > 0 && check > 0 && profileWrite > 0 && deckWrite > 0);

  // On the transaction client, under the lock the write already holds.
  assert.ok(lock < check, "the check must run under the profile lock");
  assert.match(route, /assertOwnEventDeckFile\(tx, \{ deckUrl: eventSlideDeckUrl, userId: user\.id, eventId \}\)/);
  assert.doesNotMatch(route, /assertOwnEventDeckFile\(prisma/);

  // Before ANY write, so a refused save cannot half-succeed.
  assert.ok(check < profileWrite, "the check must precede the profile write");
  assert.ok(check < deckWrite, "the check must precede the association write");

  // Guarded on non-null: `null` still clears, and an omitted key still preserves.
  assert.match(route, /if \(eventSlideDeckUrl != null\) \{/);

  // The route holds no second copy of the rule.
  assert.doesNotMatch(route, /SLIDE_DECK|uploaderUserId|isStoredFilePath/);
  assert.equal(route.split("assertOwnEventDeckFile(").length - 1, 1);
});

test("the refusal reaches the client as this route's own envelope, and faults still throw", () => {
  assert.match(route, /if \(error instanceof ApiError\) \{/);
  assert.match(route, /return fail\(error\.code, error\.message, error\.status, error\.fieldErrors\);/);
  // A non-ApiError must not be flattened into a 422 the client would act on.
  assert.match(route, /\r?\n\s*throw error;\r?\n\s*\}/);
});

test("the pointer check is scoped to the per-event association only", () => {
  // The global `slideDeckUrl` and `headshotUrl` columns are deliberately NOT
  // covered by this fix: their behaviour is unchanged, they are read by the v1
  // API and the organizer roster under their own rules, and widening the check
  // to them would be a second, unreviewed behaviour change. Stated here so the
  // omission is a decision on the record rather than something overlooked.
  const guard = route.slice(route.indexOf("if (eventSlideDeckUrl != null)"), route.indexOf("const profile ="));
  assert.doesNotMatch(guard, /\bheadshotUrl\b/);
  assert.doesNotMatch(guard, /deckUrl: data\.slideDeckUrl|deckUrl: textFields/);
});
