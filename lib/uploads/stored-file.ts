/**
 * Upload policy, with no database and no request in it.
 *
 * Everything a `StoredFile` decision depends on is decided here so it can be
 * tested without a live table: which kinds exist, what each one costs, what
 * bytes it is actually allowed to be, who may read it back, and what URL it
 * gets stored as. The route layer does IO and nothing else.
 *
 * The load-bearing rule is that **the claimed content type is never believed**.
 * A client says `image/png`; this module reads the first bytes and says what
 * the file is. The serving route then sets `Content-Type` from the stored,
 * server-derived value, so a `.png` full of HTML cannot come back as a script
 * on the app's own origin.
 */

export const STORED_FILE_KINDS = ["HEADSHOT", "SLIDE_DECK"] as const;
export type StoredFileKindValue = (typeof STORED_FILE_KINDS)[number];

/**
 * Wire spelling of a kind: what the upload request's `?kind=` carries.
 *
 * A `Map`, not an object literal. A plain-object lookup keyed by untrusted
 * input answers `Object.prototype` for `__proto__` and a function for
 * `toString`, both of which are truthy — so `?kind=toString` would have got
 * past a `?? null` guard and reached the limits table as a non-kind.
 */
const STORED_FILE_KIND_PARAMS = new Map<string, StoredFileKindValue>([
  ["headshot", "HEADSHOT"],
  ["slide-deck", "SLIDE_DECK"],
]);

/** Accepted case-insensitively; `HEADSHOT` and `headshot` are the same request. */
export function parseStoredFileKind(value: string | null | undefined): StoredFileKindValue | null {
  return STORED_FILE_KIND_PARAMS.get(value?.trim().toLowerCase() ?? "") ?? null;
}

/**
 * Per-kind limits. A headshot is a face on a card and 1 MiB is already
 * generous for one; a deck is the artefact a speaker actually hands over.
 *
 * Known interaction, stated rather than hidden: the 5 MiB deck cap sits ABOVE
 * Vercel's ~4.5 MB request-body ceiling, so on that deployment a deck between
 * roughly 4.3 MiB and 5 MiB is refused by the platform before this code runs.
 * The refusal is still a 413 and the product still never stores an oversize
 * file — it just is not *our* 413, and its body is not the app's envelope.
 * Lowering the cap to 4 MiB would make every refusal ours; that is a product
 * call, not a code one, so the specified cap stands and this note exists.
 */
export const STORED_FILE_LIMITS = {
  HEADSHOT: { maxBytes: 1024 * 1024, mimes: ["image/png", "image/jpeg", "image/webp"] },
  SLIDE_DECK: { maxBytes: 5 * 1024 * 1024, mimes: ["application/pdf"] },
} as const satisfies Record<StoredFileKindValue, { maxBytes: number; mimes: readonly string[] }>;

export function storedFileMaxBytes(kind: StoredFileKindValue): number {
  return STORED_FILE_LIMITS[kind].maxBytes;
}

export function storedFileAllowsMime(kind: StoredFileKindValue, mime: string): boolean {
  return (STORED_FILE_LIMITS[kind].mimes as readonly string[]).includes(mime);
}

/** Strip parameters and case from a `Content-Type`: `image/PNG; x=1` → `image/png`. */
export function normalizeMime(header: string | null | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

type Signature = { mime: string; test: (bytes: Uint8Array) => boolean };

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * The whole sniffer. Four formats, no dependency: adding a library to read
 * eight bytes would be the larger risk.
 *
 * WebP is the one that needs two checks — `RIFF` alone is also WAV and AVI, so
 * the `WEBP` fourcc at offset 8 is what actually identifies it.
 */
const SIGNATURES: readonly Signature[] = [
  { mime: "image/png", test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: "image/webp", test: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  { mime: "application/pdf", test: (b) => ascii(b, 0, "%PDF-") },
];

/** The content type the bytes actually are, or null for anything unrecognised. */
export function sniffMime(bytes: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.mime ?? null;
}

export type StoredFileVerdict =
  | { ok: true; mime: string }
  | { ok: false; reason: "UNSUPPORTED_KIND" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "TOO_LARGE" };

/**
 * The one decision an upload makes about its own bytes.
 *
 * Order matters. Size is checked first because it is the cheapest refusal and
 * the only one an honest client can hit by accident. Then the *sniffed* type
 * must be allowed for this kind, and only then must the claim agree with it —
 * so a PDF renamed `image/png` is a mismatch (422) rather than being quietly
 * stored as a PDF under a headshot's public-read rules.
 */
export function verifyStoredFile(input: {
  kind: StoredFileKindValue;
  claimedMime: string;
  bytes: Uint8Array;
}): StoredFileVerdict {
  const limits = STORED_FILE_LIMITS[input.kind];
  if (!limits) return { ok: false, reason: "UNSUPPORTED_KIND" };
  if (input.bytes.byteLength > limits.maxBytes) return { ok: false, reason: "TOO_LARGE" };

  const actual = sniffMime(input.bytes);
  if (!actual || !storedFileAllowsMime(input.kind, actual)) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  if (normalizeMime(input.claimedMime) !== actual) return { ok: false, reason: "TYPE_MISMATCH" };
  return { ok: true, mime: actual };
}

/**
 * The dedupe identity: one uploader's same bytes, for the same purpose, are
 * one row. Kind is part of the key because it decides who may read the file
 * back — two rows differing only in kind are two different disclosures, and
 * collapsing them would let the second upload inherit the first one's
 * authorization.
 */
export function storedFileDedupeKey(input: {
  uploaderUserId: string;
  kind: StoredFileKindValue;
  sha256: string;
}): { uploaderUserId: string; kind: StoredFileKindValue; sha256: string } {
  return { uploaderUserId: input.uploaderUserId, kind: input.kind, sha256: input.sha256.toLowerCase() };
}

/** Where a stored file is served from. The value written into a profile URL column. */
export const STORED_FILE_PATH_PREFIX = "/api/files/";

export function storedFilePath(id: string): string {
  return `${STORED_FILE_PATH_PREFIX}${id}`;
}

/**
 * Is this an app-relative stored-file path?
 *
 * Deliberately narrow: one leading slash, the exact prefix, and a cuid-shaped
 * id with nothing after it. No scheme, no host, no `..`, no query — so nothing
 * matching this can point off-origin or at another route, which is what lets
 * the public image renderer accept it beside an absolute http(s) URL without
 * widening what it accepts in any other direction (GRA2-07 unchanged).
 */
export function isStoredFilePath(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\/api\/files\/[A-Za-z0-9_-]{1,191}$/.test(value);
}

/** The id inside a stored-file path, or null when it is not one. */
export function storedFileIdFromPath(value: string | null | undefined): string | null {
  return isStoredFilePath(value) ? value!.slice(STORED_FILE_PATH_PREFIX.length) : null;
}

export type StoredFileViewer = { userId: string; role: string; eventId: string } | null;

export type StoredFileSubject = {
  kind: StoredFileKindValue;
  uploaderUserId: string;
  eventId: string | null;
};

/**
 * Who may read the bytes back. This mirrors where each column is already
 * exposed today — the route grants no reach the product did not already have.
 *
 * A HEADSHOT is public because `headshotUrl` renders on the anonymous speaker
 * gallery and the speakers embed. Gating it would break the surfaces it exists
 * for, and it is already a picture its subject chose to publish.
 *
 * A SLIDE_DECK is not public: `slideDeckUrl` appears only in the speaker's own
 * portal, the ADMIN roster route, and the operator-held v1 API. So it is the
 * uploader themselves, or an ADMIN whose active event is the event the file
 * was uploaded under. An upload with no event (`eventId: null`, the row
 * outliving its event) has no organizer claim left — only its owner.
 */
export function canReadStoredFile(subject: StoredFileSubject, viewer: StoredFileViewer): boolean {
  if (subject.kind === "HEADSHOT") return true;
  if (!viewer) return false;
  if (viewer.userId === subject.uploaderUserId) return true;
  return viewer.role === "ADMIN" && subject.eventId !== null && viewer.eventId === subject.eventId;
}

/**
 * A headshot is content-addressed and immutable — the id changes when the
 * bytes do — so it takes the longest cache a year allows. A deck is
 * authorized per request and must never sit in a shared cache where the next
 * reader is a different person.
 */
export function storedFileCacheControl(kind: StoredFileKindValue): string {
  return kind === "HEADSHOT" ? "public, max-age=31536000, immutable" : "private, no-store";
}

/**
 * A PDF is offered as a download rather than rendered in place: it is
 * same-origin by construction here, and an inline viewer is the one surface
 * where an uploaded document gets to run anything at all. Images render.
 */
export function storedFileDisposition(kind: StoredFileKindValue): string {
  return kind === "HEADSHOT" ? "inline" : "attachment";
}
