import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTACHMENT_FALLBACK_FILENAME,
  ATTACHMENT_FILENAME_MAX_LENGTH,
  ATTACHMENT_LIMIT_CODE,
  MAX_ATTACHMENTS_PER_ABSTRACT,
  attachmentCountVerdict,
  attachmentFilename,
  formatAttachmentSize,
  normalizeAttachmentFilename,
  viewAttachments,
  type AttachmentSubject,
} from "@/lib/uploads/abstract-attachment";
import {
  STORED_FILE_KINDS,
  STORED_FILE_LIMITS,
  canReadStoredFile,
  parseStoredFileKind,
  storedFileAllowsMime,
  storedFileCacheControl,
  storedFileDisposition,
  storedFileKindParam,
  storedFileMaxBytes,
  verifyStoredFile,
} from "@/lib/uploads/stored-file";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- policy extension -----------------------------------------------------

test("SUPPORTING_DOCUMENT is a stored-file kind with a wire spelling both ways", () => {
  assert.ok(STORED_FILE_KINDS.includes("SUPPORTING_DOCUMENT"));
  assert.equal(parseStoredFileKind("supporting-document"), "SUPPORTING_DOCUMENT");
  // Case-insensitive, exactly like the two kinds that came before it.
  assert.equal(parseStoredFileKind("  SUPPORTING-DOCUMENT "), "SUPPORTING_DOCUMENT");
  assert.equal(storedFileKindParam("SUPPORTING_DOCUMENT"), "supporting-document");
  // The pre-existing spellings did not move.
  assert.equal(storedFileKindParam("HEADSHOT"), "headshot");
  assert.equal(storedFileKindParam("SLIDE_DECK"), "slide-deck");
  // A near miss is still a non-kind, not a truthy prototype member.
  assert.equal(parseStoredFileKind("supporting_document"), null);
  assert.equal(parseStoredFileKind("toString"), null);
  assert.equal(parseStoredFileKind("__proto__"), null);
});

test("the supporting-document cap and type set mirror SLIDE_DECK exactly", () => {
  assert.equal(storedFileMaxBytes("SUPPORTING_DOCUMENT"), 5 * 1024 * 1024);
  assert.equal(storedFileMaxBytes("SUPPORTING_DOCUMENT"), storedFileMaxBytes("SLIDE_DECK"));
  assert.deepEqual(
    [...STORED_FILE_LIMITS.SUPPORTING_DOCUMENT.mimes],
    [...STORED_FILE_LIMITS.SLIDE_DECK.mimes],
  );
  assert.equal(storedFileAllowsMime("SUPPORTING_DOCUMENT", "application/pdf"), true);
  for (const mime of ["image/png", "image/jpeg", "image/webp", "text/html", "application/zip"]) {
    assert.equal(storedFileAllowsMime("SUPPORTING_DOCUMENT", mime), false, mime);
  }
});

test("a supporting document is verified by the same sniff-then-compare order", () => {
  assert.deepEqual(
    verifyStoredFile({ kind: "SUPPORTING_DOCUMENT", claimedMime: "application/pdf", bytes: PDF }),
    { ok: true, mime: "application/pdf" },
  );
  // A PNG is a recognised format but not one this kind accepts.
  assert.deepEqual(
    verifyStoredFile({ kind: "SUPPORTING_DOCUMENT", claimedMime: "image/png", bytes: PNG }),
    { ok: false, reason: "UNSUPPORTED_TYPE" },
  );
  // A real PDF sent as an image is a mismatch, not a silent store.
  assert.deepEqual(
    verifyStoredFile({ kind: "SUPPORTING_DOCUMENT", claimedMime: "image/png", bytes: PDF }),
    { ok: false, reason: "TYPE_MISMATCH" },
  );
  // Unrecognised bytes never become "the claim must be right".
  assert.deepEqual(
    verifyStoredFile({
      kind: "SUPPORTING_DOCUMENT",
      claimedMime: "application/pdf",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    }),
    { ok: false, reason: "UNSUPPORTED_TYPE" },
  );
  // Size is the cheapest refusal and is still checked before anything is read.
  assert.deepEqual(
    verifyStoredFile({
      kind: "SUPPORTING_DOCUMENT",
      claimedMime: "application/pdf",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    }),
    { ok: false, reason: "TOO_LARGE" },
  );
  // Exactly at the cap is allowed; the refusal is strictly above it.
  const atCap = new Uint8Array(5 * 1024 * 1024);
  atCap.set(PDF, 0);
  assert.equal(
    verifyStoredFile({ kind: "SUPPORTING_DOCUMENT", claimedMime: "application/pdf", bytes: atCap }).ok,
    true,
  );
});

test("a supporting document is served privately, never inline, never cached", () => {
  assert.equal(storedFileCacheControl("SUPPORTING_DOCUMENT"), "private, no-store");
  assert.equal(storedFileDisposition("SUPPORTING_DOCUMENT"), "attachment");
  // Same treatment the private kind already had — this is not a new policy.
  assert.equal(
    storedFileCacheControl("SUPPORTING_DOCUMENT"),
    storedFileCacheControl("SLIDE_DECK"),
  );
});

test("the private read rule for the new kind is the SLIDE_DECK rule, unwidened", () => {
  const subject = { kind: "SUPPORTING_DOCUMENT", uploaderUserId: "u-owner", eventId: "e-1" } as const;

  // Anonymous never.
  assert.equal(canReadStoredFile(subject, null), false);
  // The uploader, regardless of role or active event.
  assert.equal(canReadStoredFile(subject, { userId: "u-owner", role: "SPEAKER", eventId: "e-1" }), true);
  assert.equal(canReadStoredFile(subject, { userId: "u-owner", role: "SPEAKER", eventId: "e-2" }), true);
  // An ADMIN of the file's own event.
  assert.equal(canReadStoredFile(subject, { userId: "u-admin", role: "ADMIN", eventId: "e-1" }), true);
  // An ADMIN of a DIFFERENT event: no.
  assert.equal(canReadStoredFile(subject, { userId: "u-admin", role: "ADMIN", eventId: "e-2" }), false);
  // A co-speaker on the same proposal is still not the uploader: no.
  assert.equal(canReadStoredFile(subject, { userId: "u-co", role: "SPEAKER", eventId: "e-1" }), false);
  // A reviewer of the same event: no.
  assert.equal(canReadStoredFile(subject, { userId: "u-rev", role: "EVALUATOR", eventId: "e-1" }), false);
  // An orphaned row (its event deleted) keeps only its owner.
  const orphan = { kind: "SUPPORTING_DOCUMENT", uploaderUserId: "u-owner", eventId: null } as const;
  assert.equal(canReadStoredFile(orphan, { userId: "u-admin", role: "ADMIN", eventId: "e-1" }), false);
  assert.equal(canReadStoredFile(orphan, { userId: "u-owner", role: "SPEAKER", eventId: "e-1" }), true);
});

test("adding the kind did not make anything public", () => {
  for (const kind of STORED_FILE_KINDS) {
    const isPublic = canReadStoredFile({ kind, uploaderUserId: "u", eventId: "e" }, null);
    assert.equal(isPublic, kind === "HEADSHOT", `${kind} public=${isPublic}`);
  }
});

// ---- per-proposal count bound ---------------------------------------------

test("the per-proposal cap is three and refuses at the boundary, not past it", () => {
  assert.equal(MAX_ATTACHMENTS_PER_ABSTRACT, 3);
  for (const count of [0, 1, 2]) {
    assert.deepEqual(attachmentCountVerdict(count), { ok: true }, `count=${count}`);
  }
  for (const count of [3, 4, 99]) {
    const verdict = attachmentCountVerdict(count);
    assert.equal(verdict.ok, false, `count=${count}`);
    assert.equal(verdict.ok === false && verdict.code, ATTACHMENT_LIMIT_CODE);
    assert.match(verdict.ok === false ? verdict.message : "", /up to 3 supporting documents/);
  }
});

// ---- display name ---------------------------------------------------------

test("a file name is normalized to a label and can never read as a path", () => {
  assert.equal(normalizeAttachmentFilename("paper.pdf"), "paper.pdf");
  assert.equal(normalizeAttachmentFilename("/tmp/secret/paper.pdf"), "paper.pdf");
  assert.equal(normalizeAttachmentFilename("C:\\Users\\ada\\paper.pdf"), "paper.pdf");
  assert.equal(normalizeAttachmentFilename("../../etc/passwd"), "passwd");
  // A trailing separator leaves nothing usable.
  assert.equal(normalizeAttachmentFilename("docs/"), null);
  assert.equal(normalizeAttachmentFilename("   "), null);
  assert.equal(normalizeAttachmentFilename(null), null);
  assert.equal(normalizeAttachmentFilename(undefined), null);
  assert.equal(normalizeAttachmentFilename(42 as unknown as string), null);
});

test("control characters cannot survive into a rendered list or a CSV cell", () => {
  assert.equal(normalizeAttachmentFilename("pa\u0000per\u001b[2Jx.pdf"), "paper[2Jx.pdf");
  assert.equal(normalizeAttachmentFilename("line\r\nbreak.pdf"), "linebreak.pdf");
  assert.equal(normalizeAttachmentFilename("\u007f.pdf"), ".pdf");
});

test("an unusable name becomes a neutral one rather than an empty label", () => {
  assert.equal(attachmentFilename("slides.pdf"), "slides.pdf");
  assert.equal(attachmentFilename(""), ATTACHMENT_FALLBACK_FILENAME);
  assert.equal(attachmentFilename(null), ATTACHMENT_FALLBACK_FILENAME);
  assert.equal(attachmentFilename("\u0000"), ATTACHMENT_FALLBACK_FILENAME);
});

test("a stored name is bounded", () => {
  const long = `${"a".repeat(500)}.pdf`;
  const stored = attachmentFilename(long);
  assert.equal(stored.length, ATTACHMENT_FILENAME_MAX_LENGTH);
});

// ---- viewer projection ----------------------------------------------------

const base: AttachmentSubject = {
  id: "att-1",
  filename: "paper.pdf",
  createdAt: "2026-01-01T00:00:00.000Z",
  uploadedByUserId: "u-owner",
  uploadedByName: "Ada",
  storedFileId: "file-1",
  size: 2048,
  mime: "application/pdf",
  eventId: "e-1",
};

test("the list tells each viewer what they can actually open", () => {
  const rows = [base, { ...base, id: "att-2", uploadedByUserId: "u-co", uploadedByName: "Grace", storedFileId: "file-2" }];

  const owner = viewAttachments(rows, { userId: "u-owner", role: "SPEAKER", eventId: "e-1" }, { editable: true });
  assert.deepEqual(owner.map((row) => row.canOpen), [true, false]);
  // Only your own, and only while editable.
  assert.deepEqual(owner.map((row) => row.canRemove), [true, false]);

  const admin = viewAttachments(rows, { userId: "u-admin", role: "ADMIN", eventId: "e-1" }, { editable: true });
  assert.deepEqual(admin.map((row) => row.canOpen), [true, true]);
  // An organizer never removes a speaker's document from a list.
  assert.deepEqual(admin.map((row) => row.canRemove), [false, false]);

  const stranger = viewAttachments(rows, { userId: "u-x", role: "ADMIN", eventId: "e-2" }, { editable: true });
  assert.deepEqual(stranger.map((row) => row.canOpen), [false, false]);

  assert.deepEqual(
    viewAttachments(rows, null, { editable: true }).map((row) => row.canOpen),
    [false, false],
  );
});

test("a non-editable proposal offers no removal, even to the uploader", () => {
  const rows = viewAttachments([base], { userId: "u-owner", role: "SPEAKER", eventId: "e-1" }, { editable: false });
  assert.equal(rows[0].canRemove, false);
  // Reading is unaffected by the edit window: a locked proposal's own documents
  // stay readable to the people who could always read them.
  assert.equal(rows[0].canOpen, true);
});

test("the projection never invents or drops a row", () => {
  const rows = viewAttachments([base], { userId: "u-owner", role: "SPEAKER", eventId: "e-1" }, { editable: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "att-1");
  assert.equal(rows[0].filename, "paper.pdf");
  assert.equal(rows[0].storedFileId, "file-1");
  assert.deepEqual(viewAttachments([], null, { editable: false }), []);
});

test("sizes read the way a person reads them", () => {
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(512), "512 B");
  assert.equal(formatAttachmentSize(2048), "2 KB");
  assert.equal(formatAttachmentSize(1024 * 1024), "1.0 MB");
  assert.equal(formatAttachmentSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatAttachmentSize(Number.NaN), "—");
  assert.equal(formatAttachmentSize(-1), "—");
});
