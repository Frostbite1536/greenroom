import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authorizeV1EventScope,
  authorizeV1Request,
  v1EventWhere,
  type V1AuthScope,
  type V1CredentialLookup,
} from "@/lib/api/v1";
import {
  apiCredentialDigestsMatch,
  apiCredentialSecretMatches,
  hashApiCredentialSecret,
  issueApiCredential,
  parseApiCredentialToken,
} from "@/lib/services/api-credential";
import {
  API_CREDENTIAL_LOOKUP_LENGTH,
  API_CREDENTIAL_SCHEME,
  API_CREDENTIAL_SECRET_LENGTH,
  API_CREDENTIAL_TOKEN_LENGTH,
  MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
  apiCredentialDisplayPrefix,
} from "@/lib/services/api-credential-contract";

/**
 * Per-event API credentials: the token, the verification, and the exact
 * authorization truth table (docs/ROADMAP.md, "Scoped credentials").
 *
 * NO REAL CREDENTIAL APPEARS IN THIS FILE. Every token used here is either
 * minted at runtime by `issueApiCredential` and discarded, or assembled from
 * the obviously-fake constants below — all zeroes and all `A`s, which no
 * CSPRNG-issued key will ever be.
 */

/** Obviously-fake, clearly-marked test material. Never a real credential. */
const FAKE_LOOKUP = "0".repeat(API_CREDENTIAL_LOOKUP_LENGTH);
const FAKE_SECRET = "A".repeat(API_CREDENTIAL_SECRET_LENGTH);
const FAKE_TOKEN = `${API_CREDENTIAL_SCHEME}${FAKE_LOOKUP}_${FAKE_SECRET}`;

const UNAUTHORIZED = {
  ok: false,
  error: { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." },
} as const;

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

/** A lookup that resolves nothing, and counts how often it was consulted. */
function countingLookup(result: Awaited<ReturnType<V1CredentialLookup>> = null) {
  const calls: string[] = [];
  const lookup: V1CredentialLookup = async (token) => {
    calls.push(token);
    return result;
  };
  return { lookup, calls };
}

// ---------------------------------------------------------------------------
// The token: entropy, shape, and what is stored
// ---------------------------------------------------------------------------

test("an issued token is CSPRNG material in two halves, and only the secret's digest is stored", () => {
  const issued = issueApiCredential();

  assert.equal(issued.token.length, API_CREDENTIAL_TOKEN_LENGTH);
  assert.ok(issued.token.startsWith(API_CREDENTIAL_SCHEME));

  const parsed = parseApiCredentialToken(issued.token);
  assert.ok(parsed, "a freshly issued token must parse");
  assert.equal(parsed.lookupId, issued.lookupId);
  assert.match(parsed.lookupId, /^[0-9a-f]+$/);
  assert.equal(parsed.lookupId.length, API_CREDENTIAL_LOOKUP_LENGTH);
  assert.equal(parsed.secret.length, API_CREDENTIAL_SECRET_LENGTH);
  assert.match(parsed.secret, /^[A-Za-z0-9_-]+$/);

  // 32 raw bytes is 256 bits of entropy behind the secret half.
  assert.equal(Buffer.from(parsed.secret, "base64url").length, 32);
  // 8 raw bytes behind the non-secret lookup half.
  assert.equal(Buffer.from(parsed.lookupId, "hex").length, 8);

  // What is persisted is the digest of the SECRET half alone — not of the
  // whole token, and not of the lookup id. No index is keyed on secret material.
  assert.equal(issued.secretHash, createHash("sha256").update(parsed.secret, "utf8").digest("hex"));
  assert.equal(issued.secretHash.length, 64);
  assert.notEqual(issued.secretHash, createHash("sha256").update(issued.token, "utf8").digest("hex"));

  // The stored digest cannot be turned back into anything that authenticates.
  assert.ok(!issued.secretHash.includes(parsed.secret));
  assert.ok(!issued.token.includes(issued.secretHash));
});

test("issued tokens do not repeat: entropy proof over many draws", () => {
  const draws = 2_000;
  const tokens = new Set<string>();
  const lookups = new Set<string>();
  const digests = new Set<string>();
  for (let i = 0; i < draws; i += 1) {
    const issued = issueApiCredential();
    tokens.add(issued.token);
    lookups.add(issued.lookupId);
    digests.add(issued.secretHash);
  }
  // A seeded, counter-based, or time-based generator collides here immediately.
  assert.equal(tokens.size, draws, "two issued tokens were identical");
  assert.equal(lookups.size, draws, "two issued lookup ids collided");
  assert.equal(digests.size, draws, "two issued secrets collided");
});

test("the display prefix is the whole non-secret half and never carries the secret", () => {
  const issued = issueApiCredential();
  const parsed = parseApiCredentialToken(issued.token);
  assert.ok(parsed);
  const shown = apiCredentialDisplayPrefix(issued.lookupId);
  assert.equal(shown, `${API_CREDENTIAL_SCHEME}${issued.lookupId}`);
  assert.ok(issued.token.startsWith(shown), "the shown value must be a true prefix of the token");
  assert.ok(!shown.includes(parsed.secret));
  // Everything the list shows is strictly shorter than the token itself.
  assert.ok(shown.length < issued.token.length);
});

// ---------------------------------------------------------------------------
// Parsing: positional, because base64url contains the separator
// ---------------------------------------------------------------------------

test("a token whose secret contains the separator still parses at the right boundary", () => {
  // base64url's alphabet includes `_`, so a real secret can contain one. This
  // is the case a naive `token.split(\"_\")` gets wrong.
  const trickySecret = `_${"B".repeat(API_CREDENTIAL_SECRET_LENGTH - 3)}_x`;
  assert.equal(trickySecret.length, API_CREDENTIAL_SECRET_LENGTH);
  const parsed = parseApiCredentialToken(`${API_CREDENTIAL_SCHEME}${FAKE_LOOKUP}_${trickySecret}`);
  assert.ok(parsed, "a secret containing the separator must still parse");
  assert.equal(parsed.lookupId, FAKE_LOOKUP);
  assert.equal(parsed.secret, trickySecret);
});

test("parsing refuses anything not shaped like an issued token", () => {
  for (const [why, value] of [
    ["empty", ""],
    ["no scheme", `${FAKE_LOOKUP}_${FAKE_SECRET}`],
    ["wrong scheme", `xyz_${FAKE_LOOKUP}_${FAKE_SECRET}`],
    ["too short", `${API_CREDENTIAL_SCHEME}${FAKE_LOOKUP}_${FAKE_SECRET.slice(1)}`],
    ["too long", `${FAKE_TOKEN}A`],
    ["separator missing", `${API_CREDENTIAL_SCHEME}${FAKE_LOOKUP}X${FAKE_SECRET}`],
    ["lookup not hex", `${API_CREDENTIAL_SCHEME}${"z".repeat(API_CREDENTIAL_LOOKUP_LENGTH)}_${FAKE_SECRET}`],
    ["secret not base64url", `${API_CREDENTIAL_SCHEME}${FAKE_LOOKUP}_${"!".repeat(API_CREDENTIAL_SECRET_LENGTH)}`],
    // A deployment-wide key is a free-form operator string; it must never be
    // mistaken for a per-event credential.
    ["a global-style key", "an-operator-chosen-deployment-wide-value"],
  ] as const) {
    assert.equal(parseApiCredentialToken(value), null, `${why} must not parse`);
  }
});

// ---------------------------------------------------------------------------
// Verification: fixed-width, constant-time, no early exit
// ---------------------------------------------------------------------------

test("secret verification compares fixed-size digests and rejects everything else", () => {
  const issued = issueApiCredential();
  const parsed = parseApiCredentialToken(issued.token);
  assert.ok(parsed);

  assert.equal(apiCredentialSecretMatches(issued.secretHash, parsed.secret), true);
  assert.equal(apiCredentialSecretMatches(issued.secretHash, FAKE_SECRET), false);
  // A secret differing only in its last character must still fail: the
  // comparison is over digests, so a near miss is not a near miss at all.
  const nearMiss = `${parsed.secret.slice(0, -1)}${parsed.secret.endsWith("A") ? "B" : "A"}`;
  assert.equal(apiCredentialSecretMatches(issued.secretHash, nearMiss), false);

  // Digest equality itself.
  const digest = hashApiCredentialSecret(parsed.secret);
  assert.equal(apiCredentialDigestsMatch(digest, digest), true);
  assert.equal(apiCredentialDigestsMatch(digest, hashApiCredentialSecret(FAKE_SECRET)), false);
  // Anything that is not a 64-character digest is not credential material and
  // is refused without reaching timingSafeEqual, which throws on ragged input.
  assert.equal(apiCredentialDigestsMatch(digest, ""), false);
  assert.equal(apiCredentialDigestsMatch(digest, digest.slice(0, 63)), false);
  assert.equal(apiCredentialDigestsMatch("", digest), false);
  assert.doesNotThrow(() => apiCredentialDigestsMatch(digest, "short"));
});

// ---------------------------------------------------------------------------
// The authorization truth table
// ---------------------------------------------------------------------------

test("503 only when nothing is presented AND nothing is configured", async () => {
  const { lookup, calls } = countingLookup();

  // no global, no credential -> the surface reports itself unconfigured.
  const unconfigured = await authorizeV1Request(new Headers(), undefined, lookup);
  assert.equal(unconfigured.ok, false);
  if (!unconfigured.ok) {
    assert.equal(unconfigured.error.status, 503);
    assert.equal(unconfigured.error.code, "API_KEY_NOT_CONFIGURED");
  }
  // Fail-closed costs no lookup: nothing was presented, so nothing is resolved.
  assert.deepEqual(calls, [], "the unconfigured case must not consult the credential store");

  // global configured, nothing presented -> a plain refusal, not 503.
  assert.deepEqual(
    await authorizeV1Request(new Headers(), "a-configured-deployment-wide-value", lookup),
    UNAUTHORIZED,
  );

  // nothing configured, something presented -> resolved, then refused. NOT 503:
  // per-event credentials must work on a deployment with no global key.
  assert.deepEqual(await authorizeV1Request(bearer(FAKE_TOKEN), undefined, lookup), UNAUTHORIZED);
  assert.deepEqual(calls, [FAKE_TOKEN], "a presented credential must be resolved even with no global key");
});

test("the deployment-wide key is accepted first, unchanged, and never reaches the credential store", async () => {
  const globalKey = "a-configured-deployment-wide-value";
  const { lookup, calls } = countingLookup();

  assert.deepEqual(await authorizeV1Request(bearer(globalKey), globalKey, lookup), {
    ok: true,
    scope: { kind: "global" },
  });
  assert.deepEqual(
    await authorizeV1Request(new Headers({ "x-api-key": globalKey }), globalKey, lookup),
    { ok: true, scope: { kind: "global" } },
  );
  assert.deepEqual(calls, [], "a matching deployment-wide key must cost no credential lookup");

  // A wrong value that cannot be a per-event token is refused without a lookup.
  assert.deepEqual(await authorizeV1Request(bearer("not-the-configured-value"), globalKey, lookup), UNAUTHORIZED);
  assert.deepEqual(calls, [], "an unparseable value must not cost a database round trip");
});

test("malformed Authorization still loses to nothing, before any credential parsing", async () => {
  const globalKey = "a-configured-deployment-wide-value";
  const issued = issueApiCredential();
  const { lookup, calls } = countingLookup({ eventId: "event-1", secretHash: issued.secretHash });

  // Header precedence is decided first and is unchanged: a malformed
  // Authorization header is a failure that a valid X-API-Key cannot rescue —
  // and that holds for a per-event credential exactly as it does for the
  // deployment-wide one.
  assert.deepEqual(
    await authorizeV1Request(
      new Headers({ authorization: "Basic not-a-bearer-value", "x-api-key": issued.token }),
      globalKey,
      lookup,
    ),
    UNAUTHORIZED,
  );
  assert.deepEqual(
    await authorizeV1Request(
      new Headers({ authorization: "Basic not-a-bearer-value", "x-api-key": globalKey }),
      globalKey,
      lookup,
    ),
    UNAUTHORIZED,
  );
  assert.deepEqual(calls, [], "precedence must be settled before anything is resolved");

  // The same credential in the header that IS read is accepted, which is what
  // makes the two assertions above about precedence rather than the token.
  assert.deepEqual(
    await authorizeV1Request(new Headers({ "x-api-key": issued.token }), globalKey, lookup),
    { ok: true, scope: { kind: "event", eventId: "event-1" } },
  );
});

test("a live per-event credential authorizes its own event, with or without a global key", async () => {
  const issued = issueApiCredential();
  const stored = { eventId: "event-1", secretHash: issued.secretHash };

  for (const globalKey of [undefined, "a-configured-deployment-wide-value"]) {
    const { lookup } = countingLookup(stored);
    assert.deepEqual(await authorizeV1Request(bearer(issued.token), globalKey, lookup), {
      ok: true,
      scope: { kind: "event", eventId: "event-1" },
    });
  }
});

test("unknown, revoked, and wrong-secret credentials are one indistinguishable refusal", async () => {
  const issued = issueApiCredential();
  const other = issueApiCredential();

  // Unknown lookup id: the store finds nothing.
  const unknown = await authorizeV1Request(bearer(issued.token), undefined, countingLookup(null).lookup);

  // Revoked: the store's own predicate excludes it, so it finds nothing either.
  // Revocation is therefore not a separate code path — it is the same one.
  const revoked = await authorizeV1Request(bearer(issued.token), undefined, countingLookup(null).lookup);

  // Right lookup id, wrong secret: the row comes back and the digest comparison
  // is what refuses. This is the assertion that proves the lookup alone does
  // not authenticate.
  const wrongSecret = await authorizeV1Request(
    bearer(issued.token),
    undefined,
    countingLookup({ eventId: "event-1", secretHash: other.secretHash }).lookup,
  );

  for (const [why, outcome] of [
    ["unknown", unknown],
    ["revoked", revoked],
    ["wrong secret", wrongSecret],
  ] as const) {
    assert.deepEqual(outcome, UNAUTHORIZED, `${why} must be the same refusal`);
  }
});

// ---------------------------------------------------------------------------
// Event scope: the credential gates resolution, it does not filter afterwards
// ---------------------------------------------------------------------------

test("a per-event credential constrains the event query itself", () => {
  const globalScope: V1AuthScope = { kind: "global" };
  const eventScope: V1AuthScope = { kind: "event", eventId: "event-1" };

  // A deployment-wide key resolves the selector across every event.
  assert.deepEqual(v1EventWhere(globalScope, "forward-2026"), {
    OR: [{ id: "forward-2026" }, { slug: "forward-2026" }],
  });

  // A per-event credential resolves it only inside its own event. Another
  // event's row cannot satisfy this predicate, so it is never read — the
  // refusal comes from the absence of a row, not from inspecting one.
  assert.deepEqual(v1EventWhere(eventScope, "somebody-elses-event"), {
    AND: [
      { OR: [{ id: "somebody-elses-event" }, { slug: "somebody-elses-event" }] },
      { id: "event-1" },
    ],
  });
});

test("cross-event and unknown selectors are 401 for a per-event credential, 404 only for a global key", () => {
  const globalScope: V1AuthScope = { kind: "global" };
  const eventScope: V1AuthScope = { kind: "event", eventId: "event-1" };
  const own = { id: "event-1", name: "Forward", slug: "forward-2026", timezone: "UTC" };
  const other = { id: "event-2", name: "Other", slug: "other-2026", timezone: "UTC" };

  assert.deepEqual(authorizeV1EventScope(globalScope, own), { ok: true, event: own });
  assert.deepEqual(authorizeV1EventScope(eventScope, own), { ok: true, event: own });

  // A global key that names nothing gets the honest 404.
  const missingForGlobal = authorizeV1EventScope(globalScope, null);
  assert.equal(missingForGlobal.ok, false);
  if (!missingForGlobal.ok) {
    assert.equal(missingForGlobal.error.status, 404);
    assert.equal(missingForGlobal.error.code, "EVENT_NOT_FOUND");
  }

  // A per-event credential gets 401 for a selector that resolved to nothing —
  // which, given the scoped predicate, covers BOTH "no such event" and
  // "somebody else's event". The two are indistinguishable to the caller, so a
  // key cannot be used to discover which events this deployment hosts.
  assert.deepEqual(authorizeV1EventScope(eventScope, null), UNAUTHORIZED);

  // Defence in depth: even handed another event's row directly — which the
  // scoped `where` cannot produce — the refusal is the same 401, never a 200.
  assert.deepEqual(authorizeV1EventScope(eventScope, other), UNAUTHORIZED);
});

// ---------------------------------------------------------------------------
// Racing a revocation
// ---------------------------------------------------------------------------

test("a request racing a revocation resolves deterministically: revoked wins once it commits", async () => {
  const issued = issueApiCredential();

  /**
   * Stands in for the row and the single authenticating statement. `read()`
   * evaluates `revokedAt IS NULL` at the moment the statement runs, exactly as
   * the real `findFirst` predicate does — never afterwards in app code.
   */
  const row = { eventId: "event-1", secretHash: issued.secretHash, revokedAt: null as Date | null };
  const lookup: V1CredentialLookup = async () => (row.revokedAt === null ? { ...row } : null);
  const commitRevocation = () => {
    row.revokedAt = new Date();
  };

  // Ordering 1 — the revocation commits BEFORE the read statement begins.
  commitRevocation();
  assert.deepEqual(
    await authorizeV1Request(bearer(issued.token), undefined, lookup),
    UNAUTHORIZED,
    "a revocation that has committed must refuse every later request",
  );
  // Permanently: revocation is a tombstone, never cleared.
  assert.deepEqual(await authorizeV1Request(bearer(issued.token), undefined, lookup), UNAUTHORIZED);

  // Ordering 2 — the revocation has NOT committed when the read begins. The
  // request is authorized, which is the correct answer: the revocation was not
  // yet a fact of the database when the request authenticated. Every request
  // after the commit is refused.
  const live = { eventId: "event-1", secretHash: issued.secretHash, revokedAt: null as Date | null };
  let inFlight: Promise<unknown> | null = null;
  const racingLookup: V1CredentialLookup = async () => {
    // The snapshot is taken here, when the statement runs.
    const snapshot = live.revokedAt === null ? { eventId: live.eventId, secretHash: live.secretHash } : null;
    // The organizer's revoke commits while this request is still in flight.
    live.revokedAt = new Date();
    return snapshot;
  };
  inFlight = authorizeV1Request(bearer(issued.token), undefined, racingLookup);
  assert.deepEqual(
    await inFlight,
    { ok: true, scope: { kind: "event", eventId: "event-1" } },
    "a request that read the row before the revocation committed is authorized",
  );
  assert.deepEqual(
    await authorizeV1Request(bearer(issued.token), undefined, racingLookup),
    UNAUTHORIZED,
    "the next request, after the commit, is refused",
  );
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("the active-credential bound is a real number the create path can enforce", () => {
  assert.equal(MAX_ACTIVE_API_CREDENTIALS_PER_EVENT, 10);
  assert.ok(Number.isInteger(MAX_ACTIVE_API_CREDENTIALS_PER_EVENT));
  assert.ok(MAX_ACTIVE_API_CREDENTIALS_PER_EVENT > 0);
});
