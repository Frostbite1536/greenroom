import assert from "node:assert/strict";
import test from "node:test";
import { notifyAbstractSubmitted, type SubmissionNotificationDb } from "./notify-service";

test("a public submission records one mocked receipt only for Abstract.submitter", async () => {
  const dispatched: { recipient: string }[] = [];
  let providerCalled = false;
  const db = {
    abstract: {
      findUnique: async () => ({
        id: "abstract-1",
        title: "Untrusted roster",
        status: "SUBMITTED",
        eventId: "event-1",
        event: { name: "Forward 2026" },
        submitter: { name: "Primary", email: "primary@example.test" },
      }),
    },
    emailTemplate: {
      findUnique: async () => ({ id: "template-1" }),
      findFirst: async () => ({ id: "template-1" }),
    },
    emailDispatch: {
      create: async ({ data }: { data: { recipient: string } }) => {
        dispatched.push({ recipient: data.recipient });
        return { id: `dispatch-${dispatched.length}` };
      },
      update: async () => ({ id: "dispatch-1" }),
    },
  } as unknown as SubmissionNotificationDb;

  const summary = await notifyAbstractSubmitted("abstract-1", {
    db,
    fetcher: async () => {
      providerCalled = true;
      return new Response(JSON.stringify({ id: "must-not-call" }), { status: 200 });
    },
  });

  assert.deepEqual(summary, { attempted: 1, sent: 0, mocked: 1, failed: 0 });
  assert.deepEqual(dispatched, [{ recipient: "primary@example.test" }]);
  assert.equal(providerCalled, false);
});
