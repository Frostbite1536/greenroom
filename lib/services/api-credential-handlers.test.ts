import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { UserRole } from "@prisma/client";
import type { ApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/http";
import { authorizeV1Request } from "@/lib/api/v1";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  createApiCredentialHandlers,
  type ApiCredentialDb,
  type ApiCredentialTx,
} from "@/lib/services/api-credential-handlers";
import {
  issueApiCredential,
  parseApiCredentialToken,
  MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
} from "@/lib/services/api-credential";

/**
 * RUNTIME tests for the admin credential handlers.
 *
 * These are not source rails. Each one builds the real handlers over a fake
 * client and a fake session, calls them with real `Request` objects, and reads
 * real `Response` statuses and bodies. What the source rails next door assert
 * about the shape of the code, these assert about its behaviour.
 *
 * The fake client is deliberately faithful in the two ways that matter:
 *
 *   - It APPLIES THE PROJECTION. Reads return an object built from the keys in
 *     the handler's own `select`, so the stored secret digest is genuinely
 *     absent from what the handler receives — not merely absent from a fixture
 *     that never had it.
 *   - Its reads and writes share one row array, so a revocation written by the
 *     DELETE handler is visible to a later authentication read. That is what
 *     lets the concurrency test at the bottom drive both halves for real.
 *
 * The fake `requireContext` mirrors `lib/api/context.ts` exactly, and the last
 * test in this file pins that mirroring so the fake cannot drift from the real
 * refusals it stands in for.
 */

const EVENT = "event-1";
const OTHER_EVENT = "event-2";

type StoredRow = {
  id: string;
  eventId: string;
  label: string;
  lookupId: string;
  secretHash: string;
  createdByUserId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  createdBy: { name: string } | null;
};

type Recorded = { op: string; args?: unknown };

/** Build the projection the handler asked for, and nothing else. */
function project(row: StoredRow, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = (row as unknown as Record<string, unknown>)[key];
    else if (key === "createdBy") out[key] = row.createdBy;
  }
  return out;
}

function fakeDb(seed: StoredRow[] = []) {
  const rows: StoredRow[] = [...seed];
  const recorded: Recorded[] = [];
  let nextId = seed.length + 1;

  const tx: ApiCredentialTx = {
    apiCredential: {
      async count(args) {
        recorded.push({ op: "count", args });
        return rows.filter((r) => r.eventId === args.where.eventId && r.revokedAt === null).length;
      },
      async create(args) {
        recorded.push({ op: "create", args });
        const row: StoredRow = {
          id: `credential-${nextId++}`,
          eventId: args.data.eventId,
          label: args.data.label,
          lookupId: args.data.lookupId,
          secretHash: args.data.secretHash,
          createdByUserId: args.data.createdByUserId,
          // Strictly increasing, and valid past ten rows -- string-building the
          // minute field silently produced an Invalid Date at row 10.
          createdAt: new Date(Date.UTC(2026, 4, 14, 9, rows.length)),
          revokedAt: null,
          createdBy: { name: "Ada" },
        };
        rows.push(row);
        return project(row, args.select) as never;
      },
    },
  };

  const db: ApiCredentialDb = {
    apiCredential: {
      async findMany(args) {
        recorded.push({ op: "findMany", args });
        return rows
          .filter((r) => r.eventId === args.where.eventId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, args.take)
          .map((r) => project(r, args.select)) as never;
      },
      async findFirst(args) {
        recorded.push({ op: "findFirst", args });
        const row = rows.find((r) => r.id === args.where.id && r.eventId === args.where.eventId);
        return (row ? project(row, args.select) : null) as never;
      },
      async updateMany(args) {
        recorded.push({ op: "updateMany", args });
        const matched = rows.filter(
          (r) => r.id === args.where.id && r.eventId === args.where.eventId && r.revokedAt === null,
        );
        for (const row of matched) row.revokedAt = args.data.revokedAt;
        return { count: matched.length };
      },
    },
    async $transaction(fn) {
      recorded.push({ op: "$transaction" });
      return fn(tx);
    },
  };

  return { db, rows, recorded };
}

const ADMIN_CTX: ApiContext = {
  userId: "user-1",
  email: "ada@example.test",
  name: "Ada",
  role: "ADMIN",
  eventId: EVENT,
};

/**
 * Mirrors `requireContext` in `lib/api/context.ts`: unauthenticated is 401
 * UNAUTHENTICATED, a role outside the allowed set is 403 FORBIDDEN.
 */
function fakeRequireContext(session: { role: UserRole } | null) {
  return async (roles: UserRole[]): Promise<ApiContext> => {
    if (!session) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (roles && !roles.includes(session.role)) {
      throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
    }
    return { ...ADMIN_CTX, role: session.role };
  };
}

function build(options: {
  session?: { role: UserRole } | null;
  seed?: StoredRow[];
  lockLog?: string[];
} = {}) {
  const { db, rows, recorded } = fakeDb(options.seed);
  const session = options.session === undefined ? { role: "ADMIN" as UserRole } : options.session;
  const issued: ReturnType<typeof issueApiCredential>[] = [];
  const handlers = createApiCredentialHandlers({
    db,
    requireContext: fakeRequireContext(session),
    issue: () => {
      const next = issueApiCredential();
      issued.push(next);
      return next;
    },
    lockIssuance: async (_tx, eventId) => {
      options.lockLog?.push(eventId);
      recorded.push({ op: "lock", args: eventId });
    },
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  });
  return { handlers, rows, recorded, issued };
}

const url = "http://greenroom.test/api/admin/api-keys";
const getReq = () => new Request(url);
const postReq = (body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const deleteReq = (id: string) =>
  new Request(`${url}?id=${encodeURIComponent(id)}`, { method: "DELETE" });

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function seedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  const issued = issueApiCredential();
  return {
    id: "credential-seed",
    eventId: EVENT,
    label: "Seeded key",
    lookupId: issued.lookupId,
    secretHash: issued.secretHash,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    revokedAt: null,
    createdBy: { name: "Ada" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authorization, at runtime, on every verb
// ---------------------------------------------------------------------------

test("an unauthenticated caller gets 401 from every verb, and no query runs", async () => {
  const { handlers, recorded } = build({ session: null });

  for (const [verb, response] of [
    ["GET", await handlers.GET(getReq())],
    ["POST", await handlers.POST(postReq({ label: "Anything" }))],
    ["DELETE", await handlers.DELETE(deleteReq("credential-seed"))],
  ] as const) {
    assert.equal(response.status, 401, `${verb} must refuse an unauthenticated caller`);
    const payload = await body(response);
    assert.equal(payload.ok, false);
    assert.equal((payload.error as Record<string, unknown>).code, "UNAUTHENTICATED");
  }
  // The role check precedes every read and write, so an unauthenticated request
  // touches the database not at all.
  assert.deepEqual(recorded, [], "an unauthenticated request must issue no query");
});

test("a signed-in non-admin gets 403 from every verb, and no query runs", async () => {
  for (const role of ["EVALUATOR", "SPEAKER"] as const) {
    const { handlers, recorded } = build({ session: { role } });

    for (const [verb, response] of [
      ["GET", await handlers.GET(getReq())],
      ["POST", await handlers.POST(postReq({ label: "Anything" }))],
      ["DELETE", await handlers.DELETE(deleteReq("credential-seed"))],
    ] as const) {
      assert.equal(response.status, 403, `${verb} must refuse ${role}`);
      const payload = await body(response);
      assert.equal((payload.error as Record<string, unknown>).code, "FORBIDDEN");
    }
    assert.deepEqual(recorded, [], `a ${role} request must issue no query`);
  }
});

// ---------------------------------------------------------------------------
// The create -> list -> revoke lifecycle, through the handlers
// ---------------------------------------------------------------------------

test("create returns the token exactly once, and the list never returns it again", async () => {
  const { handlers, rows, recorded, issued } = build();

  const created = await handlers.POST(postReq({ label: "Website mirror" }));
  assert.equal(created.status, 201);
  const createdBody = await body(created);
  assert.equal(createdBody.ok, true);
  const data = createdBody.data as Record<string, unknown>;
  const credential = data.credential as Record<string, unknown>;

  // The plaintext is in this response, and it is the value that was minted.
  assert.equal(data.token, issued[0].token);
  const parsed = parseApiCredentialToken(String(data.token));
  assert.ok(parsed, "the issued token must be well formed");

  // What was persisted is the lookup half and the secret's digest.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lookupId, parsed.lookupId);
  assert.equal(rows[0].secretHash, issued[0].secretHash);
  assert.equal(rows[0].eventId, EVENT, "the scope is the session's event");
  assert.equal(rows[0].createdByUserId, "user-1");
  // The row does not hold the plaintext anywhere.
  assert.ok(!JSON.stringify(rows[0]).includes(parsed.secret));

  // The response shows the derived prefix and no secret material.
  assert.equal(credential.tokenPrefix, `grk_${parsed.lookupId}`);
  assert.deepEqual(Object.keys(credential).sort(), [
    "createdAt", "createdBy", "id", "label", "revokedAt", "tokenPrefix",
  ]);

  // The lock is taken before the count, and the count before the insert.
  const ops = recorded.map((entry) => entry.op);
  assert.deepEqual(ops.slice(0, 4), ["$transaction", "lock", "count", "create"]);

  // Listing the same event returns the credential WITHOUT the token, and
  // without the digest -- the fake applied the handler's own projection, so
  // this is the real shape the handler received.
  const listed = await handlers.GET(getReq());
  assert.equal(listed.status, 200);
  const listBody = (await body(listed)).data as Record<string, unknown>;
  const listedCredentials = listBody.credentials as Record<string, unknown>[];
  assert.equal(listedCredentials.length, 1);
  assert.equal(listedCredentials[0].tokenPrefix, `grk_${parsed.lookupId}`);
  const serializedList = JSON.stringify(listBody);
  assert.ok(!serializedList.includes(String(data.token)), "the list must never carry the token");
  assert.ok(!serializedList.includes(parsed.secret), "the list must never carry the secret");
  assert.ok(!serializedList.includes(issued[0].secretHash), "the list must never carry the digest");
  assert.equal(listBody.truncated, false);
  assert.equal(listBody.activeLimit, MAX_ACTIVE_API_CREDENTIALS_PER_EVENT);

  // Every response on this surface is uncacheable.
  for (const response of [created, listed]) {
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  }
});

test("revoke tombstones the row, is idempotent, and never deletes", async () => {
  const seed = seedRow();
  const { handlers, rows } = build({ seed: [seed] });

  const first = await handlers.DELETE(deleteReq(seed.id));
  assert.equal(first.status, 200);
  const firstBody = (await body(first)).data as Record<string, unknown>;
  assert.equal(firstBody.revoked, true);
  assert.equal((firstBody.credential as Record<string, unknown>).revokedAt, "2026-06-01T12:00:00.000Z");

  // The row survives as an audit tombstone.
  assert.equal(rows.length, 1, "revocation must never delete the row");
  assert.deepEqual(rows[0].revokedAt, new Date("2026-06-01T12:00:00.000Z"));

  // Revoking again succeeds and changes nothing: a retry is not an error.
  const second = await handlers.DELETE(deleteReq(seed.id));
  assert.equal(second.status, 200);
  const secondBody = (await body(second)).data as Record<string, unknown>;
  assert.equal(secondBody.revoked, false, "a second revoke reports that it changed nothing");
  assert.deepEqual(rows[0].revokedAt, new Date("2026-06-01T12:00:00.000Z"), "the tombstone is not moved");

  // And the revoked credential still lists, with its state visible.
  const listed = (await body(await handlers.GET(getReq()))).data as Record<string, unknown>;
  const credentials = listed.credentials as Record<string, unknown>[];
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].revokedAt, "2026-06-01T12:00:00.000Z");
});

test("an unknown or cross-event id is the same 404, and writes nothing", async () => {
  const mine = seedRow();
  const theirs = seedRow({ id: "credential-theirs", eventId: OTHER_EVENT, label: "Another event's key" });
  const { handlers, rows } = build({ seed: [mine, theirs] });

  const unknown = await handlers.DELETE(deleteReq("credential-does-not-exist"));
  const crossEvent = await handlers.DELETE(deleteReq(theirs.id));

  for (const [why, response] of [["unknown", unknown], ["cross-event", crossEvent]] as const) {
    assert.equal(response.status, 404, `${why} must be 404`);
    const payload = await body(response);
    assert.equal((payload.error as Record<string, unknown>).code, "API_KEY_NOT_FOUND");
    assert.equal((payload.error as Record<string, unknown>).message, "API key not found.");
  }
  // The other event's credential is untouched: the scope is in the predicate.
  assert.equal(rows.find((r) => r.id === theirs.id)?.revokedAt, null);

  // And it never appears in this event's listing either.
  const listed = (await body(await handlers.GET(getReq()))).data as Record<string, unknown>;
  assert.deepEqual(
    (listed.credentials as Record<string, unknown>[]).map((c) => c.label),
    ["Seeded key"],
  );
});

test("the active bound refuses the eleventh key and revoking one frees a slot", async () => {
  const lockLog: string[] = [];
  const { handlers, rows } = build({ lockLog });

  for (let i = 0; i < MAX_ACTIVE_API_CREDENTIALS_PER_EVENT; i += 1) {
    const response = await handlers.POST(postReq({ label: `Key ${i}` }));
    assert.equal(response.status, 201, `key ${i} must be created`);
  }
  assert.equal(rows.length, MAX_ACTIVE_API_CREDENTIALS_PER_EVENT);

  const overBound = await handlers.POST(postReq({ label: "One too many" }));
  assert.equal(overBound.status, 409);
  const payload = await body(overBound);
  assert.equal((payload.error as Record<string, unknown>).code, "API_KEY_LIMIT_REACHED");
  assert.equal(rows.length, MAX_ACTIVE_API_CREDENTIALS_PER_EVENT, "the refused create must insert nothing");

  // Every attempt, including the refused one, took the event-scoped lock first.
  assert.equal(lockLog.length, MAX_ACTIVE_API_CREDENTIALS_PER_EVENT + 1);
  assert.deepEqual([...new Set(lockLog)], [EVENT]);

  // Revoking frees exactly one slot: the bound counts live credentials, not
  // rows, so tombstones never fill the event up permanently.
  const revoked = await handlers.DELETE(deleteReq(rows[0].id));
  assert.equal(revoked.status, 200);
  const afterRevoke = await handlers.POST(postReq({ label: "Replacement" }));
  assert.equal(afterRevoke.status, 201, "a revoked key must free a slot");
  assert.equal(rows.length, MAX_ACTIVE_API_CREDENTIALS_PER_EVENT + 1, "the tombstone is still stored");
});

test("the label is validated at the boundary and the body is strict", async () => {
  const { handlers, rows } = build();

  for (const [why, payload] of [
    ["empty", { label: "" }],
    ["whitespace only", { label: "   " }],
    ["too long", { label: "x".repeat(81) }],
    ["missing", {}],
    ["an injected event id", { label: "Fine", eventId: OTHER_EVENT }],
  ] as const) {
    const response = await handlers.POST(postReq(payload));
    assert.equal(response.status, 422, `${why} must be refused`);
    assert.equal(
      ((await body(response)).error as Record<string, unknown>).code,
      "VALIDATION_ERROR",
      why,
    );
  }
  assert.equal(rows.length, 0, "no refused create may insert");

  // The strict schema is what stops a caller naming another event: even a
  // well-formed label cannot smuggle a scope alongside it.
  const scoped = await handlers.POST(postReq({ label: "Legitimate" }));
  assert.equal(scoped.status, 201);
  assert.equal(rows[0].eventId, EVENT);
});

test("the listing is bounded and reports truncation honestly rather than refusing", async () => {
  const limit = OPERATOR_QUERY_LIMITS.settingsApiCredentials;
  const seed = Array.from({ length: limit + 5 }, (_, i) =>
    seedRow({
      id: `credential-${i}`,
      label: `Key ${i}`,
      createdAt: new Date(2026, 0, 1, 0, i),
      revokedAt: new Date(2026, 0, 2),
    }),
  );
  const { handlers } = build({ seed });

  const response = await handlers.GET(getReq());
  // Never a 422: an organizer must not lose the panel that revokes their keys.
  assert.equal(response.status, 200);
  const data = (await body(response)).data as Record<string, unknown>;
  assert.equal((data.credentials as unknown[]).length, limit);
  assert.equal(data.truncated, true);
  // Newest first, so the page an organizer sees is the one they just added to.
  assert.equal((data.credentials as Record<string, unknown>[])[0].label, `Key ${limit + 4}`);
});

// ---------------------------------------------------------------------------
// Revocation racing an authentication, driven through both real halves
// ---------------------------------------------------------------------------

test("revoked wins from the moment the revocation commits, not before", async () => {
  const issued = issueApiCredential();
  const seed = seedRow({ id: "credential-raced", lookupId: issued.lookupId, secretHash: issued.secretHash });
  const { handlers, rows } = build({ seed: [seed] });

  /**
   * The authenticating read, modelled as the single statement it is.
   *
   * `gate` separates the moment the statement is ISSUED — when Postgres takes
   * its snapshot and evaluates `revokedAt IS NULL` — from the moment it
   * RESOLVES. Everything about the outcome is decided at issue time; nothing
   * re-checks revocation afterwards, which is exactly the property the store's
   * one-query design gives us.
   */
  function gatedLookup(gate?: Promise<void>) {
    return async (token: string) => {
      const parsed = parseApiCredentialToken(token);
      if (!parsed) return null;
      const row = rows.find((r) => r.lookupId === parsed.lookupId && r.revokedAt === null);
      const snapshot = row ? { eventId: row.eventId, secretHash: row.secretHash } : null;
      if (gate) await gate;
      return snapshot;
    };
  }

  const bearer = new Headers({ authorization: `Bearer ${issued.token}` });
  const refused = {
    ok: false,
    error: { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." },
  };

  // Baseline: while the credential is live, it authenticates its own event.
  assert.deepEqual(await authorizeV1Request(bearer, undefined, gatedLookup()), {
    ok: true,
    scope: { kind: "event", eventId: EVENT },
  });

  // --- Ordering 1: the read is issued BEFORE the revocation commits ---------
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = authorizeV1Request(bearer, undefined, gatedLookup(gate));
  // Let the lookup run far enough to take its snapshot, then commit the
  // revocation through the REAL DELETE handler while the read is in flight.
  await Promise.resolve();
  const revokeResponse = await handlers.DELETE(deleteReq(seed.id));
  assert.equal(revokeResponse.status, 200);
  assert.notEqual(rows[0].revokedAt, null, "the revocation has committed");
  release();

  assert.deepEqual(
    await inFlight,
    { ok: true, scope: { kind: "event", eventId: EVENT } },
    "a read that snapshotted a live row is authorized, even though the revoke committed before it resolved",
  );

  // --- Ordering 2: every read ISSUED after the commit is refused -----------
  assert.deepEqual(
    await authorizeV1Request(bearer, undefined, gatedLookup()),
    refused,
    "revocation wins for every request issued after it commits",
  );
  // Permanently, and idempotently: a second revoke moves nothing.
  const secondRevoke = await handlers.DELETE(deleteReq(seed.id));
  assert.equal(secondRevoke.status, 200);
  assert.deepEqual(await authorizeV1Request(bearer, undefined, gatedLookup()), refused);

  // The whole race is decided by one predicate evaluated inside one statement,
  // so there is no interleaving that yields anything but these two answers.
  assert.equal(rows.length, 1, "the raced credential is still a stored tombstone");
});

// ---------------------------------------------------------------------------
// The fake must not drift from the real thing it stands in for
// ---------------------------------------------------------------------------

test("the fake session mirrors the real requireContext refusals", () => {
  const context = readFileSync(new URL("../../lib/api/context.ts", import.meta.url), "utf8");
  // If the real refusals ever change status or code, the runtime tests above
  // would keep passing against a fake that no longer resembles production.
  assert.match(context, /throw new ApiError\(401, "UNAUTHENTICATED", "Sign in to continue\."\)/);
  assert.match(
    context,
    /throw new ApiError\(403, "FORBIDDEN", "You do not have access to this resource\."\)/,
  );
  assert.match(context, /if \(roles && !roles\.includes\(ctx\.role\)\)/);

  // And the route really is wired to that real implementation.
  const route = readFileSync(new URL("../../app/api/admin/api-keys/route.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ requireContext \} from "@\/lib\/api\/context";/);
  assert.match(route, /createApiCredentialHandlers\(\{/);
  assert.match(route, /requireContext,/);
  assert.match(route, /issue: issueApiCredential,/);
});
