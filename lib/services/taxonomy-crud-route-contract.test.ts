import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for the taxonomy writers. Track and Category CRUD is the same
 * authorization and locking shape the Rooms route already proves
 * (`event-owned-route-contract.test.ts`), so the wiring is asserted here in the
 * same style: a route's role check, its event scoping, and the order in which it
 * locks, decides, and writes have no pure seam to observe, and a DB-backed check
 * belongs in the smoke suite, not in this one.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const TRACKS = "app/api/admin/settings/tracks/route.ts";
const CATEGORIES = "app/api/cfp/categories/route.ts";

function handler(text: string, name: string, next: string | null): string {
  const start = text.indexOf(`export const ${name}`);
  assert.notEqual(start, -1, `${name} handler is missing`);
  const end = next ? text.indexOf(`export const ${next}`) : text.length;
  return text.slice(start, end === -1 ? text.length : end);
}

test("every taxonomy write is ADMIN-only and takes its event scope from the session", () => {
  const tracks = source(TRACKS);
  for (const name of ["GET", "POST", "PATCH", "DELETE"]) {
    const next = { GET: "POST", POST: "PATCH", PATCH: "DELETE", DELETE: null }[name] ?? null;
    assert.match(handler(tracks, name, next), /requireContext\(\["ADMIN"\]\)/, `tracks ${name}`);
  }
  // The create's event scope is the session's, never the request body's — and
  // `trackCreateSchema` is `.strict()`, so a body eventId cannot even parse.
  assert.match(handler(tracks, "POST", "PATCH"), /eventId: ctx\.eventId/);
  assert.doesNotMatch(tracks, /assertEventScope/);

  const categories = source(CATEGORIES);
  for (const [name, next] of [["POST", "PATCH"], ["PATCH", "DELETE"], ["DELETE", null]] as const) {
    assert.match(handler(categories, name, next), /requireContext\(\["ADMIN"\]\)/, `categories ${name}`);
  }
  // The read stays open to evaluators, who need routing topics to review.
  assert.match(handler(categories, "GET", "POST"), /requireContext\(\["ADMIN", "EVALUATOR"\]\)/);
});

test("a taxonomy update authorizes the stored row under its write lock, not the caller's id", () => {
  const trackPatch = handler(source(TRACKS), "PATCH", "DELETE");
  assert.match(trackPatch, /prisma\.\$transaction\(/);
  assert.match(trackPatch, /FROM "Track" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(trackPatch, /requireEventOwnedRow\(existing, ctx\.eventId, "TRACK_NOT_FOUND", "Track"\)/);
  assert.ok(trackPatch.indexOf("FOR UPDATE") < trackPatch.indexOf("tx.track.update"));

  const categoryPatch = handler(source(CATEGORIES), "PATCH", "DELETE");
  assert.match(categoryPatch, /prisma\.\$transaction\(/);
  assert.match(categoryPatch, /FROM "Category" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(categoryPatch, /requireEventOwnedRow\(existing, ctx\.eventId, "CATEGORY_NOT_FOUND", "Category"\)/);
  assert.ok(categoryPatch.indexOf("FOR UPDATE") < categoryPatch.indexOf("tx.category.update"));
});

test("a category rename applies only the supplied fields, so it cannot clear review routing", () => {
  const categoryPatch = handler(source(CATEGORIES), "PATCH", "DELETE");
  for (const field of ["name", "description", "defaultTeamKey", "sortOrder"]) {
    assert.match(
      categoryPatch,
      new RegExp(`\\.\\.\\.\\(input\\.${field} !== undefined \\? \\{ ${field}: input\\.${field} \\} : \\{\\}\\)`),
      field,
    );
  }
  // The whole-row POST is the contract this handler exists to avoid reusing.
  assert.match(categoryPatch, /parseBody\(req, categoryUpdateSchema\)/);
  assert.doesNotMatch(categoryPatch, /defaultTeamKey: input\.defaultTeamKey \?\? null/);
});

test("taxonomy deletion locks the event-scoped row before it reads what references it", () => {
  const trackDelete = handler(source(TRACKS), "DELETE", null);
  assert.match(trackDelete, /prisma\.\$transaction\(/);
  // Scope is inside the locked query, so a cross-event id is a 404 that reveals
  // nothing about whether another event owns the row.
  assert.match(trackDelete, /FROM "Track"[\s\S]*?WHERE "id" = \$\{trackId\} AND "eventId" = \$\{ctx\.eventId\}[\s\S]*?FOR UPDATE/);
  assert.match(trackDelete, /if \(!lockedTrack\) throw new ApiError\(404, "TRACK_NOT_FOUND"/);
  assert.match(trackDelete, /tx\.scheduleSlot\.findFirst\(\{[\s\S]*?where: \{ trackId: lockedTrack\.id \}/);
  assert.ok(trackDelete.indexOf("FOR UPDATE") < trackDelete.indexOf("tx.scheduleSlot.findFirst"));
  assert.ok(trackDelete.indexOf("tx.scheduleSlot.findFirst") < trackDelete.indexOf("tx.track.delete"));

  const categoryDelete = handler(source(CATEGORIES), "DELETE", null);
  assert.match(categoryDelete, /prisma\.\$transaction\(/);
  assert.match(categoryDelete, /FROM "Category"[\s\S]*?WHERE "id" = \$\{categoryId\} AND "eventId" = \$\{ctx\.eventId\}[\s\S]*?FOR UPDATE/);
  assert.match(categoryDelete, /if \(!lockedCategory\) throw new ApiError\(404, "CATEGORY_NOT_FOUND"/);
  // Both references are read, because both are `onDelete: SetNull` and either
  // one alone would be silently emptied.
  assert.match(categoryDelete, /tx\.abstract\.findFirst\(\{ where: \{ categoryId: lockedCategory\.id \}/);
  assert.match(categoryDelete, /tx\.session\.findFirst\(\{ where: \{ categoryId: lockedCategory\.id \}/);
  assert.ok(categoryDelete.indexOf("FOR UPDATE") < categoryDelete.indexOf("tx.abstract.findFirst"));
  assert.ok(categoryDelete.indexOf("tx.session.findFirst") < categoryDelete.indexOf("tx.category.delete"));
});

test("an in-use refusal comes from the shared policy and never falls through to the delete", () => {
  const trackDelete = handler(source(TRACKS), "DELETE", null);
  assert.match(trackDelete, /const decision = decideTrackDeletion\(!!scheduleSlot\)/);
  assert.match(trackDelete, /if \(!decision\.allowed\)[\s\S]*?throw new ApiError\(409, decision\.code, decision\.message/);
  assert.ok(trackDelete.indexOf("decideTrackDeletion") < trackDelete.indexOf("tx.track.delete"));

  const categoryDelete = handler(source(CATEGORIES), "DELETE", null);
  assert.match(
    categoryDelete,
    /const decision = decideCategoryDeletion\(\{ hasAbstract: !!abstract, hasSession: !!session \}\)/,
  );
  assert.match(categoryDelete, /if \(!decision\.allowed\)[\s\S]*?throw new ApiError\(409, decision\.code, decision\.message/);
  assert.ok(categoryDelete.indexOf("decideCategoryDeletion") < categoryDelete.indexOf("tx.category.delete"));
});

test("taxonomy routes reuse the Rooms status codes for create, conflict and missing id", () => {
  const tracks = source(TRACKS);
  // 201 on create, matching POST /api/admin/settings/rooms.
  assert.match(handler(tracks, "POST", "PATCH"), /return ok\(\{ track \}, 201\)/);
  // A duplicate name is a conflict on both writers, with an inline field error.
  const nameTaken = [...tracks.matchAll(/new ApiError\(409, "TRACK_NAME_TAKEN"[^\r\n]*/g)];
  assert.equal(nameTaken.length, 2, "create and update must both classify a duplicate name");
  assert.match(tracks, /new ApiError\(404, "TRACK_NOT_FOUND", "Track not found\."\)/);
  assert.match(tracks, /new ApiError\(400, "MISSING_TRACK", "trackId is required\."\)/);

  const categories = source(CATEGORIES);
  assert.match(categories, /new ApiError\(400, "MISSING_CATEGORY", "categoryId is required\."\)/);
  assert.match(categories, /new ApiError\(409, "CATEGORY_NAME_TAKEN"/);
  assert.match(categories, /new ApiError\(404, "CATEGORY_NOT_FOUND", "Category not found\."\)/);
});

test("the tracks read stays bounded and stably ordered like the rooms read", () => {
  const trackGet = handler(source(TRACKS), "GET", "POST");
  assert.match(trackGet, /take: OPERATOR_QUERY_LIMITS\.settingsTracks \+ 1/);
  assert.match(trackGet, /assertEventQueryBound\(tracks, OPERATOR_QUERY_LIMITS\.settingsTracks, "tracks in event settings"\)/);
  assert.match(source(TRACKS), /const trackOrder = \[\{ sortOrder: "asc" as const \}, \{ name: "asc" as const \}, \{ id: "asc" as const \}\]/);
});
