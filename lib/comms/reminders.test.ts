import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpeakerCalendarInvite,
  reminderRequestSchema,
  renderEmailTemplate,
  selectEligibleSpeakers,
  type EligibleSpeaker,
} from "./reminders";

const speaker: EligibleSpeaker = {
  userId: "speaker-1",
  name: "Ada <Lovelace>",
  email: "ada@example.test",
  openTasks: 2,
  sessions: [{
    id: "session-1",
    title: "Analytical Engines",
    description: "A short session",
    startsAt: new Date("2026-05-12T09:00:00.000Z"),
    endsAt: new Date("2026-05-12T09:30:00.000Z"),
    roomName: "Hall A",
  }],
};

test("reminder input rejects duplicate or malformed selected recipients", () => {
  const duplicate = reminderRequestSchema.safeParse({
    eventId: "event-1", templateKey: "task-reminder", recipientUserIds: ["speaker-1", "speaker-1"],
  });
  assert.equal(duplicate.success, false);

  const invalidVariable = reminderRequestSchema.safeParse({
    eventId: "event-1", templateKey: "task-reminder", variables: { "bad-key": "value" },
  });
  assert.equal(invalidVariable.success, false);
});

test("selected recipients must belong to the event's eligible speaker set", () => {
  const result = selectEligibleSpeakers([speaker], ["speaker-1", "other-event-speaker"]);
  assert.deepEqual(result.recipients, [speaker]);
  assert.deepEqual(result.invalidUserIds, ["other-event-speaker"]);
});

test("rendering sanitizes authored HTML and escapes runtime variables", () => {
  const rendered = renderEmailTemplate(
    { subject: "Hello {{speakerName}}\r\nBcc: no@example.test", htmlBody: "<script>bad()</script><p>Hello {{speakerName}}</p>" },
    { speakerName: "Ada <Lovelace>" },
  );
  assert.equal(rendered.subject, "Hello Ada <Lovelace> Bcc: no@example.test");
  assert.equal(rendered.html, "<p>Hello Ada &lt;Lovelace&gt;</p>");
});

test("calendar invitation uses RFC 5545 REQUEST semantics", () => {
  const invite = buildSpeakerCalendarInvite(speaker, "Forward 2026", "https://greenroom.example");
  assert.ok(invite);
  assert.equal(invite?.filename, "forward-2026-invite.ics");
  assert.ok(invite?.content.includes("METHOD:REQUEST"));
  assert.ok(invite?.content.includes("UID:session-1@greenroom"));
});
