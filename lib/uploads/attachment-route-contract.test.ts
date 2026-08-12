import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Source contract for the proposal-attachment routes and the portal island.
 *
 * These are ORDER and PROVENANCE properties — the session check preceding the
 * proposal lookup, the cap counted under the per-abstract lock, ownership
 * living in a `WHERE` rather than a branch, the anonymous CFP gaining nothing —
 * and none of them is visible to a unit test of any single function. Follows
 * `lib/uploads/file-route-contract.test.ts`, which asserts the upload routes the
 * same way.
 *
 * Every pattern is CRLF-safe: line-anchored captures use `[^\r\n]` or `\r?$`, so
 * a CRLF checkout cannot smuggle a `\r` into an anchored match.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const list = read("app/api/cfp/submissions/[abstractId]/attachments/route.ts");
const remove = read("app/api/cfp/submissions/[abstractId]/attachments/[attachmentId]/route.ts");
const service = read("lib/services/abstract-attachment.ts");
const island = read("app/(app)/portal/submissions/[abstractId]/proposal-attachments.tsx");
const editor = read("app/(app)/portal/submissions/[abstractId]/submission-editor.tsx");
const field = read("components/file-upload-field.tsx");
const publicCfp = read("app/api/cfp/submissions/route.ts");
const upload = read("app/api/files/route.ts");

/** One exported handler's body, so ordering is asserted inside it rather than
 *  against a file whose helpers are necessarily declared above it. */
function handlerBody(source: string, name: "GET" | "POST" | "DELETE"): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `${name} must be exported from this route`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("every attachment handler requires a session before it looks at a proposal", () => {
  const handlers = [
    ["GET", handlerBody(list, "GET")],
    ["POST", handlerBody(list, "POST")],
    ["DELETE", handlerBody(remove, "DELETE")],
  ] as const;

  for (const [name, body] of handlers) {
    const auth = body.indexOf("await requireContext();");
    assert.ok(auth > 0, `${name} must require a session`);
    for (const later of [
      "await ctx.params",
      "loadOwnAbstract(",
      "prisma.$transaction",
      "parseBody(",
    ]) {
      const at = body.indexOf(later);
      if (at > 0) assert.ok(auth < at, `${name}: the session check must precede ${later}`);
    }
  }
  for (const [name, source] of [["list/attach", list], ["remove", remove]] as const) {
    // No role list: a speaker is any signed-in person on their own proposal.
    assert.doesNotMatch(source, /requireContext\(\[/, name);
    // And the only context resolver used is the one that throws 401.
    assert.doesNotMatch(source, /getApiContext\(/, name);
  }
});

test("the anonymous public CFP gained no attachment surface at all", () => {
  // The public submit route is where an unauthenticated write lands. Nothing
  // about attachments may appear in it.
  assert.doesNotMatch(publicCfp, /attachment|Attachment|SUPPORTING_DOCUMENT/);
  // And the upload route still parses a kind from the query without knowing
  // anything about proposals — no abstract id, no attachment write.
  assert.doesNotMatch(upload, /abstractAttachment|abstractId/);
});

test("a foreign or cross-event proposal is the same 404 as one that does not exist", () => {
  // Event scope and roster membership collapse into ONE refusal, so neither can
  // be used to confirm that a proposal exists in this event.
  assert.match(list, /if \(!abstract \|\| abstract\.eventId !== ctx\.eventId\) throw abstractNotFound\(\);/);
  assert.match(list, /if \(!isAbstractSpeaker\(ctx\.userId, abstract\.speakers\)\) throw abstractNotFound\(\);/);
  assert.match(remove, /if \(!abstract \|\| abstract\.eventId !== apiCtx\.eventId\) throw abstractNotFound\(\);/);
  assert.match(remove, /if \(!isAbstractSpeaker\(apiCtx\.userId, abstract\.speakers\)\) throw abstractNotFound\(\);/);
  // One 404 code for the proposal, in one place, in the service.
  assert.match(service, /new ApiError\(404, "ABSTRACT_NOT_FOUND"/);
  // No 403 anywhere in either route: a 403 would confirm the record is real.
  for (const [name, source] of [["list/attach", list], ["remove", remove]] as const) {
    assert.doesNotMatch(source, /new ApiError\(403|status: 403/, name);
  }
});

test("the edit window is the page's own refusal, never a second status list", () => {
  // The one function that produces the editor's canEdit/lockReason.
  assert.match(service, /const refusal = speakerEditRefusal\(status, closesAt, now\);/);
  assert.match(service, /new ApiError\(409, refusal\.code, refusal\.message\)/);
  // Neither route restates which statuses are editable.
  for (const [name, source] of [["list/attach", list], ["remove", remove]] as const) {
    assert.doesNotMatch(source, /EDITABLE_STATUSES|"DRAFT"|"SUBMITTED"|"UNDER_REVIEW"|"ACCEPTED"/, name);
    assert.match(source, /attachmentEditRefusal\(/, name);
  }
  // And the service is the only place that knows the mapping.
  assert.equal(service.split("speakerEditRefusal(").length - 1, 1);
});

test("the cap is counted and enforced under the per-abstract lock, after a fresh re-read", () => {
  const lock = list.indexOf("await lockAbstractForWrite(tx, abstractId);");
  const reread = list.indexOf("const fresh = await tx.abstract.findUnique(");
  const count = list.indexOf("const existingCount = await tx.abstractAttachment.count(");
  const create = list.indexOf("tx.abstractAttachment.create(");
  assert.ok(lock > 0 && reread > 0 && count > 0 && create > 0);
  assert.ok(lock < reread, "the mutable status/roster re-read must follow the lock");
  assert.ok(reread < count, "the count must be taken after the proposal is re-verified");
  assert.ok(count < create, "counting after the write is not a cap");
  // The number itself is the policy module's, never inlined at the route.
  assert.match(list, /attachmentLimitError\(existingCount\)/);
  assert.doesNotMatch(list, />= 3|=== 3|length > 3/);
});

test("a linked file must be the caller's own supporting document in this event", () => {
  // All four conditions, so a deck, another person's file, or a file uploaded
  // under a different event can never be attached here.
  assert.match(list, /file\.kind !== "SUPPORTING_DOCUMENT"/);
  assert.match(list, /file\.uploaderUserId !== apiCtx\.userId/);
  assert.match(list, /file\.eventId !== fresh\.eventId/);
  assert.match(list, /throw storedFileNotFound\(\);/);
  // Same indistinguishable 404 the serving route uses for a stranger's id.
  assert.match(service, /new ApiError\(404, "FILE_NOT_FOUND", "File not found\."\)/);
});

test("removal is ownership in the WHERE, and every miss is one 404", () => {
  assert.match(
    remove,
    /deleteMany\(\{\s*where: \{ id: attachmentId, abstractId, uploadedById: apiCtx\.userId \},\s*\}\)/,
  );
  assert.match(remove, /if \(removed\.count === 0\) throw attachmentNotFound\(\);/);
  // The bytes are never touched: no StoredFile write of any kind lives here.
  assert.doesNotMatch(remove, /storedFile\.delete|storedFile\.update|prisma\.storedFile/);
  assert.match(remove, /What this deletes is the LINK, never the bytes/);
});

test("the attach path reuses the existing upload pipeline rather than forking it", () => {
  // The island uploads through the shared field, which posts to /api/files.
  assert.match(island, /kind="SUPPORTING_DOCUMENT"/);
  assert.match(island, /<FileUploadField/);
  assert.match(field, /`\/api\/files\?kind=\$\{storedFileKindParam\(kind\)\}`/);
  // The attach request carries an id, never bytes: no second upload path.
  assert.match(island, /body: JSON\.stringify\(\{ storedFileId, filename \}\)/);
  assert.doesNotMatch(island, /body: file|FormData|multipart/);
  // And the attach route stores no bytes: none of the upload pipeline's own
  // machinery is called here, and no `bytes` column is ever written.
  assert.doesNotMatch(list, /readCappedBody|sniffMime\(|verifyStoredFile\(|normalizeMime\(/);
  assert.doesNotMatch(list, /bytes:|storedFile\.create|storedFile\.update/);
});

test("the island renders the server's answer and never decides authorization itself", () => {
  // canOpen/canRemove/editable all arrive from the server projection.
  assert.match(island, /attachment\.canOpen \?/);
  assert.match(island, /attachment\.canRemove \?/);
  assert.match(island, /setEditable\(Boolean\(body\.data\.editable\)\)/);
  // No client-side role or ownership test.
  assert.doesNotMatch(island, /role === "ADMIN"|uploadedByUserId ===/);
  // A row the viewer cannot open is not rendered as a link that would 404.
  assert.match(island, /Only \{attachment\.uploadedByName\} and the/);
});

test("attachment transport failures emit bounded diagnostics without file or response data", () => {
  for (const label of [
    "Supporting document list failed",
    "Supporting document attach failed",
    "Supporting document removal failed",
  ]) {
    assert.match(
      island,
      new RegExp(`${label}\\",\\s*caught instanceof Error \\? caught\\.name : \\"unknown\\"`),
    );
  }
  const warningCalls = [...island.matchAll(/console\.warn\(([\s\S]*?)\);/g)].map((match) => match[1]);
  assert.equal(warningCalls.length, 3);
  for (const call of warningCalls) {
    assert.doesNotMatch(
      call,
      /abstractId|attachmentId|storedFileId|filename|body|caught\.message|caught\.stack/,
    );
  }
});

test("attachments are their own island, so the PATCH contract gained no field", () => {
  assert.match(editor, /<ProposalAttachments abstractId=\{abstractId\} \/>/);
  // The save payload is unchanged: nothing attachment-shaped is sent with it.
  const savePayload = editor.slice(editor.indexOf("body: JSON.stringify({"), editor.indexOf("const body = await res.json();"));
  assert.doesNotMatch(savePayload, /attachment/i);
});

test("no route boundary file was added for the new segments", () => {
  // loading.tsx is banned repo-wide (D-C5-14 amendment): a segment-level
  // loading boundary streams a 200 before a redirect/notFound runs.
  for (const banned of [
    "app/api/cfp/submissions/[abstractId]/attachments/loading.tsx",
    "app/api/cfp/submissions/[abstractId]/attachments/[attachmentId]/loading.tsx",
  ]) {
    assert.throws(() => read(banned), /ENOENT/, `${banned} must not exist`);
  }
});
