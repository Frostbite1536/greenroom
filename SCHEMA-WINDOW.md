# Schema window request — proposal attachments + per-event slide decks

Branch `feat/proposal-attachments`, base `ff78b1d`.

**No database was touched by this lane.** No `prisma db push`, no seed, no
connection to any Postgres. The schema change is submitted as model text plus
the generated SQL below, for the admitting track to batch with the other lane's
`ApiCredential` table.

Everything here is additive: one `ALTER TYPE ... ADD VALUE`, two `CREATE TABLE`,
their indexes and foreign keys. **No column is dropped, renamed, retyped, or
made non-nullable, and no existing table is altered at all.**

---

## 1. Model excerpt

### 1a. Enum value addition (M4 precedent)

```prisma
enum StoredFileKind {
  HEADSHOT
  SLIDE_DECK
  /// A speaker's supporting document on one of their own proposals. Private
  /// under exactly the SLIDE_DECK rule: the uploader, or an ADMIN whose active
  /// event is the event the file was uploaded under. Added as an enum VALUE so
  /// the change stays additive (M4 precedent) — no column is modified.
  SUPPORTING_DOCUMENT
}
```

### 1b. `AbstractAttachment` (Feature 1)

```prisma
model AbstractAttachment {
  id           String   @id @default(cuid())
  abstractId   String
  storedFileId String
  /// Who attached it. The only person who may remove it, and — with the event's
  /// admins — the only person who may read the bytes back.
  uploadedById String
  /// The speaker's own file name, for display. Never a path, never trusted as one.
  filename     String
  createdAt    DateTime @default(now())

  abstract   Abstract   @relation(fields: [abstractId], references: [id], onDelete: Cascade)
  storedFile StoredFile @relation(fields: [storedFileId], references: [id], onDelete: Cascade)
  uploadedBy User       @relation(fields: [uploadedById], references: [id], onDelete: Cascade)

  @@unique([abstractId, storedFileId])
  @@index([abstractId])
  @@index([storedFileId])
  @@index([uploadedById])
}
```

### 1c. `EventSpeakerDeck` (Feature 2)

```prisma
model EventSpeakerDeck {
  id        String   @id @default(cuid())
  eventId   String
  userId    String
  /// Same accepted shapes as `SpeakerProfile.slideDeckUrl`: an absolute URL, or
  /// this app's own `/api/files/<id>` path. Validated by `nullableProfileUrl`.
  deckUrl   String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  event Event @relation(fields: [eventId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([eventId, userId])
  @@index([userId])
}
```

### 1d. Inverse relation metadata on existing models

Prisma-side only. These generate **no DDL** — confirmed by the delta in §2,
which alters no existing table.

```prisma
model Event    { …  speakerDecks        EventSpeakerDeck[] }
model User     { …  abstractAttachments AbstractAttachment[]
                    eventSpeakerDecks   EventSpeakerDeck[] }
model Abstract { …  attachments         AbstractAttachment[] }
model StoredFile {  attachments         AbstractAttachment[] }
```

---

## 2. Exact SQL delta

Generated verbatim by:

```
git show ff78b1d:prisma/schema.prisma > .tmp-schema/base.prisma
npx prisma migrate diff \
  --from-schema-datamodel .tmp-schema/base.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

```sql
-- AlterEnum
ALTER TYPE "StoredFileKind" ADD VALUE 'SUPPORTING_DOCUMENT';

-- CreateTable
CREATE TABLE "AbstractAttachment" (
    "id" TEXT NOT NULL,
    "abstractId" TEXT NOT NULL,
    "storedFileId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbstractAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSpeakerDeck" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deckUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSpeakerDeck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbstractAttachment_abstractId_idx" ON "AbstractAttachment"("abstractId");

-- CreateIndex
CREATE INDEX "AbstractAttachment_storedFileId_idx" ON "AbstractAttachment"("storedFileId");

-- CreateIndex
CREATE INDEX "AbstractAttachment_uploadedById_idx" ON "AbstractAttachment"("uploadedById");

-- CreateIndex
CREATE UNIQUE INDEX "AbstractAttachment_abstractId_storedFileId_key" ON "AbstractAttachment"("abstractId", "storedFileId");

-- CreateIndex
CREATE INDEX "EventSpeakerDeck_userId_idx" ON "EventSpeakerDeck"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventSpeakerDeck_eventId_userId_key" ON "EventSpeakerDeck"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_abstractId_fkey" FOREIGN KEY ("abstractId") REFERENCES "Abstract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSpeakerDeck" ADD CONSTRAINT "EventSpeakerDeck_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSpeakerDeck" ADD CONSTRAINT "EventSpeakerDeck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

---

## 3. Operator notes for the batched window

**The one ordering constraint: `ALTER TYPE … ADD VALUE`.** PostgreSQL 12+ will
accept it inside a transaction block, but the new label **cannot be referenced
by any statement in that same transaction**. Nothing in this delta references
`'SUPPORTING_DOCUMENT'` — the two `CREATE TABLE`s do not — so the whole script
is safe to run as one transaction. What is *not* safe is running the delta and
then, in the same transaction, a seed or backfill that writes a
`SUPPORTING_DOCUMENT` row. If the window batches any such write, put the
`ALTER TYPE` in its own committed statement first.

`ALTER TYPE … ADD VALUE` is also not reversible in PostgreSQL: there is no
`DROP VALUE`. Rolling this back means recreating the type. That is the one
irreversible line in the script, and it is why it is submitted for review rather
than pushed.

**No conflict with the `ApiCredential` lane.** This delta touches
`StoredFileKind`, `AbstractAttachment`, and `EventSpeakerDeck` only. It creates
no table, index, or constraint name beginning `ApiCredential`, and it alters no
table that lane creates.

**Statement locks are brief.** Both `CREATE TABLE`s are on new relations. The
three `ADD CONSTRAINT … FOREIGN KEY` statements take a `SHARE ROW EXCLUSIVE` on
the *referenced* tables (`Abstract`, `StoredFile`, `User`, `Event`) for the
duration of the constraint's validation — but the referencing tables are empty
at creation, so validation is trivial.

**Rollback for the two tables** (the enum value cannot be rolled back, see
above):

```sql
DROP TABLE IF EXISTS "AbstractAttachment";
DROP TABLE IF EXISTS "EventSpeakerDeck";
```

---

## 4. Design justifications

### Why a join table instead of `StoredFile.abstractId`

`StoredFile` is deduplicated on `@@unique([uploaderUserId, kind, sha256])`, and
for every private kind the `sha256` is an event-scoped fingerprint
(`lib/uploads/stored-file-dedupe.ts`). So a speaker who attaches the **same PDF
to two of their proposals in one event** gets back **one** `StoredFile` row —
`POST /api/files` returns the existing id with `deduped: true` rather than
inserting. A single nullable `abstractId` column on that row could only ever
name one of the two proposals; the second attach would silently succeed while
pointing the file at the first proposal, or would have to defeat dedupe.

The join row also happens to be the right thing to count and the right thing to
delete: the "max 3 per proposal" cap counts links, and "remove this attachment"
removes a link without destroying bytes that another link may still need.

### Why `EventSpeakerDeck.deckUrl` is a string, not a `storedFileId` FK

The product's deck field has always accepted **either** an uploaded
`/api/files/<id>` path **or** a pasted absolute link — that either/or is the
documented behaviour of the portal's upload field, and one zod schema
(`nullableProfileUrl` in `types/api.ts`) validates both shapes into one column.
An FK to `StoredFile` cannot represent the pasted link, so it would either
remove that capability or require two columns to express one value. A single
column with the same validator as the global column it falls back to keeps the
two values comparable and the resolution rule trivial.

### Delete behaviour, stated deliberately

| Event | Effect |
| --- | --- |
| Proposal deleted | `AbstractAttachment` rows cascade away. Bytes remain in `StoredFile`. |
| `StoredFile` deleted | Its `AbstractAttachment` rows cascade away. |
| Attaching user deleted | Their `AbstractAttachment` rows cascade away (matches `StoredFile.uploader`). |
| Speaker removes an attachment | **Only the link row is deleted.** The bytes stay. |
| Event deleted | `EventSpeakerDeck` rows cascade away; the global `SpeakerProfile.slideDeckUrl` is untouched and becomes the only value again. |
| User deleted | Their `EventSpeakerDeck` rows cascade away. |

Leaving the bytes behind on a remove is the existing product behaviour, not a
new gap: clearing `slideDeckUrl` in the portal has never deleted the uploaded
deck either, because the row is still the dedupe target for that uploader's next
identical upload. An orphan-byte reaper is a separate, named follow-up.
