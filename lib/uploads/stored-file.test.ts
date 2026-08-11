import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STORED_FILE_LIMITS,
  canReadStoredFile,
  isStoredFilePath,
  normalizeMime,
  parseStoredFileKind,
  sniffMime,
  storedFileCacheControl,
  storedFileDedupeKey,
  storedFileDisposition,
  storedFileIdFromPath,
  storedFileMaxBytes,
  storedFilePath,
  verifyStoredFile,
  type StoredFileKindValue,
} from "./stored-file";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const bytesOf = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
const WEBP = (() => {
  const bytes = new Uint8Array(16);
  bytes.set(bytesOf("RIFF"), 0);
  bytes.set(bytesOf("WEBP"), 8);
  return bytes;
})();
const PDF = bytesOf("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");

function padded(prefix: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix.subarray(0, Math.min(prefix.length, size)), 0);
  return bytes;
}

test("the wire kind is a closed vocabulary, not whatever the query string says", () => {
  assert.equal(parseStoredFileKind("headshot"), "HEADSHOT");
  assert.equal(parseStoredFileKind("  Slide-Deck  "), "SLIDE_DECK");
  assert.equal(parseStoredFileKind("HEADSHOT"), "HEADSHOT", "case-insensitive");
  // `__proto__` and `toString` are the reason the lookup is a Map: on a plain
  // object both answer something truthy, which a `?? null` guard would pass
  // straight through to the limits table as a kind that does not exist.
  for (const rejected of ["slide_deck", "slidedeck", "avatar", "", null, undefined, "__proto__", "toString", "constructor"]) {
    assert.equal(parseStoredFileKind(rejected), null, `${String(rejected)} must not resolve to a kind`);
  }
});

test("a content type is compared without its parameters or its casing", () => {
  assert.equal(normalizeMime("image/PNG; charset=binary"), "image/png");
  assert.equal(normalizeMime("  application/pdf  "), "application/pdf");
  assert.equal(normalizeMime(null), "");
  assert.equal(normalizeMime(undefined), "");
});

test("the sniffer identifies exactly the four formats it claims and nothing else", () => {
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(WEBP), "image/webp");
  assert.equal(sniffMime(PDF), "application/pdf");

  // RIFF alone is WAV/AVI too — the WEBP fourcc at offset 8 is the real test.
  const riffWave = new Uint8Array(16);
  riffWave.set(bytesOf("RIFF"), 0);
  riffWave.set(bytesOf("WAVE"), 8);
  assert.equal(sniffMime(riffWave), null);

  assert.equal(sniffMime(bytesOf("<svg xmlns=\"http://www.w3.org/2000/svg\">")), null);
  assert.equal(sniffMime(bytesOf("<!doctype html><script>alert(1)</script>")), null);
  assert.equal(sniffMime(bytesOf("GIF89a")), null);
  // Truncated magic must not match on a prefix of a prefix.
  assert.equal(sniffMime(new Uint8Array([0x89, 0x50])), null);
  assert.equal(sniffMime(bytesOf("RIFF")), null);
  assert.equal(sniffMime(new Uint8Array()), null);
});

test("each kind carries its own cap and its own accepted formats", () => {
  assert.equal(storedFileMaxBytes("HEADSHOT"), 1024 * 1024);
  assert.equal(storedFileMaxBytes("SLIDE_DECK"), 5 * 1024 * 1024);
  assert.deepEqual([...STORED_FILE_LIMITS.HEADSHOT.mimes], ["image/png", "image/jpeg", "image/webp"]);
  assert.deepEqual([...STORED_FILE_LIMITS.SLIDE_DECK.mimes], ["application/pdf"]);
});

test("a file exactly at the cap is accepted and one byte over is refused", () => {
  const cap = storedFileMaxBytes("HEADSHOT");
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "image/png", bytes: padded(PNG, cap) }),
    { ok: true, mime: "image/png" },
  );
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "image/png", bytes: padded(PNG, cap + 1) }),
    { ok: false, reason: "TOO_LARGE" },
  );
  // The caps are per kind, not global: a 2 MiB PDF is fine as a deck and the
  // same size would already have been refused as a headshot.
  assert.deepEqual(
    verifyStoredFile({ kind: "SLIDE_DECK", claimedMime: "application/pdf", bytes: padded(PDF, 2 * 1024 * 1024) }),
    { ok: true, mime: "application/pdf" },
  );
});

test("the bytes decide the type, and a claim that disagrees with them is refused", () => {
  // A PDF wearing a PNG's content type is a mismatch, never a silent store.
  assert.deepEqual(
    verifyStoredFile({ kind: "SLIDE_DECK", claimedMime: "image/png", bytes: PDF }),
    { ok: false, reason: "TYPE_MISMATCH" },
  );
  // HTML claiming to be a PNG never reaches the mismatch branch: it is not an
  // accepted format at all, so the refusal cannot confirm what it really is.
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "image/png", bytes: bytesOf("<script>alert(1)</script>") }),
    { ok: false, reason: "UNSUPPORTED_TYPE" },
  );
  // A real PDF is still not a headshot.
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "application/pdf", bytes: PDF }),
    { ok: false, reason: "UNSUPPORTED_TYPE" },
  );
  // A real PNG is still not a deck.
  assert.deepEqual(
    verifyStoredFile({ kind: "SLIDE_DECK", claimedMime: "image/png", bytes: PNG }),
    { ok: false, reason: "UNSUPPORTED_TYPE" },
  );
  // Parameters and casing on the claim do not create a mismatch.
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "IMAGE/JPEG; charset=binary", bytes: JPEG }),
    { ok: true, mime: "image/jpeg" },
  );
  assert.deepEqual(
    verifyStoredFile({ kind: "HEADSHOT", claimedMime: "image/webp", bytes: WEBP }),
    { ok: true, mime: "image/webp" },
  );
});

test("size is refused before type, so an oversize body is never sniffed", () => {
  // Oversize junk gets TOO_LARGE, not UNSUPPORTED_TYPE: the cheap refusal wins
  // and the response says the thing the client can actually act on.
  assert.deepEqual(
    verifyStoredFile({
      kind: "HEADSHOT",
      claimedMime: "image/png",
      bytes: padded(bytesOf("not an image at all"), storedFileMaxBytes("HEADSHOT") + 1),
    }),
    { ok: false, reason: "TOO_LARGE" },
  );
});

test("the dedupe key is per uploader AND per kind, and normalises the digest", () => {
  assert.deepEqual(
    storedFileDedupeKey({ uploaderUserId: "u1", kind: "HEADSHOT", sha256: "ABCDEF" }),
    { uploaderUserId: "u1", kind: "HEADSHOT", sha256: "abcdef" },
  );
  // Kind is part of the identity because it decides who may read the row back:
  // collapsing two kinds would let the later upload inherit the earlier one's
  // authorization.
  const headshot = storedFileDedupeKey({ uploaderUserId: "u1", kind: "HEADSHOT", sha256: "aa" });
  const deck = storedFileDedupeKey({ uploaderUserId: "u1", kind: "SLIDE_DECK", sha256: "aa" });
  assert.notDeepEqual(headshot, deck);
  // And two uploaders' identical bytes are two rows, so one cannot learn that
  // the other holds the same file.
  assert.notDeepEqual(headshot, storedFileDedupeKey({ uploaderUserId: "u2", kind: "HEADSHOT", sha256: "aa" }));
});

test("a stored-file URL is an app-relative path that cannot point anywhere else", () => {
  assert.equal(storedFilePath("abc123"), "/api/files/abc123");
  assert.ok(isStoredFilePath("/api/files/clx1234567890"));
  assert.equal(storedFileIdFromPath("/api/files/clx1234567890"), "clx1234567890");

  for (const rejected of [
    "//evil.test/api/files/x",           // protocol-relative: a different origin
    "https://evil.test/api/files/x",     // absolute elsewhere
    "/api/files/",                       // no id
    "/api/files/x/../../admin",          // traversal
    "/api/files/x?download=1",           // query
    "/api/files/x#frag",
    "/api/files/x y",
    "/api/filesx",
    "api/files/x",
    " /api/files/x",
    "/API/FILES/x",
    null,
    undefined,
    "",
  ]) {
    assert.equal(isStoredFilePath(rejected as string | null), false, `${String(rejected)} must not be a stored-file path`);
    assert.equal(storedFileIdFromPath(rejected as string | null), null);
  }
});

const headshot = { kind: "HEADSHOT" as StoredFileKindValue, uploaderUserId: "owner", eventId: "e1" };
const deck = { kind: "SLIDE_DECK" as StoredFileKindValue, uploaderUserId: "owner", eventId: "e1" };

test("a headshot is readable by anyone, because that is where it already renders", () => {
  assert.equal(canReadStoredFile(headshot, null), true);
  assert.equal(canReadStoredFile(headshot, { userId: "stranger", role: "SPEAKER", eventId: "e2" }), true);
  assert.equal(canReadStoredFile({ ...headshot, eventId: null }, null), true);
});

test("a slide deck is readable by its owner and by that event's admin, and by nobody else", () => {
  assert.equal(canReadStoredFile(deck, null), false, "anonymous");
  assert.equal(canReadStoredFile(deck, { userId: "owner", role: "SPEAKER", eventId: "e1" }), true, "owner");
  // The owner keeps their own file even from another event's session.
  assert.equal(canReadStoredFile(deck, { userId: "owner", role: "SPEAKER", eventId: "e2" }), true, "owner elsewhere");
  assert.equal(canReadStoredFile(deck, { userId: "boss", role: "ADMIN", eventId: "e1" }), true, "this event's admin");
  // S1: an ADMIN of a different event has no claim on this event's upload.
  assert.equal(canReadStoredFile(deck, { userId: "boss", role: "ADMIN", eventId: "e2" }), false, "other event's admin");
  assert.equal(canReadStoredFile(deck, { userId: "peer", role: "SPEAKER", eventId: "e1" }), false, "another speaker");
  assert.equal(canReadStoredFile(deck, { userId: "judge", role: "EVALUATOR", eventId: "e1" }), false, "an evaluator");
  // A deck whose event is gone has no organizer claim left — only its owner.
  assert.equal(canReadStoredFile({ ...deck, eventId: null }, { userId: "boss", role: "ADMIN", eventId: "e1" }), false);
  assert.equal(canReadStoredFile({ ...deck, eventId: null }, { userId: "owner", role: "SPEAKER", eventId: "e1" }), true);
});

test("only the public kind gets a shared cache, and only the public kind renders inline", () => {
  assert.equal(storedFileCacheControl("HEADSHOT"), "public, max-age=31536000, immutable");
  assert.equal(storedFileCacheControl("SLIDE_DECK"), "private, no-store");
  assert.equal(storedFileDisposition("HEADSHOT"), "inline");
  assert.equal(storedFileDisposition("SLIDE_DECK"), "attachment");
});
