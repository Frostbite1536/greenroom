import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source rails for per-event API credentials.
 *
 * The unit tests next door prove the token and the truth table. These prove the
 * things a unit test cannot reach: that the secret never leaves the
 * authentication path, that no credential material can end up in a URL, a log,
 * or browser storage, that every admin verb is role-gated, and that the
 * published contract still describes what the code does.
 *
 * Every pattern below stays inside one line, so a CRLF checkout matches exactly
 * as an LF one does.
 */

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comments stripped, so "this file never does X" is asserted against code. */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const SCHEMA = "prisma/schema.prisma";
const CONTRACT = "lib/services/api-credential-contract.ts";
const CRYPTO = "lib/services/api-credential.ts";
const STORE = "lib/services/api-credential-store.ts";
const V1 = "lib/api/v1.ts";
const ADMIN_ROUTE = "app/api/admin/api-keys/route.ts";
const PANEL = "components/api-credentials.tsx";
const SPEC = "lib/api/openapi.ts";
const V1_ROUTES = [
  "app/api/v1/submissions/route.ts",
  "app/api/v1/speakers/route.ts",
  "app/api/v1/schedule/route.ts",
];

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

test("the credential model stores a non-secret lookup id and a secret digest, with chosen delete behaviour", () => {
  const schema = read(SCHEMA);
  assert.match(schema, /^model ApiCredential \{$/m);
  // The lookup half is unique-indexed: authentication is a point read, never a
  // scan and never a prefix match.
  assert.match(schema, /^\s*lookupId\s+String\s+@unique$/m, "lookupId must be uniquely indexed");
  assert.match(schema, /^\s*secretHash\s+String$/m, "the secret must be stored only as a digest");
  // The whole-token digest design was replaced; it must not come back.
  assert.doesNotMatch(schema, /^\s*tokenHash\s/m, "a whole-token digest must not be stored");
  assert.doesNotMatch(schema, /^\s*token\s+String/m, "no plaintext token column may exist");
  // Deliberately rejected, not forgotten: every authenticated read is a SELECT.
  assert.doesNotMatch(schema, /^\s*lastUsedAt\s/m, "lastUsedAt was rejected as write amplification");

  assert.match(schema, /^\s*revokedAt\s+DateTime\?$/m, "revocation is a nullable tombstone");
  assert.match(schema, /^\s*createdByUserId String\?$/m, "the creator column must be nullable");
  assert.match(
    schema,
    /^\s*event\s+Event @relation\(fields: \[eventId\], references: \[id\], onDelete: Cascade\)$/m,
    "the event FK must cascade",
  );
  assert.match(
    schema,
    /^\s*createdBy User\? @relation\(fields: \[createdByUserId\], references: \[id\], onDelete: SetNull\)$/m,
    "the creator FK must null out rather than remove the credential",
  );
  assert.match(schema, /^\s*@@index\(\[eventId\]\)$/m, "listing an event's credentials must be indexed");
  // The inverse relations that make those foreign keys real.
  assert.match(schema, /^\s*apiCredentials\s+ApiCredential\[\]$/m);
  assert.match(schema, /^\s*apiCredentials\s+ApiCredential\[\]$/gm);
});

test("the pure contract module stays importable from a browser bundle", () => {
  // No imports at all: the settings panel reads its label bound from here, and
  // the crypto module must never be what a client component reaches for.
  const source = code(CONTRACT);
  assert.doesNotMatch(source, /^\s*import\s/m, "the contract module must import nothing");
  assert.doesNotMatch(source, /node:crypto/, "the contract module must not reach a Node builtin");
  assert.match(code(CRYPTO), /from "@\/lib\/services\/api-credential-contract"/);
  assert.match(code(PANEL), /from "@\/lib\/services\/api-credential-contract"/);
  assert.doesNotMatch(code(PANEL), /from "@\/lib\/services\/api-credential"/);
  assert.doesNotMatch(code(PANEL), /from "@\/lib\/services\/api-credential-store"/);
});

// ---------------------------------------------------------------------------
// The secret never leaves the authentication path
// ---------------------------------------------------------------------------

test("only the authentication query ever reads the stored secret digest", () => {
  // The store's auth read is the sole place `secretHash` is SELECTED from the
  // database. If a listing, an export, or a page read ever projects it, this
  // fails.
  assert.match(code(STORE), /select: \{ id: true, eventId: true, secretHash: true \}/);

  // The admin route is allowed exactly one mention of the digest: writing it at
  // creation. It may never project one back out.
  const adminRoute = code(ADMIN_ROUTE);
  assert.match(adminRoute, /secretHash: issued\.secretHash,/, "the create path must persist the digest");
  assert.doesNotMatch(adminRoute, /secretHash: true/, "the admin route must never project the digest");
  // With that one write removed, the word does not occur anywhere else on this
  // route: no projection, no response field, no log line.
  const withoutTheWrite = adminRoute.replace("secretHash: issued.secretHash,", "");
  assert.doesNotMatch(
    withoutTheWrite,
    /secretHash/,
    "the admin route may name the secret digest only where it writes it",
  );

  // Everywhere else the digest is simply absent.
  for (const path of [PANEL, "lib/data/reads.ts", ...V1_ROUTES]) {
    assert.doesNotMatch(code(path), /secretHash/, `${path} must never touch the stored secret digest`);
  }
  // The panel is a client component; not one word of the secret's shape or its
  // storage reaches the browser bundle through it.
  assert.doesNotMatch(code(PANEL), /hashApiCredentialSecret|apiCredentialSecretMatches/);
});

test("the admin projection cannot emit a secret, and the shown value is derived", () => {
  const route = code(ADMIN_ROUTE);
  // One projection, used by every read on the route.
  assert.match(route, /^const credentialSelect = \{$/m);
  assert.match(route, /^\s*lookupId: true,$/m);
  assert.match(route, /select: credentialSelect,/);
  // The display prefix is computed from the non-secret half, never stored.
  assert.match(route, /tokenPrefix: apiCredentialDisplayPrefix\(row\.lookupId\),/);
  // The plaintext leaves exactly once, from the create response, and is named
  // as the issued value rather than re-read from any row.
  assert.match(route, /return ok\(\{ credential: serializeCredential\(credential\), token: issued\.token \}, 201\);/);
  const createCount = [...route.matchAll(/issued\.token/g)].length;
  assert.equal(createCount, 1, "the issued token may be referenced exactly once");
  // No other verb may return a token at all.
  assert.doesNotMatch(route, /return ok\(\{ credentials: [^\n]*token:/);
});

test("no credential material can reach a URL, a log, or browser storage", () => {
  const route = code(ADMIN_ROUTE);
  // Revocation addresses the credential by its row id. The token is never a
  // route parameter, so it can never land in an access log or a Referer header.
  assert.match(route, /searchParams\.get\("id"\)/);
  assert.doesNotMatch(route, /searchParams\.get\("token"\)/);
  assert.doesNotMatch(route, /searchParams\.get\("lookupId"\)/);
  // Nothing on the server logs any part of a credential.
  for (const path of [route, code(STORE), code(CRYPTO), code(V1)]) {
    assert.doesNotMatch(path, /console\.[a-z]+\([^)]*\b(?:token|secret|secretHash|requestKey)\b/);
  }

  const panel = code(PANEL);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(panel, /router\.push|router\.replace|window\.location/);
  // No console call may take the issued value, or anything holding it, as an
  // argument; the two that exist pass only an error's name.
  assert.doesNotMatch(panel, /console\.[a-z]+\([^)]*\b(?:token|issued|value)\b\s*[,)]/);
  assert.match(panel, /console\.warn\("API key copy failed", error instanceof Error \? error\.name : "unknown"\)/);
  // Only the row id is ever interpolated into a request path.
  assert.match(panel, /\$\{ENDPOINT\}\?id=\$\{encodeURIComponent\(credential\.id\)\}/);
  assert.doesNotMatch(panel, /\?token=|&token=/);
});

// ---------------------------------------------------------------------------
// Authentication order and shape
// ---------------------------------------------------------------------------

test("verification parses, then does one keyed point read, then compares digests", () => {
  const store = code(STORE);
  // Parse first, so unparseable input costs no round trip.
  assert.match(store, /const parsed = parseApiCredentialToken\(token\);/);
  assert.match(store, /if \(!parsed\) return null;/);
  // A single-row read keyed on the NON-secret half.
  assert.match(store, /where: \{ lookupId: parsed\.lookupId, revokedAt: null \}/);
  // Never a scan, a page, or a prefix match over an event's credentials.
  assert.doesNotMatch(store, /apiCredential\.findMany/);
  assert.doesNotMatch(store, /startsWith:|contains:|take:/);

  const v1 = code(V1);
  // The deployment-wide comparison still comes first and still costs nothing.
  const requestKeyAt = v1.indexOf("const requestKey = getV1RequestKey(headers)");
  const globalAt = v1.indexOf("keysMatch(configuredKey, requestKey)");
  const parseAt = v1.indexOf("parseApiCredentialToken(requestKey)");
  const lookupAt = v1.indexOf("await findCredential(requestKey)");
  assert.ok(requestKeyAt > 0 && globalAt > requestKeyAt, "header precedence must be settled first");
  assert.ok(parseAt > globalAt, "the deployment-wide key must be checked before any credential parsing");
  assert.ok(lookupAt > parseAt, "nothing may be looked up before the presented value has parsed");
  // Constant-time comparison of the secret's digest, not a raw equality.
  assert.match(v1, /apiCredentialSecretMatches\(credential\.secretHash, parsed\.secret\)/);
  assert.doesNotMatch(v1, /credential\.secretHash ===/);
  assert.match(code(CRYPTO), /return timingSafeEqual\(expectedBytes, receivedBytes\);/);
});

test("revocation is decided inside the authenticating statement, never afterwards in app code", () => {
  const store = code(STORE);
  // The predicate lives in the query. Moving it into TypeScript would create
  // the check-then-act window the design says does not exist.
  assert.match(store, /revokedAt: null \}/);
  assert.doesNotMatch(store, /if \([a-zA-Z.]*revokedAt/, "revocation must not be re-checked in app code");
  assert.doesNotMatch(code(V1), /revokedAt/, "the auth path must not know how revocation is represented");
});

test("a per-event credential narrows the event query rather than filtering its result", () => {
  const v1 = code(V1);
  assert.match(v1, /return scope\.kind === "event" \? \{ AND: \[bySelector, \{ id: scope\.eventId \}\] \} : bySelector;/);
  for (const path of V1_ROUTES) {
    const route = code(path);
    // The scoped predicate is what runs; the event is never fetched unscoped
    // and rejected afterwards.
    assert.match(route, /where: v1EventWhere\(authorization\.scope, query\.value\.event\)/, path);
    assert.doesNotMatch(route, /where: \{ OR: \[\{ id: query\.value\.event \}/, path);
    // Authorization still precedes every database call in the file.
    const authAt = route.indexOf("authorizeV1Request(req.headers)");
    const prismaAt = route.indexOf("await prisma");
    assert.ok(authAt > 0 && authAt < prismaAt, `${path} must authorize before it queries`);
    // And the scope check precedes every programme read.
    const scopeAt = route.indexOf("authorizeV1EventScope(authorization.scope, selected)");
    const listAt = route.indexOf("Promise.all([");
    assert.ok(scopeAt > 0 && scopeAt < listAt, `${path} must bind the scope before it lists anything`);
  }
});

// ---------------------------------------------------------------------------
// The admin surface
// ---------------------------------------------------------------------------

test("every admin verb is ADMIN-only and scoped to the session's own event", () => {
  const route = code(ADMIN_ROUTE);
  const admin = [...route.matchAll(/requireContext\(\["ADMIN"\]\)/g)];
  assert.equal(admin.length, 3, "list, create and revoke must each require ADMIN");
  for (const verb of ["export const GET", "export const POST", "export const DELETE"]) {
    assert.ok(route.includes(verb), `${verb} must exist`);
  }
  // Nothing here accepts an event id from the caller: the scope is the signed
  // session's active event, every time.
  const scoped = [...route.matchAll(/eventId: ctx\.eventId/g)];
  assert.ok(scoped.length >= 4, `every query must be event-scoped, found ${scoped.length}`);
  assert.doesNotMatch(route, /eventId: input\.|eventId: body\.|searchParams\.get\("eventId"\)/);
  // The shared contract module stays untouched by this feature.
  assert.doesNotMatch(route, /from "@\/types\/api"/, "request shapes here are route-local");
});

test("issuance is bounded under a lock, and revocation is idempotent and scoped", () => {
  const route = code(ADMIN_ROUTE);
  // Count and insert are atomic with respect to each other.
  assert.match(route, /await lockEventApiCredentialIssuance\(tx, ctx\.eventId\);/);
  assert.match(route, /const active = await tx\.apiCredential\.count\(\{/);
  assert.match(route, /if \(active >= MAX_ACTIVE_API_CREDENTIALS_PER_EVENT\) \{/);
  assert.match(route, /"API_KEY_LIMIT_REACHED",/);
  const lockAt = route.indexOf("lockEventApiCredentialIssuance");
  const countAt = route.indexOf("apiCredential.count");
  const createAt = route.indexOf("tx.apiCredential.create");
  assert.ok(lockAt < countAt && countAt < createAt, "the bound must be counted under the lock, before the insert");

  // Revoke sets a tombstone; it never deletes the row.
  assert.match(route, /data: \{ revokedAt: new Date\(\) \}/);
  assert.doesNotMatch(route, /apiCredential\.delete/);
  assert.doesNotMatch(route, /apiCredential\.deleteMany/);
  // Idempotent: an already-revoked credential is not an error.
  assert.match(route, /where: \{ id, eventId: ctx\.eventId, revokedAt: null \}/);
  // Scope is inside the predicate, so another event's id is simply not found.
  assert.match(route, /where: \{ id, eventId: ctx\.eventId \}/);
  assert.match(route, /"API_KEY_NOT_FOUND", "API key not found."/);
  // Credential listings are never cached.
  assert.match(route, /response\.headers\.set\("Cache-Control", "no-store"\);/);
});

// ---------------------------------------------------------------------------
// The organizer's panel
// ---------------------------------------------------------------------------

test("the panel shows a new key exactly once, in a native dialog, and says so", () => {
  const panel = read(PANEL);
  // The same native-dialog precedent as the new-event dialog: focus trap, Esc
  // and inert background come from the platform.
  assert.match(panel, /dialog\.showModal\(\);/);
  assert.match(panel, /<dialog$/m);
  assert.match(panel, /className="app-dialog api-credential-dialog"/);
  assert.match(panel, /onCancel=\{closeDialog\}/);

  // The reveal is a read-only field with a copy affordance, and success is
  // claimed only after the clipboard write resolves.
  assert.match(panel, /await navigator\.clipboard\.writeText\(value\);/);
  assert.match(panel, /setCopyState\("copied"\);/);
  assert.match(panel, /if \(!navigator\.clipboard\?\.writeText\) throw new Error\("clipboard unavailable"\);/);
  assert.match(panel, /tokenField\.current\?\.select\(\);/);
  assert.match(panel, /press Ctrl\/Cmd \+ C/);

  // Shown only once, said in those words, and made true by dropping the state.
  assert.match(panel, /<strong>This key is shown only once\.<\/strong>/);
  assert.match(panel, /setIssued\(null\);/);
  // Closing is what enforces it — the token is not kept anywhere else.
  assert.match(panel, /function closeDialog\(\) \{/);
});

test("revoking asks for confirmation and names the key being switched off", () => {
  const panel = read(PANEL);
  assert.match(panel, /window\.confirm\($/m);
  assert.match(panel, /Revoke .\$\{credential\.label\}.\? Anything using this key stops working immediately/);
  assert.match(panel, /if \(\s*$/m);
  // A refused confirmation does nothing at all.
  assert.match(panel, /^\s*\) \{\s*$/m);
  assert.match(panel, /^\s*return;\s*$/m);
  // The list only ever shows the derived prefix, never a whole key.
  assert.match(panel, /\{credential\.tokenPrefix\}/);
  assert.doesNotMatch(panel, /\{credential\.token\}/);
});

// ---------------------------------------------------------------------------
// The published contract still describes what the code does
// ---------------------------------------------------------------------------

test("the published spec documents both key kinds, the scoped refusal, and the one lookup it costs", () => {
  const spec = read(SPEC);
  assert.match(spec, /grk_<id>_<secret>/, "the per-event key format must be published");
  assert.match(spec, /is not secret/, "the spec must say which half is not secret");
  // The 503 copy no longer claims the whole surface refuses before any database
  // read, because authenticating a per-event key costs one indexed lookup.
  assert.match(spec, /exactly one indexed lookup of the key itself/);
  assert.doesNotMatch(spec, /before it authenticates or touches the database/);
  assert.doesNotMatch(spec, /returned before authentication and before any database work/);
  // The indistinguishable-refusal promise is published, not just implemented.
  assert.match(spec, /indistinguishable/);
  assert.match(spec, /none of them reveals whether the event named actually exists\./);
  // And the spec still imports nothing that could reach env, auth, or Prisma —
  // lib/api/openapi-purity.test.ts proves the graph; this is the local guard.
  assert.doesNotMatch(spec, /from "@\/lib\/services\//);
  assert.doesNotMatch(spec, /from "@\/lib\/prisma"/);
});
