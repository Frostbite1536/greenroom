import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOGIN_EMAIL_MAX_LENGTH,
  normalizeLoginEmail,
  normalizeLoginPassword,
  pickCredentialMembership,
  resolveCredentialSession,
  type CredentialUserRecord,
} from "./credential-login";

const EVENT = { id: "event-forward", name: "Forward 2026", slug: "forward-2026" };
const OTHER_EVENT = { id: "aardvark-event", name: "Other", slug: "other" };

function record(overrides: Partial<CredentialUserRecord> = {}): CredentialUserRecord {
  return {
    id: "user-1",
    name: "Priya Raman",
    email: "speaker@example.test",
    passwordHash: "stored-credential",
    memberships: [{ role: "SPEAKER", event: EVENT }],
    ...overrides,
  };
}

/** Injected stand-in: the real scrypt verification is covered by its own suite. */
function fakeVerify(secret: string) {
  const calls: { password: string; stored: string | null }[] = [];
  const verify = async (password: string, stored: string | null) => {
    calls.push({ password, stored });
    return stored === "stored-credential" && password === secret;
  };
  return { verify, calls };
}

test("a correct credential issues the persona-shaped session with a server-resolved role", async () => {
  const { verify } = fakeVerify("right-password");
  const session = await resolveCredentialSession({
    email: "  Speaker@Example.TEST ",
    password: "right-password",
    findUser: async (email) => (email === "speaker@example.test" ? record() : null),
    verify,
  });
  assert.deepEqual(session, {
    user: { id: "user-1", name: "Priya Raman", email: "speaker@example.test" },
    event: EVENT,
    role: "SPEAKER",
  });
});

test("unknown email, wrong password, and no credential are one indistinguishable refusal", async () => {
  const { verify, calls } = fakeVerify("right-password");
  const findUser = async (email: string) => (email === "speaker@example.test" ? record() : null);

  const unknown = await resolveCredentialSession({ email: "nobody@example.test", password: "right-password", findUser, verify });
  const wrong = await resolveCredentialSession({ email: "speaker@example.test", password: "wrong-password", findUser, verify });
  const noCredential = await resolveCredentialSession({
    email: "speaker@example.test",
    password: "right-password",
    findUser: async () => record({ passwordHash: null }),
    verify,
  });
  const noMembership = await resolveCredentialSession({
    email: "speaker@example.test",
    password: "right-password",
    findUser: async () => record({ memberships: [] }),
    verify,
  });

  assert.equal(unknown, null);
  assert.equal(wrong, null);
  assert.equal(noCredential, null);
  assert.equal(noMembership, null);

  // Every path performed a verification, including the one with no user row.
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { password: "right-password", stored: null });
  assert.deepEqual(calls[2], { password: "right-password", stored: null });
});

test("an empty or oversized address is refused without a lookup, but still verifies", async () => {
  const { verify, calls } = fakeVerify("right-password");
  let lookups = 0;
  const findUser = async () => {
    lookups++;
    return record();
  };
  for (const email of ["", "   ", `${"a".repeat(LOGIN_EMAIL_MAX_LENGTH)}@example.test`]) {
    assert.equal(await resolveCredentialSession({ email, password: "right-password", findUser, verify }), null);
  }
  assert.equal(lookups, 0);
  assert.equal(calls.length, 3);
});

test("normalizeLoginEmail lowercases, trims, and refuses anything unusable", () => {
  assert.equal(normalizeLoginEmail("  Jordan.Organizer@Example.COM "), "jordan.organizer@example.com");
  assert.equal(normalizeLoginEmail(""), "");
  assert.equal(normalizeLoginEmail(null), "");
  assert.equal(normalizeLoginEmail(undefined), "");
  assert.equal(normalizeLoginEmail(42), "");
  assert.equal(normalizeLoginEmail(["a@b.test"]), "");
  assert.equal(normalizeLoginEmail("a".repeat(LOGIN_EMAIL_MAX_LENGTH)), "a".repeat(LOGIN_EMAIL_MAX_LENGTH));
  // Oversized becomes "" rather than a truncation, so an attempt is never
  // charged to a bucket keyed on a value the user did not submit.
  assert.equal(normalizeLoginEmail("a".repeat(LOGIN_EMAIL_MAX_LENGTH + 1)), "");
});

test("normalizeLoginPassword preserves the secret verbatim and bounds its length", () => {
  assert.equal(normalizeLoginPassword("  spaces matter  "), "  spaces matter  ");
  assert.equal(normalizeLoginPassword(null), "");
  assert.equal(normalizeLoginPassword(123456), "");
  assert.equal(normalizeLoginPassword("x".repeat(512)), "x".repeat(512));
  assert.equal(normalizeLoginPassword("x".repeat(513)), "");
});

test("membership selection is deterministic: authority, then the pinned event, then event id", () => {
  assert.equal(pickCredentialMembership([]), null);
  assert.deepEqual(
    pickCredentialMembership([
      { role: "SPEAKER", event: OTHER_EVENT },
      { role: "ADMIN", event: EVENT },
      { role: "EVALUATOR", event: OTHER_EVENT },
    ]),
    { role: "ADMIN", event: EVENT },
  );
  // Role authority still outranks the pin: a more capable home on another event
  // wins over an EVALUATOR seat on the pinned one.
  assert.deepEqual(
    pickCredentialMembership([
      { role: "EVALUATOR", event: EVENT },
      { role: "ADMIN", event: OTHER_EVENT },
    ]),
    { role: "ADMIN", event: OTHER_EVENT },
  );
  // At equal role the pinned default event wins, even though "aardvark-event"
  // sorts before "event-forward" by id.
  assert.deepEqual(
    pickCredentialMembership([
      { role: "EVALUATOR", event: EVENT },
      { role: "EVALUATOR", event: OTHER_EVENT },
    ]),
    { role: "EVALUATOR", event: EVENT },
  );
  // Event id remains the final tie-break between two unpinned events.
  const THIRD_EVENT = { id: "zebra-event", name: "Third", slug: "third" };
  assert.deepEqual(
    pickCredentialMembership([
      { role: "EVALUATOR", event: THIRD_EVENT },
      { role: "EVALUATOR", event: OTHER_EVENT },
    ]),
    { role: "EVALUATOR", event: OTHER_EVENT },
  );
  // Input order must not change the answer.
  const memberships = [
    { role: "SPEAKER" as const, event: EVENT },
    { role: "EVALUATOR" as const, event: OTHER_EVENT },
  ];
  assert.deepEqual(pickCredentialMembership(memberships), pickCredentialMembership([...memberships].reverse()));
});

/**
 * D-C5-9 regression. Admin event creation grants the creator ADMIN membership
 * on the new event, and `Event.id` is a cuid — every cuid starts with "c",
 * which sorts before the seeded default event's literal id "demo-event". Under
 * the old id-only tie-break the organizer's next sign-in would silently land on
 * the brand-new empty event and the populated programme would look lost.
 */
test("a newly created event never displaces the pinned default event at sign-in", () => {
  const seeded = { role: "ADMIN" as const, event: { id: "demo-event", name: "Forward 2026", slug: "forward-2026" } };
  const justCreated = {
    role: "ADMIN" as const,
    event: { id: "cm4x0000000000000000abcd", name: "Forward 2027", slug: "forward-2027" },
  };
  // Guard the premise rather than assume it: the new id really does sort first.
  assert.ok(justCreated.event.id.localeCompare(seeded.event.id) < 0);
  assert.deepEqual(pickCredentialMembership([seeded, justCreated]), seeded);
  assert.deepEqual(pickCredentialMembership([justCreated, seeded]), seeded);
});

test("the resolved session never carries the stored credential", async () => {
  const { verify } = fakeVerify("right-password");
  const session = await resolveCredentialSession({
    email: "speaker@example.test",
    password: "right-password",
    findUser: async () => record(),
    verify,
  });
  assert.ok(session);
  assert.doesNotMatch(JSON.stringify(session), /passwordHash|stored-credential|right-password/);
});
