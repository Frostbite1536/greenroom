/**
 * Contract for direct session creation — `POST /api/agenda/sessions`.
 *
 * The talk with no source proposal (a keynote, a sponsor slot) is the one
 * `Session` shape the schema always allowed and no route could create. Three
 * things make the new route safe, and none of them is observable from a pure
 * function alone, so each is pinned here against the code that implements it:
 *
 *  1. it is ADMIN-only and event-scoped from the signed context;
 *  2. it never writes `Session`/`SessionSpeaker` itself — the shared
 *     provisioning module does, which is what keeps the roster snapshot and the
 *     onboarding fan-out (INV-TASK-001) from existing in two places;
 *  3. a speaker id that is not on this event's roster is refused, and refused
 *     with the same 404 an unknown id gets.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  GUARANTEED_SESSION_MAX_SPEAKERS,
  guaranteedSessionInputSchema,
} from "@/types/api";
import { taskFanOutLockKey } from "@/lib/services/onboarding-task-lock";
import {
  newGuaranteedSessionData,
  provisionGuaranteedSession,
} from "@/lib/services/session-provisioning";
import { readEventRosterMembership } from "@/lib/services/speaker-roster";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * The same file with comments stripped. "This route never writes X" has to be
 * asserted against code, not against a doc comment that names X.
 */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const ROUTE = "app/api/agenda/sessions/route.ts";

/** Just the POST handler: the file also holds the publication PATCH. */
const postHandler = () => {
  const file = source(ROUTE);
  const at = file.indexOf("export const POST");
  assert.ok(at > 0, "the route must export a POST handler");
  return file.slice(at);
};

// ---- 1. Authorization -----------------------------------------------------

test("creating a session is ADMIN-only and scoped to the signed event", () => {
  const post = postHandler();
  // Anyone who is not an ADMIN on this event is refused by the shared helper,
  // which throws 403 before the body is even read.
  assert.match(post, /requireContext\(\["ADMIN"\]\)/);
  // ...and an ADMIN of some other event cannot aim this at that event: the
  // body's id is checked against the signed context, never trusted (INV-EVENT-001).
  assert.match(post, /assertEventScope\(ctx, input\.eventId\)/);

  // The authorization gate is the first thing that happens — before parsing,
  // before the transaction, before any write.
  const authAt = post.indexOf('requireContext(["ADMIN"])');
  for (const later of ["parseBody(", "assertEventScope(", "prisma.$transaction(", "provisionGuaranteedSession("]) {
    assert.ok(post.indexOf(later) > authAt, `${later} must follow the ADMIN check`);
  }
  // The publication PATCH that shares this file keeps its own gate.
  assert.equal((source(ROUTE).match(/requireContext\(\["ADMIN"\]\)/g) ?? []).length, 2);
});

test("the route body reaches Session and SessionSpeaker only through provisioning", () => {
  const routeCode = code(ROUTE);
  const post = routeCode.slice(routeCode.indexOf("export const POST"));
  assert.match(post, /provisionGuaranteedSession\(tx, ctx\.eventId, input\)/);
  // Every direct write to the two tables acceptance owns. A second writer here
  // is exactly the drift the shared module exists to prevent.
  for (const forbidden of [
    /tx\.session\.create\(/,
    /tx\.session\.createMany\(/,
    /tx\.session\.upsert\(/,
    /tx\.sessionSpeaker\.create\(/,
    /tx\.sessionSpeaker\.createMany\(/,
    /tx\.sessionSpeaker\.upsert\(/,
    /tx\.speakerTask\./,
  ]) {
    assert.doesNotMatch(post, forbidden, `the route must not write this itself: ${forbidden}`);
  }
  // The one Session touch it keeps is a read-back of the row just created, so
  // the confirmation names the stored title rather than echoing the request.
  assert.match(post, /tx\.session\.findUniqueOrThrow\(/);
});

test("the event is locked before the roster is read, and the roster before the write", () => {
  const post = postHandler();
  const order = [
    'SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR SHARE',
    "readEventRosterMembership(tx, ctx.eventId, requested)",
    "provisionGuaranteedSession(tx, ctx.eventId, input)",
  ];
  let previous = -1;
  for (const step of order) {
    const at = post.indexOf(step);
    assert.ok(at > previous, `${step} must follow the previous step`);
    previous = at;
  }
  // Event-before-what-it-scopes is this repo's existing convention, asserted
  // across every Event locker in the autoplace contract test. This joins it.
  assert.match(post, /prisma\.\$transaction\(/);
  assert.match(post, /if \(!eventRows\[0\]\) throw new ApiError\(404, "EVENT_NOT_FOUND"/);
});

// ---- 2. Validation refusals ----------------------------------------------

const validInput = {
  eventId: "event-1",
  title: "Opening keynote",
  durationMinutes: 45,
  speakers: [{ userId: "user-1", isPrimary: true }],
};

test("a well-formed guaranteed session is accepted, speakers and all", () => {
  const parsed = guaranteedSessionInputSchema.safeParse(validInput);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.speakers, [{ userId: "user-1", isPrimary: true }]);
});

test("a sponsor slot with no line-up yet is valid, and speakers default to none", () => {
  // The proposal contract is `.min(1)` because a proposal without a submitter
  // does not exist. A blocked-out sponsor slot with nobody named does.
  const withoutSpeakers = guaranteedSessionInputSchema.safeParse({
    eventId: "event-1",
    title: "Sponsor showcase",
    durationMinutes: 20,
  });
  assert.equal(withoutSpeakers.success, true);
  assert.deepEqual(withoutSpeakers.data?.speakers, []);

  const explicitlyEmpty = guaranteedSessionInputSchema.safeParse({ ...validInput, speakers: [] });
  assert.equal(explicitlyEmpty.success, true);
  assert.deepEqual(explicitlyEmpty.data?.speakers, []);
});

test("isPrimary defaults to false so an unnamed lead is never invented", () => {
  const parsed = guaranteedSessionInputSchema.safeParse({
    ...validInput,
    speakers: [{ userId: "user-1" }],
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.speakers, [{ userId: "user-1", isPrimary: false }]);
});

test("every malformed field is refused at the boundary, not by the database", () => {
  const refused: [string, unknown][] = [
    ["missing event id", { ...validInput, eventId: undefined }],
    ["blank event id", { ...validInput, eventId: "" }],
    ["missing title", { ...validInput, title: undefined }],
    ["title under three characters", { ...validInput, title: "Hi" }],
    ["title over 180 characters", { ...validInput, title: "x".repeat(181) }],
    ["summary over 5000 characters", { ...validInput, description: "x".repeat(5001) }],
    ["format over 80 characters", { ...validInput, format: "x".repeat(81) }],
    ["missing duration", { ...validInput, durationMinutes: undefined }],
    ["duration under five minutes", { ...validInput, durationMinutes: 4 }],
    ["duration over eight hours", { ...validInput, durationMinutes: 481 }],
    ["fractional duration", { ...validInput, durationMinutes: 30.5 }],
    ["duration as a string", { ...validInput, durationMinutes: "45" }],
    ["a speaker with no user id", { ...validInput, speakers: [{ isPrimary: true }] }],
    ["a speaker named by email", { ...validInput, speakers: [{ email: "a@example.com", name: "A" }] }],
    [
      "more speakers than a stage holds",
      {
        ...validInput,
        speakers: Array.from({ length: GUARANTEED_SESSION_MAX_SPEAKERS + 1 }, (_, i) => ({ userId: `user-${i}` })),
      },
    ],
    // Strict: an unknown key is a caller believing this route does something
    // it does not, which is worth a refusal rather than a silent drop.
    ["an unknown field", { ...validInput, contentStatus: "PUBLISHED" }],
    ["a source abstract", { ...validInput, sourceAbstractId: "abstract-1" }],
  ];
  for (const [name, input] of refused) {
    assert.equal(guaranteedSessionInputSchema.safeParse(input).success, false, name);
  }
});

test("a repeated speaker is refused before it can become a unique violation", () => {
  // `SessionSpeaker` is keyed on (sessionId, userId): a duplicate would reach
  // Postgres as a P2002 and surface to the organizer as a bare 500.
  const parsed = guaranteedSessionInputSchema.safeParse({
    ...validInput,
    speakers: [{ userId: "user-1" }, { userId: "user-1" }],
  });
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error?.issues), /Name each speaker only once/);
});

test("two primary speakers are refused", () => {
  const parsed = guaranteedSessionInputSchema.safeParse({
    ...validInput,
    speakers: [{ userId: "user-1", isPrimary: true }, { userId: "user-2", isPrimary: true }],
  });
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error?.issues), /Only one speaker can be the primary speaker/);

  // One primary alongside co-speakers is the normal shape and stays valid.
  assert.equal(
    guaranteedSessionInputSchema.safeParse({
      ...validInput,
      speakers: [{ userId: "user-1", isPrimary: true }, { userId: "user-2" }],
    }).success,
    true,
  );
});

test("validation refusals are 422, never 400", () => {
  // `parseBody` routes every Zod failure through `fromZod`, which is 422. This
  // pins the route to that helper rather than hand-rolling a status.
  const post = postHandler();
  assert.match(post, /parseBody\(req, guaranteedSessionInputSchema\)/);
  assert.doesNotMatch(code(ROUTE), /ApiError\(400/);
  assert.match(source("lib/api/http.ts"), /new ApiError\(422, "VALIDATION_ERROR"/);
});

// ---- 3. Successful creation, through the shared provisioning path ---------

test("a directly authored talk is created with no source abstract and as a DRAFT", () => {
  assert.deepEqual(
    newGuaranteedSessionData("event-1", {
      title: "Opening keynote",
      description: "  How the year went.  ",
      format: " Keynote ",
      durationMinutes: 45,
      speakers: [],
    }),
    {
      eventId: "event-1",
      // What makes this a guaranteed session at all (INV-DOMAIN-001).
      sourceAbstractId: null,
      title: "Opening keynote",
      description: "How the year went.",
      format: "Keynote",
      durationMinutes: 45,
      // Overriding the column's PUBLISHED default: a talk being typed into a
      // dialog is not an announcement. The admin publishes with the PATCH.
      contentStatus: "DRAFT",
    },
  );
});

test("an omitted or blank summary and format are stored as null, not empty strings", () => {
  const bare = newGuaranteedSessionData("event-1", {
    title: "Sponsor showcase",
    durationMinutes: 20,
    speakers: [],
  });
  assert.equal(bare.description, null);
  assert.equal(bare.format, null);

  const blank = newGuaranteedSessionData("event-1", {
    title: "Sponsor showcase",
    description: "   ",
    format: "\t",
    durationMinutes: 20,
    speakers: [],
  });
  assert.equal(blank.description, null);
  assert.equal(blank.format, null);
});

test("a talk is never created carrying a category it has no proposal to inherit", () => {
  assert.equal(
    "categoryId" in newGuaranteedSessionData("event-1", {
      title: "Opening keynote",
      durationMinutes: 45,
      speakers: [],
    }),
    false,
  );
});

/** Records every write a provisioning run makes, with no database. */
function provisioningTx(options: { taskIds?: string[] } = {}) {
  const taskIds = options.taskIds ?? [];
  const calls = {
    advisoryKeys: [] as string[],
    /** Every recorded step, in the order provisioning took it. */
    sequence: [] as string[],
    sessionCreates: [] as Record<string, unknown>[],
    speakerRows: [] as Record<string, unknown>[],
    taskRows: [] as Record<string, unknown>[],
  };
  let speakerRows: { userId: string }[] = [];
  const tx = {
    // C33: the per-event onboarding fan-out lock. Recorded rather than ignored,
    // because taking it FIRST is the whole fix — see
    // `session-provisioning-lock.source.test.ts` and the two-client race proof.
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.advisoryKeys.push(String(values[0]));
      calls.sequence.push("lock");
      return 1;
    },
    session: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.sequence.push("session.create");
        calls.sessionCreates.push(args.data);
        return { id: "session-new" };
      },
    },
    sessionSpeaker: {
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        calls.sequence.push("sessionSpeaker.createMany");
        calls.speakerRows.push(...args.data);
        speakerRows = args.data.map((row) => ({ userId: String(row.userId) }));
        return { count: args.data.length };
      },
      // The checklist fan-out reads the rows just written, never the request.
      findMany: async (args: { where: { userId?: { gt: string } } }) => {
        const after = args.where.userId?.gt;
        return [...speakerRows]
          .sort((left, right) => left.userId.localeCompare(right.userId))
          .filter((row) => (after ? row.userId > after : true));
      },
    },
    onboardingTask: {
      findMany: async (args: { where: { id?: { gt: string } } }) =>
        (args.where.id?.gt ? [] : taskIds.map((id) => ({ id }))),
    },
    speakerTask: {
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        calls.sequence.push("speakerTask.createMany");
        calls.taskRows.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

test("provisioning writes the session, its roster, and every speaker's checklist", async () => {
  const { tx, calls } = provisioningTx({ taskIds: ["task-a", "task-b"] });
  const result = await provisionGuaranteedSession(tx, "event-1", {
    title: "Opening keynote",
    description: "How the year went.",
    format: "Keynote",
    durationMinutes: 45,
    speakers: [{ userId: "user-1", isPrimary: true }, { userId: "user-2", isPrimary: false }],
  });

  assert.deepEqual(result, { sessionId: "session-new", speakersAdded: 2, tasksAssigned: 4 });
  // C33: the event's fan-out lock, under the shared key, before the session
  // exists. A concurrent `POST /api/admin/tasks` maintains the same
  // cross-product from the template end; without this both read a snapshot
  // missing the other's row and this speaker never gets the new required task.
  assert.deepEqual(calls.advisoryKeys, [taskFanOutLockKey("event-1")]);
  assert.deepEqual(calls.sequence, [
    "lock",
    "session.create",
    "sessionSpeaker.createMany",
    "speakerTask.createMany",
  ]);
  assert.equal(calls.sessionCreates.length, 1);
  assert.equal(calls.sessionCreates[0].sourceAbstractId, null);
  assert.equal(calls.sessionCreates[0].contentStatus, "DRAFT");
  assert.deepEqual(calls.speakerRows, [
    { sessionId: "session-new", userId: "user-1", isPrimary: true },
    { sessionId: "session-new", userId: "user-2", isPrimary: false },
  ]);
  // INV-TASK-001: the onboarding-task × session-speaker cross-product. A
  // keynote speaker is a confirmed speaker and gets the same checklist.
  assert.equal(calls.taskRows.length, 4);
  assert.deepEqual(
    [...new Set(calls.taskRows.map((row) => `${row.taskId}:${row.userId}`))].sort(),
    ["task-a:user-1", "task-a:user-2", "task-b:user-1", "task-b:user-2"],
  );
});

test("a talk created with nobody on it writes no roster and fans out no checklist", async () => {
  const { tx, calls } = provisioningTx({ taskIds: ["task-a"] });
  const result = await provisionGuaranteedSession(tx, "event-1", {
    title: "Sponsor showcase",
    durationMinutes: 20,
    speakers: [],
  });
  assert.deepEqual(result, { sessionId: "session-new", speakersAdded: 0, tasksAssigned: 0 });
  // Still locked, and still first: a talk with nobody on it today is a talk a
  // roster edit can join tomorrow, and the lock class is per event, not per row.
  assert.deepEqual(calls.sequence, ["lock", "session.create"]);
  assert.deepEqual(calls.speakerRows, []);
  // Not "zero tasks because there are no tasks" — zero because there is nobody
  // to assign them to. A fan-out to an empty roster must write nothing.
  assert.deepEqual(calls.taskRows, []);
});

test("an event with no onboarding checklist still creates the talk and its roster", async () => {
  const { tx, calls } = provisioningTx({ taskIds: [] });
  const result = await provisionGuaranteedSession(tx, "event-1", {
    title: "Opening keynote",
    durationMinutes: 45,
    speakers: [{ userId: "user-1", isPrimary: true }],
  });
  assert.deepEqual(result, { sessionId: "session-new", speakersAdded: 1, tasksAssigned: 0 });
  assert.deepEqual(calls.sequence, ["lock", "session.create", "sessionSpeaker.createMany"]);
  assert.equal(calls.speakerRows.length, 1);
  assert.deepEqual(calls.taskRows, []);
});

// ---- 4. Cross-event speaker refusal --------------------------------------

/**
 * A roster read with no database. `members` are this event's `EventMember`
 * rows; `sessionUserIds` are the people already on one of its sessions.
 */
function rosterTx(options: {
  members?: { userId: string; role: string }[];
  sessionUserIds?: string[];
}) {
  const members = options.members ?? [];
  const sessionUserIds = options.sessionUserIds ?? [];
  const calls = {
    advisoryKeys: [] as string[],
    memberQueries: 0,
    sessionSpeakerWhere: [] as Record<string, unknown>[],
  };
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.advisoryKeys.push(String(values[0]));
      return 1;
    },
    $queryRaw: async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      calls.memberQueries += 1;
      return members;
    },
    sessionSpeaker: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.sessionSpeakerWhere.push(args.where);
        const asked = (args.where.userId as { in: string[] }).in;
        return sessionUserIds.filter((userId) => asked.includes(userId)).map((userId) => ({ userId }));
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

test("a speaker on this event's roster is accepted, by membership or by session", async () => {
  const { tx } = rosterTx({
    members: [{ userId: "user-member", role: "SPEAKER" }],
    sessionUserIds: ["user-on-session"],
  });
  const accepted = await readEventRosterMembership(tx, "event-1", ["user-member", "user-on-session"]);
  // The same union `/admin/speakers` authorizes against: a membership row, or
  // a `SessionSpeaker` row (which an accepted abstract creates without one).
  assert.deepEqual([...accepted].sort(), ["user-member", "user-on-session"]);
});

test("a user id from another event is not on this event's roster", async () => {
  // Neither table answers for them here, which is precisely the cross-event
  // case: the reads are event-scoped, so another event's speaker is simply
  // absent — indistinguishable from an id that does not exist anywhere.
  const { tx, calls } = rosterTx({ members: [], sessionUserIds: [] });
  const accepted = await readEventRosterMembership(tx, "event-1", ["user-elsewhere"]);
  assert.equal(accepted.has("user-elsewhere"), false);
  assert.equal(accepted.size, 0);

  // The session half is event-scoped in the query itself. Without this clause a
  // speaker on ANY event's session would pass this event's roster gate.
  assert.deepEqual(calls.sessionSpeakerWhere[0].session, { eventId: "event-1" });
});

test("membership alone is not enough — the role must be SPEAKER", async () => {
  // A reviewer or another organizer holds an `EventMember` row on this event
  // and must still not be placeable on its programme as a speaker.
  for (const role of ["ADMIN", "REVIEWER"]) {
    const { tx } = rosterTx({ members: [{ userId: "user-1", role }], sessionUserIds: [] });
    const accepted = await readEventRosterMembership(tx, "event-1", ["user-1"]);
    assert.equal(accepted.has("user-1"), false, role);
  }
});

test("the roster read takes the C17 authority keys before it reads any row", async () => {
  const { tx, calls } = rosterTx({ members: [{ userId: "user-1", role: "SPEAKER" }] });
  await readEventRosterMembership(tx, "event-1", ["user-1", "user-2", "user-1"]);
  // One key per distinct (event, user), in the shared bytewise tuple order, so
  // a concurrent `POST /api/admin/speakers` cannot insert a membership into the
  // gap between "no row" and this decision.
  assert.deepEqual(calls.advisoryKeys, [
    "event-member-authority:event-1:user-1",
    "event-member-authority:event-1:user-2",
  ]);
  assert.equal(calls.memberQueries, 1);
});

test("an empty speaker list touches no roster table at all", async () => {
  const { tx, calls } = rosterTx({});
  const accepted = await readEventRosterMembership(tx, "event-1", []);
  assert.equal(accepted.size, 0);
  assert.deepEqual(calls.advisoryKeys, []);
  assert.equal(calls.memberQueries, 0);
  assert.deepEqual(calls.sessionSpeakerWhere, []);
});

test("an off-roster speaker is the same 404 an unknown id gets, and blocks the write", () => {
  const post = postHandler();
  assert.match(post, /const onRoster = await readEventRosterMembership\(tx, ctx\.eventId, requested\)/);
  assert.match(
    post,
    /if \(requested\.some\(\(userId\) => !onRoster\.has\(userId\)\)\)\s*\{\s*throw new ApiError\(\s*404,\s*"SPEAKER_NOT_FOUND"/,
  );
  // The refusal is the exact wording `/api/admin/speakers` uses, so the two
  // surfaces cannot be told apart by their message either.
  assert.match(post, /"Speaker not found\."/);
  assert.match(source("app/api/admin/speakers/route.ts"), /"SPEAKER_NOT_FOUND", "Speaker not found\."/);
  // It throws inside the transaction, so a refused request rolls back with no
  // session created — the check sits before provisioning.
  assert.ok(post.indexOf('"SPEAKER_NOT_FOUND"') < post.indexOf("provisionGuaranteedSession("));
});

// ---- The claim boundary this closes --------------------------------------

test("the lifecycle doc no longer claims direct creation is unimplemented", () => {
  const lifecycle = source("docs/LIFECYCLE.md");
  assert.doesNotMatch(lifecycle, /no route implements\s*\r?\n?\s*direct creation/);
  assert.match(lifecycle, /POST \/api\/agenda\/sessions/);
});

test("the created talk is reported as created, with the row's own stored fields", () => {
  const post = postHandler();
  assert.match(post, /return ok\(created, 201\)/);
  // The response carries what the confirmation copy names, read back from the
  // written row rather than echoed from the request.
  assert.match(post, /select: \{ id: true, title: true, durationMinutes: true, contentStatus: true \}/);
});
