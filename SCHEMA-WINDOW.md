# Schema window: `ApiCredential` (per-event API credentials)

Branch `feat/api-credentials`, based on `origin/main` @ `ff78b1d`.
Prepared for the admitting track's review. **No database has been touched by
this lane** — the SQL below was produced offline by `prisma migrate diff`
against two schema files, never against a live connection.

## How this SQL was produced

```
git show ff78b1d:prisma/schema.prisma > .schema-window-tmp/base.prisma
npx prisma migrate diff \
  --from-schema-datamodel .schema-window-tmp/base.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Both sides are schema *files*, so this is the delta of the model, not a
comparison against any deployed database. Prisma CLI 6.19.3.

## Blast radius

**Additive only.** The generated script contains one `CREATE TABLE`, two
`CREATE INDEX`, and two `ADD FOREIGN KEY` — all against the new table. There is
no `ALTER TABLE` against any existing table, no column change, no type change,
no enum change, and no data migration. Every existing row and every existing
query keeps working unchanged.

The two edits to existing *models* in `schema.prisma` are the inverse relation
fields `Event.apiCredentials` and `User.apiCredentials`. Those are Prisma-side
metadata that make the foreign keys navigable; they emit no SQL at all, which
is visible in the script below — neither `Event` nor `User` is mentioned except
as a foreign-key target.

Rollback is `DROP TABLE "ApiCredential";` — nothing else references it.

## Model excerpt

```prisma
model ApiCredential {
  id              String    @id @default(cuid())
  eventId         String
  /// Operator-supplied display name. Bounded at the request boundary.
  label           String
  /// Non-secret public identifier: the indexed lookup key, and the shown value.
  lookupId        String    @unique
  /// SHA-256 hex digest of the secret half. Never projected, never logged.
  secretHash      String
  createdByUserId String?
  createdAt       DateTime  @default(now())
  /// Set once, never cleared: revocation is permanent for this credential.
  revokedAt       DateTime?

  event     Event @relation(fields: [eventId], references: [id], onDelete: Cascade)
  createdBy User? @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  @@index([eventId])
}
```

Plus, on the two existing models (no SQL emitted):

```prisma
model Event {
  // ...
  apiCredentials              ApiCredential[]
}

model User {
  // ...
  apiCredentials     ApiCredential[]
}
```

## Design notes the review asked for

**Token format.** `grk_<lookupId>_<secret>`.

- `lookupId` — 8 CSPRNG bytes as 16 lowercase hex characters. **Not a secret.**
  Stored in plaintext, uniquely indexed, and displayed to the organizer as the
  credential's visible name. It is the sole lookup key, which makes
  authentication one indexed point read and never a scan or prefix match over
  an event's credentials.
- `secret` — 32 CSPRNG bytes (256 bits) as 43 base64url characters. Stored
  **only** as `secretHash`, its SHA-256 hex digest. Compared with
  `timingSafeEqual` over the two fixed-width digests.

No index in this table is keyed on anything derived from the secret. The
plaintext token exists exactly once, in the body of the response that creates
it, and is unrecoverable afterwards.

**Delete behaviour, chosen deliberately.**

- `eventId` → `ON DELETE CASCADE`. The credential authorizes reads of exactly
  one event; once that event is gone it authorizes nothing, and leaving live
  secret material pointing at a dead scope is strictly worse than removing it.
  This also matches the prevailing convention for every event-owned row in this
  schema (`Room`, `Track`, `Category`, `ReviewerInvite`, `ImportJob`, …).
- `createdByUserId` → nullable, `ON DELETE SET NULL`. The credential belongs to
  the event, not to whoever pressed the button. Removing an organizer must not
  silently break a working integration, and must not erase the record of what
  they issued. Same reasoning and same convention as `EmailDispatch.sender` and
  `StoredFile.event`.

**Index choices.** `lookupId` is unique because it is the authentication key —
the uniqueness is a correctness requirement, not just a performance one.
`@@index([eventId])` serves the organizer's listing and the active-count check
behind the per-event bound. No index on `revokedAt`: it is only ever read as an
equality predicate alongside an already-unique or already-indexed column.

**Deliberately rejected: `lastUsedAt`.** Every authenticated v1 read is a
`SELECT`. Stamping a usage timestamp would turn the entire read surface into a
writer, adding a row update and its WAL traffic to a path whose whole purpose is
cheap mirroring. Usage telemetry, if it is ever wanted, belongs in an
append-only log rather than in the authenticator's own row.

## Generated SQL — the exact delta

```sql
-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_lookupId_key" ON "ApiCredential"("lookupId");

-- CreateIndex
CREATE INDEX "ApiCredential_eventId_idx" ON "ApiCredential"("eventId");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

## Window notes

- The `CREATE TABLE` takes no lock on an existing table. The two
  `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statements are on the **new,
  empty** table; they take a `SHARE ROW EXCLUSIVE` lock on the referenced
  `Event` and `User` tables for the duration of the statement, which on an empty
  child table is essentially instantaneous but will queue behind any
  long-running transaction already holding a conflicting lock on those tables.
- Nothing in the application reads or writes `ApiCredential` until this table
  exists, and the v1 surface's deployment-wide key path does not touch it at
  all. Old server code against the new schema is therefore safe: it simply never
  queries the new table.
- New server code against the **old** schema is not safe — the credential
  lookup would error — so the table must exist before the application code that
  reads it is deployed.
