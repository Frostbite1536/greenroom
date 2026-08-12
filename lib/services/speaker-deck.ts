import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/http";
import { isStoredFilePath, storedFileIdFromPath } from "@/lib/uploads/stored-file";

/**
 * Ownership and scope check for a per-event deck POINTER.
 *
 * `EventSpeakerDeck.deckUrl` holds one of two very different things, and only
 * one of them is ours to vouch for:
 *
 *   - An ABSOLUTE URL is the speaker's own asserted link to somewhere we do not
 *     own. It is passed through unchanged. We cannot verify it, we never
 *     claimed to, and pretending otherwise would be the dishonest option.
 *   - A LOCAL `/api/files/<id>` path is a pointer INTO THIS APPLICATION'S OWN
 *     storage, and by writing it into an event's association we are asserting
 *     "this file is this speaker's deck for this event." That assertion has to
 *     be true.
 *
 * It was not. `nullableProfileUrl` accepts any well-formed `/api/files/<id>`
 * string without resolving the row behind it, so a speaker could point this
 * event's association at a file id belonging to another event, another person,
 * or a different kind entirely. No bytes leaked — `/api/files/:id` still
 * decides from the `StoredFile` row's own `uploaderUserId`/`eventId`, so a
 * mispointed link simply 404s for everyone who is not its real owner — but the
 * ORGANIZER ROSTER then labelled that pointer "This event", which is a claim
 * about provenance the data did not support. A deck association that says "this
 * event" has to mean it, or the label is worse than no label.
 *
 * So a local pointer must resolve to a row that is all three of: a
 * `SLIDE_DECK`, uploaded by this caller, under this caller's active event.
 */

export const DECK_FILE_INVALID_CODE = "DECK_FILE_INVALID";

/**
 * ONE message for every rejection.
 *
 * Missing, wrong kind, another person's, and another event's are deliberately
 * indistinguishable. Splitting them would turn this route into an oracle: a
 * caller could sweep file ids and learn which ones exist somewhere on the
 * instance, and — worse across an event boundary — that a given id belongs to a
 * conference they are not part of. The message names the fix rather than the
 * reason, which is also the only part a speaker can act on.
 */
export const DECK_FILE_INVALID_MESSAGE =
  "That slide deck link is not a file you uploaded for this event. Upload the deck again here, or paste a link to it instead.";

export function deckFileInvalidError(): ApiError {
  return new ApiError(422, DECK_FILE_INVALID_CODE, DECK_FILE_INVALID_MESSAGE, {
    eventSlideDeckUrl: [DECK_FILE_INVALID_MESSAGE],
  });
}

/**
 * The stored-file id a deck pointer names, or null when it names none.
 *
 * Delegates to the app's own path recognizer rather than re-testing the shape:
 * `isStoredFilePath` accepts one leading slash, the exact prefix and a cuid-ish
 * id with nothing after it — no scheme, no host, no traversal, no query — and a
 * second, looser copy of that rule here is exactly how a bypass would appear.
 * Anything it rejects (in practice, an absolute URL) returns null and is
 * therefore passed through unchecked, which is the documented behaviour.
 */
export function deckPointerFileId(deckUrl: string): string | null {
  return isStoredFilePath(deckUrl) ? storedFileIdFromPath(deckUrl) : null;
}

/** What a local pointer's row must be for the association to be truthful. */
export type DeckFileRow = {
  kind: string;
  uploaderUserId: string;
  eventId: string | null;
};

/**
 * The whole decision, with the row already fetched. Pure, so the matrix is
 * testable without a live table — the same split `canReadStoredFile` uses.
 *
 * A null row (no such file) is a rejection like any other, and returns the same
 * verdict as a foreign one so the two cannot be told apart.
 */
export function deckFileIsOwnEventDeck(
  file: DeckFileRow | null,
  viewer: { userId: string; eventId: string },
): boolean {
  if (!file) return false;
  // A headshot or a proposal attachment is not a deck. Without this, a speaker
  // could label their own PUBLIC headshot as this event's private deck, and the
  // roster would offer organizers a link whose bytes are world-readable.
  if (file.kind !== "SLIDE_DECK") return false;
  if (file.uploaderUserId !== viewer.userId) return false;
  // `eventId: null` is an orphaned row whose event is gone. It has no event
  // claim left, so it cannot be THIS event's deck either.
  return file.eventId !== null && file.eventId === viewer.eventId;
}

/**
 * Resolve and check a deck pointer, or throw the one bounded 422.
 *
 * Takes the transaction client on purpose: the caller already holds the speaker
 * profile lock and is about to write the association, so resolving the row on a
 * different connection would decide against a `StoredFile` that a concurrent
 * delete could have removed before the association naming it is committed.
 *
 * An absolute URL returns immediately without a query — the pass-through is not
 * an oversight, and it costs no round trip.
 */
export async function assertOwnEventDeckFile(
  tx: Pick<Prisma.TransactionClient, "storedFile">,
  input: { deckUrl: string; userId: string; eventId: string },
): Promise<void> {
  const fileId = deckPointerFileId(input.deckUrl);
  if (fileId === null) return;

  const file = await tx.storedFile.findUnique({
    where: { id: fileId },
    select: { kind: true, uploaderUserId: true, eventId: true },
  });
  if (!deckFileIsOwnEventDeck(file, { userId: input.userId, eventId: input.eventId })) {
    throw deckFileInvalidError();
  }
}
