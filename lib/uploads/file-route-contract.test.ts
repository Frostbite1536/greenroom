import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Source contract for the upload and serving routes.
 *
 * These properties are about ORDER and PROVENANCE — the throttle running
 * before the bytes are read, the served content type coming from the stored
 * column rather than the request — and both are invisible to a unit test of
 * any single function. The repo already asserts route ordering this way
 * (`lib/services/credential-login-route-contract.test.ts`); this follows it.
 *
 * Every pattern below is CRLF-safe: line captures use `[^\r\n]` so a CRLF
 * checkout cannot smuggle a `\r` into an anchored match.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const upload = read("app/api/files/route.ts");
const serve = read("app/api/files/[id]/route.ts");
const field = read("components/file-upload-field.tsx");
const portalForm = read("app/(app)/portal/profile-form.tsx");
const roster = read("components/speaker-roster-manager.tsx");

test("an upload requires a session before anything else happens", () => {
  const auth = upload.indexOf("const ctx = await requireContext();");
  assert.ok(auth > 0, "the upload route must require a session");
  for (const later of [
    "parseStoredFileKind(",
    "await enforceUploadRateLimit(",
    "await readCappedBody(",
    "prisma.storedFile.",
  ]) {
    assert.ok(auth < upload.indexOf(later), `the session check must precede ${later}`);
  }
  // No role list: any signed-in person may upload their own headshot or deck.
  assert.doesNotMatch(upload, /requireContext\(\[/);
});

test("the throttle is charged before a byte of the body is read", () => {
  const throttle = upload.indexOf("await enforceUploadRateLimit(");
  const body = upload.indexOf("const bytes = await readCappedBody(");
  assert.ok(throttle > 0 && body > 0);
  assert.ok(throttle < body, "throttling after the read pays for the work it exists to refuse");
  // And the declared-length refusal is cheaper still, so it comes first.
  assert.ok(upload.indexOf("if (declaredLengthExceeds(req, maxBytes))") < throttle);
});

test("the size cap is enforced against the stream, not just the declared header", () => {
  // A lying Content-Length must buy nothing: the reader aborts mid-stream.
  assert.match(upload, /if \(total > maxBytes\) \{[\s\S]{0,200}?reader\.cancel\(\)[\s\S]{0,120}?throw tooLarge\(maxBytes\);/);
  assert.match(upload, /const maxBytes = storedFileMaxBytes\(kind\);/);
  // The cap is per kind and comes from the shared policy module, never inlined.
  assert.doesNotMatch(upload, /1024 \* 1024|5 \* 1024/);
});

test("oversize is 413 REQUEST_TOO_LARGE and a wrong type is 422, matching the repo's codes", () => {
  assert.match(upload, /new ApiError\(\s*413,\s*"REQUEST_TOO_LARGE",/);
  for (const code of ["FILE_KIND_UNSUPPORTED", "FILE_TYPE_UNSUPPORTED", "FILE_TYPE_MISMATCH", "UPLOAD_EMPTY"]) {
    assert.match(upload, new RegExp(`new ApiError\\(422, "${code}"`), `${code} must be a 422`);
  }
  // 413 is the repo's existing bounded-body code, reused rather than forked.
  assert.match(read("lib/api/bounded-json.ts"), /413, "REQUEST_TOO_LARGE"/);
});

test("the stored mime is the server's verdict, and the claimed header is never written", () => {
  // The only value assigned to `mime:` on the create is the verdict's.
  assert.match(upload, /mime: verdict\.mime,/);
  assert.doesNotMatch(upload, /mime: (req\.headers|claimed|contentType)/);
  // The claim reaches exactly one place: the comparison inside verifyStoredFile.
  assert.equal(upload.split('req.headers.get("content-type")').length - 1, 1);
  assert.match(upload, /claimedMime: normalizeMime\(req\.headers\.get\("content-type"\)\)/);
  // The size stored is the real byte length, not the declared one.
  assert.match(upload, /size: bytes\.byteLength,/);
});

test("dedupe returns the existing id, and a race on it is resolved rather than 500ing", () => {
  assert.match(upload, /storedFileDedupeKey\(\{ uploaderUserId: ctx\.userId, kind, sha256 \}\)/);
  assert.match(upload, /where: \{ uploaderUserId_kind_sha256: dedupe \}/);
  assert.equal(upload.split("uploaderUserId_kind_sha256: dedupe").length - 1, 2, "pre-read plus the P2002 recovery");
  assert.match(upload, /error\.code === "P2002"/);
  assert.match(upload, /deduped: true/);
  // A fresh store is a 201; a dedupe hit is a 200 on the row that already exists.
  assert.match(upload, /deduped: false \},\s*201,/);
});

test("the served content type comes from the stored column and is pinned with nosniff", () => {
  assert.match(serve, /"Content-Type": file\.mime,/);
  assert.match(serve, /"X-Content-Type-Options": "nosniff",/);
  // Nothing in the serving route reads a request header to decide the type.
  assert.doesNotMatch(serve, /req\.headers\.get/);
});

test("authorization is the shared pure matrix, and a refusal is indistinguishable from absence", () => {
  assert.match(serve, /if \(!canReadStoredFile\(file, viewer\)\) throw notFound\(\);/);
  // No second, hand-rolled policy in the route.
  assert.equal(serve.split("canReadStoredFile(").length - 1, 1);
  assert.doesNotMatch(serve, /role === "ADMIN"|kind === "SLIDE_DECK"/);
  // Missing and forbidden are the same 404 with the same code, so the route is
  // not an existence oracle for a stranger's file id.
  assert.equal(serve.split("new ApiError(404,").length - 1, 1);
  assert.equal(serve.split("throw notFound();").length - 1, 2);
  assert.doesNotMatch(serve, /status: 40[13]|new ApiError\(40[13]/);
});

test("a public headshot resolves no session, so it stays cacheable", () => {
  // Calling getApiContext() unconditionally would make every embed's headshot a
  // session-dependent response.
  assert.match(serve, /const viewer = file\.kind === "HEADSHOT" \? null : await getApiContext\(\);/);
  assert.equal(serve.split("getApiContext(").length - 1, 1);
  // Caching and disposition are the policy module's, not restated here.
  assert.match(serve, /"Cache-Control": storedFileCacheControl\(file\.kind\)/);
  assert.match(serve, /"Content-Disposition": storedFileDisposition\(file\.kind\)/);
  assert.doesNotMatch(serve, /max-age=|immutable|no-store/);
});

test("the upload field fills the URL column beside it rather than replacing the field", () => {
  // Both surfaces keep their text input: uploading is an alternative way to
  // fill one field, not a second column and not a replacement.
  assert.match(portalForm, /onUploaded=\{\(url\) => update\("headshotUrl", url\)\}/);
  assert.match(portalForm, /onUploaded=\{\(url\) => update\("slideDeckUrl", url\)\}/);
  assert.match(portalForm, /value=\{form\.headshotUrl\}/);
  assert.match(portalForm, /value=\{form\.slideDeckUrl\}/);
  assert.match(roster, /onUploaded=\{\(url\) => onChange\(\{ \.\.\.draft, headshotUrl: url \}\)\}/);
  assert.match(roster, /value=\{draft\.headshotUrl\}/);
});

test("the roster's headshot input cannot be blocked by native URL validation", () => {
  // An uploaded value is `/api/files/<id>`; `type="url"` would mark that
  // invalid and the dialog's submit would silently do nothing.
  const headshotInput = roster.slice(roster.indexOf("`${ids}-headshotUrl`"), roster.indexOf("headshot-help"));
  // Whole attribute lines only, `\r?$`-anchored: the prose explaining why the
  // attribute is gone necessarily quotes it, and a CRLF checkout must not
  // break the anchor.
  assert.doesNotMatch(headshotInput, /^\s*type="url"\r?$/m);
  assert.match(headshotInput, /^\s*type="text"\r?$/m);
  assert.match(headshotInput, /^\s*inputMode="url"\r?$/m);
});

test("the client island posts raw bytes and never decides what the file is", () => {
  assert.match(field, /method: "POST"/);
  assert.match(field, /body: file,/);
  // No FormData, no client-side sniffing, no client-chosen mime beyond the
  // browser's own — the server re-derives it from the bytes either way.
  assert.doesNotMatch(field, /FormData|multipart/);
  assert.match(field, /"Content-Type": file\.type \|\| "application\/octet-stream"/);
  // The cap it shows comes from the same policy the server enforces.
  assert.match(field, /storedFileMaxBytes\(kind\)/);
  assert.doesNotMatch(field, /1024 \* 1024/);
});

test("no route boundary file was added for the new segment", () => {
  // loading.tsx is banned repo-wide (D-C5-14 amendment): a segment-level
  // loading boundary streams a 200 before a redirect/notFound runs.
  for (const banned of ["app/api/files/loading.tsx", "app/api/files/[id]/loading.tsx"]) {
    assert.throws(() => read(banned), /ENOENT/, `${banned} must not exist`);
  }
});
