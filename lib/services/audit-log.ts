import type { Prisma } from "@prisma/client";

/**
 * The change history: one small writer, one pure diff, one vocabulary.
 *
 * The external audit found that an organizer's profile edit was last-write-wins
 * with nothing recorded, and that the product had no change history at all. This
 * module is the whole write side of the fix, and it is deliberately generic: the
 * four instrumented writers hand it a diff and an identity, and nothing about a
 * speaker profile, a talk, a slot, or a decision is known here.
 *
 * Three rules define it.
 *
 * 1. **An audit row is written inside the transaction that made the change.**
 *    `recordAudit` takes the caller's `tx` and never opens its own, so the
 *    history commits with the change or not at all (INV-AUDIT-001). Recording
 *    after the transaction would produce exactly the two failures an audit trail
 *    exists to rule out: a change with no record when the second write fails, and
 *    a record of a change that rolled back.
 *
 * 2. **Only what changed is stored.** `diffChanges` returns `null` when nothing
 *    did, and `recordAudit` writes nothing for a null diff — so pressing save on
 *    an unchanged form leaves no row, and the log reads as a list of changes
 *    rather than a list of requests. This is also why the column is a diff and
 *    not a pair of row snapshots: a snapshot history is a second copy of the
 *    record, and a second place a bio or an address can be read out of long
 *    after the live row moved on.
 *
 * 3. **The vocabulary lives in TypeScript, not in a PostgreSQL enum.** Instrumenting
 *    the next writer must not require an `ALTER TYPE ... ADD VALUE` — the one
 *    irreversible statement this repository's schema-window contract names
 *    (`SCHEMA-WINDOW.md`). `entityType` and `action` are `String` columns whose
 *    accepted values are the two unions below; this is the only module that
 *    writes the table, so they are still one source of truth.
 *
 * Nothing here reads the table. `/admin/history` reads it through
 * `lib/data/audit-log.ts`, and no route updates or deletes a row: an audit row
 * that can be edited is not an audit row.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What kind of record a row describes.
 *
 * `SCHEDULE_SLOT` is identified by its **session** id, not the `ScheduleSlot`
 * row's own id: unscheduling deletes that row and re-placing the talk creates a
 * new one, so slot ids would scatter one talk's placement history across two
 * identities that nothing joins. The session is the thing an organizer asks the
 * history about ("when did this talk move?").
 */
export type AuditEntityType = "SESSION" | "SPEAKER_PROFILE" | "SCHEDULE_SLOT" | "ABSTRACT_DECISION";

/** What was done. `UPDATE` is the generic field edit; the rest name an act. */
export type AuditAction =
  | "UPDATE"
  | "SCHEDULE"
  | "MOVE"
  | "UNSCHEDULE"
  | "PUBLISH"
  | "UNPUBLISH"
  | "DECIDE";

/** Human labels for the read surface, so the page holds no vocabulary of its own. */
export const AUDIT_ENTITY_LABELS: Record<AuditEntityType, string> = {
  SESSION: "Talk",
  SPEAKER_PROFILE: "Speaker profile",
  SCHEDULE_SLOT: "Schedule placement",
  ABSTRACT_DECISION: "Proposal decision",
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  UPDATE: "Edited",
  SCHEDULE: "Scheduled",
  MOVE: "Moved",
  UNSCHEDULE: "Unscheduled",
  PUBLISH: "Published",
  UNPUBLISH: "Unpublished",
  DECIDE: "Decided",
};

/**
 * The audited field list per surface, kept here beside the vocabulary so adding
 * a field to a history is a one-line change in one file rather than a search
 * through four routes.
 */
export const AUDITED_SPEAKER_PROFILE_FIELDS = [
  "status",
  "bio",
  "company",
  "jobTitle",
  "headshotUrl",
  "slideDeckUrl",
] as const;

export const AUDITED_SESSION_PUBLICATION_FIELDS = ["contentStatus"] as const;

export const AUDITED_SCHEDULE_SLOT_FIELDS = ["roomId", "trackId", "startsAt", "endsAt"] as const;

export const AUDITED_ABSTRACT_DECISION_FIELDS = ["status"] as const;

/* -------------------------------------------------------------------------- */
/* The pure diff                                                               */
/* -------------------------------------------------------------------------- */

/** What a stored diff may hold on either side: JSON scalars only. */
export type AuditValue = string | number | boolean | null;

export type AuditFieldDiff = { from: AuditValue; to: AuditValue };

/** `{field: {from, to}}` over changed fields only. Never stored empty. */
export type AuditChanges = Record<string, AuditFieldDiff>;

/**
 * What a caller may hand in. `Date` is accepted because two of the audited
 * columns are timestamps; it is normalized to an ISO string so the stored diff
 * stays comparable and JSON-safe.
 */
export type AuditableValue = AuditValue | Date | undefined;

export type AuditableRecord = Record<string, AuditableValue>;

/**
 * Normalize one side of a comparison.
 *
 * `undefined` and `null` both become `null`: on the `before` side "there was no
 * row yet" and "the column was empty" are the same statement about the previous
 * value, and a first-time placement should read `from: null` rather than leak the
 * distinction into stored history.
 *
 * A `Date` becomes its UTC ISO string, which is both how the rest of the app
 * serializes instants and what makes two equal instants compare equal here —
 * `Date` objects never do (`new Date(x) === new Date(x)` is false), so comparing
 * them directly would have logged every re-save of an unchanged time.
 */
function normalizeAuditValue(value: AuditableValue): AuditValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Build the `{field: {from, to}}` diff for the named fields, or `null` when
 * nothing changed.
 *
 * Two asymmetries are deliberate, and both come from what the callers actually
 * hold:
 *
 *  - **`undefined` in `after` means "not part of this write"** and the field is
 *    skipped. The organizer's roster editor sends only the fields it changed
 *    (GRA-05), so treating an absent field as a clear would record a bio being
 *    emptied on every status change.
 *  - **`null` in `after` means "explicitly cleared"** and is recorded. That is
 *    also how a removal is expressed: unscheduling passes nulls for the slot's
 *    fields, which reads as `{roomId: {from: "…", to: null}}` — a real change to
 *    a field, in the same shape as every other row, with no special case in the
 *    reader.
 *
 * Pure and total: it touches no database, no clock, and no request. The named
 * fields are the only ones considered, so widening a Prisma projection cannot
 * silently start logging a column nobody reviewed.
 *
 * Both sides are typed loosely, and on purpose: the two records a caller holds
 * are usually different shapes — a nullable stored row against a removal
 * expressed as nulls, or a projection against a partial request — and pinning
 * them to one generic parameter made the *before* row's literal types the
 * contract the *after* row had to satisfy. The field names are guarded instead by
 * the exported per-surface lists and the test that checks each one against
 * `prisma/schema.prisma`.
 */
export function diffChanges(
  before: AuditableRecord,
  after: AuditableRecord,
  fields: readonly string[],
): AuditChanges | null {
  const changes: AuditChanges = {};

  for (const field of fields) {
    if (after[field] === undefined) continue;

    const from = normalizeAuditValue(before[field]);
    const to = normalizeAuditValue(after[field]);
    if (from === to) continue;

    changes[field] = { from, to };
  }

  return Object.keys(changes).length === 0 ? null : changes;
}

/* -------------------------------------------------------------------------- */
/* The write                                                                   */
/* -------------------------------------------------------------------------- */

export type RecordAuditInput = {
  eventId: string;
  /** The signed-in actor. Null only for a change no user account made. */
  actorUserId: string | null;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  /** Straight from `diffChanges`. A null diff writes nothing. */
  changes: AuditChanges | null;
};

/**
 * Append one history row **inside the caller's transaction** (INV-AUDIT-001).
 *
 * It takes `tx`, never `prisma`, so there is no way to call it such that the
 * record and the change it describes can disagree: they commit together or roll
 * back together.
 *
 * A null diff is accepted and writes nothing, rather than being the caller's
 * condition to remember. Every instrumented writer then reads the same way —
 * `recordAudit(tx, { …, changes: diffChanges(…) })` — and a future one cannot
 * forget the guard, because there is none to forget. Returns whether a row was
 * written, which is what the unit tests assert on.
 */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  entry: RecordAuditInput,
): Promise<boolean> {
  if (entry.changes === null) return false;

  await tx.auditLogEntry.create({
    data: {
      eventId: entry.eventId,
      actorUserId: entry.actorUserId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      changes: entry.changes,
    },
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Reading a stored diff back                                                  */
/* -------------------------------------------------------------------------- */

/** One rendered field change, ready for a table row. */
export type AuditChangeSummary = { field: string; from: string; to: string };

/** How much of a long value the history table prints before eliding it. */
export const AUDIT_VALUE_DISPLAY_LIMIT = 120;

/** The em dash the table shows for an absent value, so a cell is never blank. */
export const AUDIT_EMPTY_DISPLAY = "—";

/**
 * Render one stored value for display.
 *
 * A bio is up to a thousand characters and two of them in one row would push the
 * timestamp off the screen, so long text is cut at `AUDIT_VALUE_DISPLAY_LIMIT`
 * and marked with an ellipsis rather than silently truncated — the reader can see
 * that there is more. Newlines collapse for the same reason: this is a table cell.
 */
export function formatAuditValue(value: AuditValue, limit = AUDIT_VALUE_DISPLAY_LIMIT): string {
  if (value === null) return AUDIT_EMPTY_DISPLAY;
  if (typeof value === "boolean") return value ? "Yes" : "No";

  const text = String(value).replace(/\s+/g, " ").trim();
  if (text === "") return AUDIT_EMPTY_DISPLAY;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * A column name as a reader's label: `jobTitle` -> "Job title".
 *
 * Derived rather than tabulated on purpose. A hand-written label map would have
 * to be extended in lockstep with every audited field list, and the failure mode
 * is a blank column heading in the one table that exists to be read — whereas the
 * derivation is wrong at worst in its capitalization.
 */
export function formatAuditFieldName(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (spaced === "") return field;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Narrow the loosely-typed `Json` column back to a diff.
 *
 * The column is `Json`, so a row written by an older shape — or by hand — is not
 * guaranteed to match `AuditChanges`. Unrecognized entries are dropped rather
 * than thrown on: one malformed row must not take out the whole history page,
 * which is the surface an auditor reaches for precisely when something is wrong.
 */
export function parseAuditChanges(value: unknown): AuditChanges {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};

  const changes: AuditChanges = {};
  for (const [field, diff] of Object.entries(value as Record<string, unknown>)) {
    if (diff === null || typeof diff !== "object" || Array.isArray(diff)) continue;
    const { from, to } = diff as { from?: unknown; to?: unknown };
    changes[field] = { from: coerceAuditValue(from), to: coerceAuditValue(to) };
  }
  return changes;
}

function coerceAuditValue(value: unknown): AuditValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

/**
 * The stored diff as display rows, in a stable order.
 *
 * Sorted by field name because JSON key order is an artifact of how the diff was
 * built, and a history whose columns reorder between two rows of the same kind
 * reads as if different things changed.
 */
export function summarizeAuditChanges(
  changes: AuditChanges,
  limit = AUDIT_VALUE_DISPLAY_LIMIT,
): AuditChangeSummary[] {
  return Object.keys(changes)
    .sort()
    .map((field) => ({
      field,
      from: formatAuditValue(changes[field]!.from, limit),
      to: formatAuditValue(changes[field]!.to, limit),
    }));
}
