# Combined schema window: credentials, attachments, and event decks

Candidate `trackc/combined-ai`, based on `origin/main` at `ff78b1d`, combines
the reviewed `ApiCredential`, proposal-attachment, and per-event slide-deck
models. Neither source lane applied a database change. Track A will apply this
combined model once to a uniquely named disposable database, require an empty
post-apply diff, run the exact-head gates, and drop only that database.

## Blast radius

The change is additive:

- add `SUPPORTING_DOCUMENT` to `StoredFileKind`;
- create `ApiCredential`;
- create `AbstractAttachment`;
- create `EventSpeakerDeck`;
- add indexes and foreign keys only for those new tables.

No existing column is dropped, renamed, retyped, or made non-nullable. Existing
model edits outside the enum are Prisma inverse-relation metadata and emit no
columns. The enum addition is irreversible without recreating the PostgreSQL
enum; that is the only irreversible statement.

## Exact offline model delta

The source lanes generated their SQL from schema files with Prisma CLI 6.19.3.
The combined pre-apply check must regenerate the exact candidate SQL before the
window opens and compare it with this inventory:

```sql
ALTER TYPE "StoredFileKind" ADD VALUE 'SUPPORTING_DOCUMENT';

CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lookupId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AbstractAttachment" (
    "id" TEXT NOT NULL,
    "abstractId" TEXT NOT NULL,
    "storedFileId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbstractAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventSpeakerDeck" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deckUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventSpeakerDeck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiCredential_lookupId_key" ON "ApiCredential"("lookupId");
CREATE INDEX "ApiCredential_eventId_idx" ON "ApiCredential"("eventId");
CREATE INDEX "AbstractAttachment_abstractId_idx" ON "AbstractAttachment"("abstractId");
CREATE INDEX "AbstractAttachment_storedFileId_idx" ON "AbstractAttachment"("storedFileId");
CREATE INDEX "AbstractAttachment_uploadedById_idx" ON "AbstractAttachment"("uploadedById");
CREATE UNIQUE INDEX "AbstractAttachment_abstractId_storedFileId_key" ON "AbstractAttachment"("abstractId", "storedFileId");
CREATE INDEX "EventSpeakerDeck_userId_idx" ON "EventSpeakerDeck"("userId");
CREATE UNIQUE INDEX "EventSpeakerDeck_eventId_userId_key" ON "EventSpeakerDeck"("eventId", "userId");

ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_abstractId_fkey" FOREIGN KEY ("abstractId") REFERENCES "Abstract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbstractAttachment" ADD CONSTRAINT "AbstractAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSpeakerDeck" ADD CONSTRAINT "EventSpeakerDeck_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSpeakerDeck" ADD CONSTRAINT "EventSpeakerDeck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

## Window ordering and rollback

PostgreSQL permits `ALTER TYPE ... ADD VALUE` in a transaction, but the new
value cannot be used until that transaction commits. The schema window performs
no seed or backfill in that transaction. The new tables are empty when their
foreign keys are added, keeping referenced-table locks brief.

Before application deployment, apply the enum and all three tables. Old code is
safe against the new schema because it never queries them; new code is not safe
against the old schema. The three tables can be rolled back with guarded drops.
The enum value cannot be removed without recreating the enum.

## Data and authorization choices

`ApiCredential` stores a public lookup id and a SHA-256 digest of a separate
256-bit secret; the plaintext token is returned only at creation. Credentials
belong to an event and survive creator deletion, but cascade with event deletion.

`AbstractAttachment` is a join because one event-scoped deduplicated stored file
may be linked to more than one proposal. Removing a link does not delete shared
bytes. `EventSpeakerDeck` is event scoped but stores a URL because the existing
field accepts either a private local file path or an absolute external URL. A
local path is accepted only after validating the real file as the current
speaker's `SLIDE_DECK` in the current event.
