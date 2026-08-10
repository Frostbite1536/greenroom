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

/**
 * C21 (audit4#30): the operator console says editing `cfp-submitted` changes
 * the receipt, so the send must really render that stored row. The dispatch
 * records which wording produced the message, which is what these assert.
 */
type ReceiptTemplateRow = { id: string; subject?: string; htmlBody?: string } | null;

function receiptDb(templates: { dedicated: ReceiptTemplateRow; fallback: ReceiptTemplateRow }) {
  const variables: Record<string, string>[] = [];
  const db = {
    abstract: {
      findUnique: async () => ({
        id: "abstract-1",
        title: "Scaling Vector Search",
        status: "SUBMITTED",
        eventId: "event-1",
        event: { name: "Forward 2026" },
        submitter: { name: "Sofia Marques", email: "primary@example.test" },
      }),
    },
    emailTemplate: {
      findUnique: async () => templates.dedicated,
      findFirst: async () => templates.fallback,
    },
    emailDispatch: {
      create: async ({ data }: { data: { variables: Record<string, string> } }) => {
        variables.push(data.variables);
        return { id: `dispatch-${variables.length}` };
      },
      update: async () => ({ id: "dispatch-1" }),
    },
  } as unknown as SubmissionNotificationDb;
  return { db, variables };
}

test("the stored cfp-submitted template is what the receipt is rendered from", async () => {
  const { db, variables } = receiptDb({
    dedicated: {
      id: "template-submitted",
      subject: "We received {{talkTitle}}",
      htmlBody: "<p>Hi {{speakerName}}, thanks for {{talkTitle}}.</p>",
    },
    fallback: null,
  });

  const summary = await notifyAbstractSubmitted("abstract-1", { db });

  assert.deepEqual(summary, { attempted: 1, sent: 0, mocked: 1, failed: 0 });
  assert.equal(variables[0]?.source, "template");
});

test("a legacy event without the dedicated key keeps fixed receipt copy, never another template's words", async () => {
  // The fallback row exists only to satisfy the dispatch foreign key. Rendering
  // from it could mail an acceptance notice to someone who merely submitted.
  const { db, variables } = receiptDb({
    dedicated: null,
    fallback: {
      id: "template-accepted",
      subject: "Your talk was accepted 🎉",
      htmlBody: "<p>Great news — you're in!</p>",
    },
  });

  const summary = await notifyAbstractSubmitted("abstract-1", { db });

  assert.deepEqual(summary, { attempted: 1, sent: 0, mocked: 1, failed: 0 });
  assert.equal(variables[0]?.source, "fixed");
});

test("a dedicated receipt row with empty wording falls back rather than mailing a blank receipt", async () => {
  const { db, variables } = receiptDb({
    dedicated: { id: "template-submitted", subject: "   ", htmlBody: "   " },
    fallback: null,
  });

  const summary = await notifyAbstractSubmitted("abstract-1", { db });

  assert.deepEqual(summary, { attempted: 1, sent: 0, mocked: 1, failed: 0 });
  assert.equal(variables[0]?.source, "fixed");
});
