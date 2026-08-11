import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildCalendarInviteRequest,
  CALENDAR_INVITE_CONTENT_TYPE,
  CALENDAR_INVITE_MAX_SELECTED_RECIPIENTS,
  CALENDAR_INVITE_TEMPLATE_KEY,
  calendarInviteRequestSchema,
  calendarInviteSequence,
  calendarInviteUid,
  inviteReadySpeakers,
  resolveInviteOrganizer,
  sendCalendarInvites,
  type CalendarInviteDb,
  type CalendarInviteSpeaker,
} from "./calendar-invites";
import { describeCalendarInviteResult } from "@/lib/operations/status";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** RFC 5545 folds lines past 75 octets; content assertions unfold first. */
const unfold = (ics: string) => ics.split("\r\n ").join("");

const ORGANIZER = { email: "hello@greenroom-hq.com", name: "Forward 2026 Programme" };

const SESSION_ONE = {
  id: "session-1",
  title: "Analytical Engines",
  description: "A short session",
  startsAt: new Date("2026-05-12T09:00:00.000Z"),
  endsAt: new Date("2026-05-12T09:30:00.000Z"),
  roomName: "Hall A",
  calendarUpdatedAt: new Date("2026-04-20T12:00:00.000Z"),
};

const SESSION_TWO = {
  id: "session-2",
  title: "Difference Engines",
  description: null,
  startsAt: new Date("2026-05-13T10:00:00.000Z"),
  endsAt: new Date("2026-05-13T11:00:00.000Z"),
  roomName: "Hall B",
  calendarUpdatedAt: new Date("2026-04-21T08:00:00.000Z"),
};

const speaker = (overrides: Partial<CalendarInviteSpeaker> = {}): CalendarInviteSpeaker => ({
  userId: "speaker-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  sessions: [{ ...SESSION_ONE }],
  ...overrides,
});

const template = { id: "template-calendar-invite", subject: "Calendar invite: {{talkTitle}}", htmlBody: "<p>Hi {{speakerName}}, {{slotTime}} in {{roomName}}.</p>" };

function fakeDb() {
  const created: { templateId: string; recipient: string; variables: Record<string, string>; status: string }[] = [];
  const updated: { id: string; status: string }[] = [];
  const db = {
    emailDispatch: {
      create: async ({ data }: { data: { templateId: string; recipient: string; variables: Record<string, string>; status: string } }) => {
        created.push(data);
        return { id: `dispatch-${created.length}` };
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        updated.push({ id: where.id, status: data.status });
        return { id: where.id };
      },
    },
  } as unknown as CalendarInviteDb;
  return { db, created, updated };
}

test("an invitation carries the four properties a calendar client needs to treat it as one", () => {
  const invite = buildCalendarInviteRequest(speaker(), { eventName: "Forward 2026", organizer: ORGANIZER });
  assert.ok(invite);
  const ics = invite.content;

  // 1. REQUEST, on the calendar and on the MIME part.
  assert.ok(ics.includes("METHOD:REQUEST"));
  assert.equal(invite.contentType, CALENDAR_INVITE_CONTENT_TYPE);
  assert.ok(invite.contentType.includes("text/calendar"));
  assert.ok(invite.contentType.includes("method=REQUEST"));

  // 2. Somewhere for an RSVP to go.
  assert.ok(unfold(ics).includes("ORGANIZER;CN=Forward 2026 Programme:mailto:hello@greenroom-hq.com"), ics);

  // 3. The recipient, asked to answer.
  assert.ok(
    unfold(ics).includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ada Lovelace:mailto:ada@example.test"),
    ics,
  );

  // 4. A revision number, so a later send can supersede this one.
  assert.ok(ics.includes(`SEQUENCE:${calendarInviteSequence(SESSION_ONE.calendarUpdatedAt)}`));

  assert.ok(ics.includes("STATUS:CONFIRMED"));
  assert.ok(ics.includes("DTSTART:20260512T090000Z"));
  assert.ok(ics.includes("LOCATION:Hall A"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("the UID survives a schedule change, so a re-send updates the entry instead of duplicating it", () => {
  const before = buildCalendarInviteRequest(speaker(), { eventName: "Forward 2026", organizer: ORGANIZER });
  const moved = buildCalendarInviteRequest(
    speaker({
      sessions: [{
        ...SESSION_ONE,
        title: "Analytical Engines (revised)",
        startsAt: new Date("2026-05-12T14:00:00.000Z"),
        endsAt: new Date("2026-05-12T14:30:00.000Z"),
        roomName: "Hall C",
        calendarUpdatedAt: new Date("2026-04-25T09:00:00.000Z"),
      }],
    }),
    { eventName: "Forward 2026", organizer: ORGANIZER },
  );
  assert.ok(before && moved);

  const uid = `UID:${calendarInviteUid("session-1", "ada@example.test")}`;
  assert.ok(before.content.includes(uid));
  assert.ok(moved.content.includes(uid), "the moved session keeps the same UID");
  // ...and the client is told this copy is newer, or it may keep the old one.
  assert.ok(moved.content.includes("DTSTART:20260512T140000Z"));
  assert.ok(
    calendarInviteSequence(new Date("2026-04-25T09:00:00.000Z")) > calendarInviteSequence(SESSION_ONE.calendarUpdatedAt),
    "a later slot revision raises SEQUENCE",
  );
});

test("an unchanged invitation regenerates byte for byte, so a retry reuses one idempotency key", () => {
  const first = buildCalendarInviteRequest(speaker(), { eventName: "Forward 2026", organizer: ORGANIZER });
  const second = buildCalendarInviteRequest(speaker(), { eventName: "Forward 2026", organizer: ORGANIZER });
  assert.equal(first?.content, second?.content);
  assert.equal(first?.filename, "forward-2026-calendar-invite.ics");
});

test("the UID is per speaker as well as per session, so two co-speakers RSVP independently", () => {
  const ada = calendarInviteUid("session-1", "ada@example.test");
  const grace = calendarInviteUid("session-1", "grace@example.test");
  assert.notEqual(ada, grace);
  // Case and padding in a stored address must not fork the identity.
  assert.equal(ada, calendarInviteUid("session-1", "  Ada@Example.test "));
  // And it is not the public export's UID for the same talk.
  assert.notEqual(ada, "session-1@greenroom");
});

test("a speaker with several talks gets one calendar holding one VEVENT per session", () => {
  const invite = buildCalendarInviteRequest(
    speaker({ sessions: [{ ...SESSION_TWO }, { ...SESSION_ONE }] }),
    { eventName: "Forward 2026", organizer: ORGANIZER },
  );
  assert.ok(invite);
  const ics = invite.content;

  assert.equal(ics.match(/BEGIN:VCALENDAR/g)?.length, 1);
  assert.equal(ics.match(/METHOD:REQUEST/g)?.length, 1);
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.equal(ics.match(/END:VEVENT/g)?.length, 2);
  // Each VEVENT keeps its own per-session UID, so the client can revise one
  // talk without touching the other.
  assert.ok(ics.includes(`UID:${calendarInviteUid("session-1", "ada@example.test")}`));
  assert.ok(ics.includes(`UID:${calendarInviteUid("session-2", "ada@example.test")}`));
  assert.equal(ics.match(/ATTENDEE;/g)?.length, 2, "every VEVENT names the recipient");
  // Chronological regardless of the order the rows arrived in.
  assert.ok(ics.indexOf("DTSTART:20260512T090000Z") < ics.indexOf("DTSTART:20260513T100000Z"));
});

test("SEQUENCE falls back to zero rather than inventing a revision", () => {
  assert.equal(calendarInviteSequence(null), 0);
  assert.equal(calendarInviteSequence(undefined), 0);
  assert.equal(calendarInviteSequence(new Date("not a date")), 0);
  // Anything before the epoch this counts from clamps rather than going negative.
  assert.equal(calendarInviteSequence(new Date("2019-01-01T00:00:00.000Z")), 0);
  assert.ok(calendarInviteSequence(new Date("2026-04-20T12:00:00.000Z")) > 0);
});

test("the organizer is the configured sender, in either shape RESEND_FROM allows", () => {
  assert.deepEqual(resolveInviteOrganizer("Greenroom <hello@greenroom-hq.com>"), {
    email: "hello@greenroom-hq.com",
    name: "Greenroom",
  });
  assert.deepEqual(resolveInviteOrganizer("hello@greenroom-hq.com"), {
    email: "hello@greenroom-hq.com",
    name: null,
  });
  // No sender configured: a well-formed placeholder from the app's own host.
  // These are exactly the deployments where delivery is mocked anyway.
  assert.deepEqual(resolveInviteOrganizer(undefined, "https://greenroom.example/"), {
    email: "no-reply@greenroom.example",
    name: null,
  });
  assert.deepEqual(resolveInviteOrganizer(undefined, "not a url"), {
    email: "no-reply@greenroom.invalid",
    name: null,
  });
});

test("a speaker with nothing scheduled is never sent an empty calendar", async () => {
  const unscheduled = speaker({
    sessions: [{ id: "session-9", title: "Unscheduled", description: null, startsAt: null, endsAt: null, roomName: null }],
  });

  assert.equal(buildCalendarInviteRequest(unscheduled, { eventName: "Forward 2026", organizer: ORGANIZER }), null);
  assert.deepEqual(inviteReadySpeakers([unscheduled]), []);
  assert.deepEqual(inviteReadySpeakers([speaker(), unscheduled]).map((s) => s.userId), ["speaker-1"]);

  const { db, created } = fakeDb();
  const summary = await sendCalendarInvites(db, {
    template,
    speakers: [unscheduled],
    eventName: "Forward 2026",
    timeZone: "America/Los_Angeles",
    organizer: ORGANIZER,
  });

  assert.deepEqual(summary, { recipientCount: 0, sessionCount: 0, sent: 0, mocked: 0, failed: 0 });
  assert.deepEqual(created, [], "no dispatch row is written for a speaker with nothing to invite");
  assert.equal(
    describeCalendarInviteResult(summary).headline,
    "Nobody is scheduled yet — no calendar invites were sent.",
  );
});

test("every recipient gets one dispatch row, written before delivery and named honestly", async () => {
  const { db, created, updated } = fakeDb();
  let providerCalled = false;

  const summary = await sendCalendarInvites(db, {
    template,
    speakers: [
      speaker(),
      speaker({ userId: "speaker-2", name: "Grace Hopper", email: "grace@example.test", sessions: [{ ...SESSION_ONE }, { ...SESSION_TWO }] }),
    ],
    eventName: "Forward 2026",
    timeZone: "America/Los_Angeles",
    organizer: ORGANIZER,
    senderId: "admin-1",
    fetcher: async () => {
      providerCalled = true;
      return new Response(JSON.stringify({ id: "must-not-call" }), { status: 200 });
    },
  });

  // Mock mode is the default for this environment: recorded, never delivered.
  assert.deepEqual(summary, { recipientCount: 2, sessionCount: 3, sent: 0, mocked: 2, failed: 0 });
  assert.equal(providerCalled, false, "the mock branch must not reach a provider");

  assert.equal(created.length, 2);
  assert.deepEqual(created.map((row) => row.recipient), ["ada@example.test", "grace@example.test"]);
  for (const row of created) {
    assert.equal(row.templateId, template.id);
    // Written first, so a crash mid-flight leaves evidence rather than silence.
    assert.equal(row.status, "queued");
    // The distinct kind is what lets the email log tell an invitation from a
    // reminder without adding a column.
    assert.equal(row.variables.kind, "calendar-invite");
  }
  assert.equal(created[0].variables.sessionCount, "1");
  assert.equal(created[1].variables.sessionCount, "2");
  assert.deepEqual(updated.map((row) => row.status), ["mocked", "mocked"]);

  assert.equal(
    describeCalendarInviteResult(summary).headline,
    "Demo mode: 2 speakers would have received a calendar invite covering 3 sessions. Nothing was actually sent.",
  );
});

test("a live send hands the provider a text/calendar REQUEST part, not a bare file", async () => {
  const previous = {
    mock: process.env.MOCK_EXTERNAL_APIS,
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
  };
  process.env.MOCK_EXTERNAL_APIS = "false";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Greenroom <hello@greenroom-hq.com>";

  try {
    const { db, updated } = fakeDb();
    let body: { attachments?: { filename: string; content_type?: string; content: string }[] } | null = null;

    const summary = await sendCalendarInvites(db, {
      template,
      speakers: [speaker()],
      eventName: "Forward 2026",
      timeZone: "America/Los_Angeles",
      organizer: ORGANIZER,
      fetcher: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "provider-1" }), { status: 200 });
      },
    });

    assert.deepEqual(summary, { recipientCount: 1, sessionCount: 1, sent: 1, mocked: 0, failed: 0 });
    assert.deepEqual(updated.map((row) => row.status), ["sent"]);

    const attachment = body!.attachments?.[0];
    assert.ok(attachment);
    assert.equal(attachment.filename, "forward-2026-calendar-invite.ics");
    // Resend's own field name; without it the part is guessed from the filename
    // and loses `method=REQUEST`, which is what makes it an invitation.
    assert.equal(attachment.content_type, CALENDAR_INVITE_CONTENT_TYPE);
    assert.ok(Buffer.from(attachment.content, "base64").toString("utf8").includes("METHOD:REQUEST"));
  } finally {
    process.env.MOCK_EXTERNAL_APIS = previous.mock;
    if (previous.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous.key;
    if (previous.from === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = previous.from;
  }
});

test("the request contract bounds and de-duplicates the recipients an operator may name", () => {
  assert.equal(calendarInviteRequestSchema.safeParse({ eventId: "event-1" }).success, true);

  const duplicate = calendarInviteRequestSchema.safeParse({
    eventId: "event-1",
    recipientUserIds: ["speaker-1", "speaker-1"],
  });
  assert.equal(duplicate.success, false);

  const oversize = calendarInviteRequestSchema.safeParse({
    eventId: "event-1",
    recipientUserIds: Array.from({ length: CALENDAR_INVITE_MAX_SELECTED_RECIPIENTS + 1 }, (_, i) => `speaker-${i}`),
  });
  assert.equal(oversize.success, false);
  assert.equal(CALENDAR_INVITE_MAX_SELECTED_RECIPIENTS, 100);

  assert.equal(calendarInviteRequestSchema.safeParse({ recipientUserIds: ["speaker-1"] }).success, false);
});

/**
 * The route cannot be executed by this runner, so its authorization, scoping
 * and refusal contract is asserted against the source it actually ships.
 */
test("the calendar-invite route is admin-only, event-scoped and bounded", () => {
  const route = source("app/api/comms/calendar-invites/route.ts");

  assert.match(route, /requireContext\(\["ADMIN"\]\)/);
  assert.match(route, /assertEventScope\(ctx, input\.eventId\)/);
  // Scope comes from the session, never from the body.
  assert.match(route, /eventId: ctx\.eventId/);
  assert.doesNotMatch(route, /eventId: input\.eventId/);

  // Authorization is resolved before the body is trusted for anything.
  assert.ok(route.indexOf("requireContext") < route.indexOf("parseBody"));
  assert.ok(route.indexOf("assertEventScope") < route.indexOf("prisma.sessionSpeaker.findMany"));

  assert.match(route, /take: OPERATOR_QUERY_LIMITS\.reminderSessionSpeakers \+ 1/);
  assert.match(route, /assertEventQueryBound\(/);
});

test("the route invites only published, scheduled speakers and refuses honestly when there are none", () => {
  const route = source("app/api/comms/calendar-invites/route.ts");

  assert.match(route, /contentStatus: "PUBLISHED"/);
  assert.match(route, /scheduleSlot: \{ isNot: null \}/);
  // Validation refusals are 422, never 400.
  assert.match(route, /new ApiError\(\s*422,\s*"NO_SCHEDULED_SPEAKERS"/);
  assert.match(route, /422, "RECIPIENT_NOT_ELIGIBLE"/);
  assert.doesNotMatch(route, /new ApiError\(400/);

  // The eligible-recipient rule is reused, not reimplemented.
  assert.match(route, /selectEligibleSpeakers\(\[\.\.\.grouped\.values\(\)\], input\.recipientUserIds\)/);
  assert.match(route, /orderReminderSessions\(speaker\.sessions\)/);
});

test("the route sends through the one audited transport and logs to its own template", () => {
  const route = source("app/api/comms/calendar-invites/route.ts");

  assert.match(route, /sendCalendarInvites\(prisma, \{/);
  // No second transport: nothing here may call a provider directly.
  assert.doesNotMatch(route, /api\.resend\.com/);
  assert.doesNotMatch(route, /deliverEmail\(/);

  assert.match(route, /prisma\.emailTemplate\.upsert\(/);
  assert.match(route, /key: CALENDAR_INVITE_TEMPLATE_KEY/);
  assert.equal(CALENDAR_INVITE_TEMPLATE_KEY, "calendar-invite");
  // Same mock/live decision the reminders route and the console make.
  assert.match(route, /canDeliverEmail\(\{/);
  assert.match(route, /mocked: useMockIntegrations\(\)/);

  const service = source("lib/comms/calendar-invites.ts");
  assert.match(service, /dispatchEmail\(db, \{/);
  assert.doesNotMatch(service, /api\.resend\.com/);
});

test("the operations console offers the invites beside the reminders, with an honest empty state", () => {
  const page = source("app/(app)/admin/operations/page.tsx");
  assert.match(page, /<CalendarInvitesPanel/);
  // The count the operator confirms comes from the route's own predicate.
  assert.match(page, /contentStatus: "PUBLISHED", scheduleSlot: \{ isNot: null \}/);

  const panel = source("app/(app)/admin/operations/calendar-invites-panel.tsx");
  assert.match(panel, /fetch\("\/api\/comms\/calendar-invites"/);
  assert.match(panel, /describeCalendarInviteResult\(body\.data\)/);
  // Confirm before a bulk send.
  assert.match(panel, /confirming \? \(/);
  assert.match(panel, /speakerCount === 0 \? \(/);
  assert.match(panel, /No speaker has a published, scheduled session yet/);
});
