import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCoSpeakerNotice,
  buildDecisionEmail,
  buildSubmissionAlert,
  buildSubmissionReceipt,
} from "./notifications";
import { canDeliverEmail, deliverEmail, logicalEmailIdempotencyKey } from "./send";

const speaker = { name: "Sofia Marques", email: "sofia@example.test" };
const event = "Forward 2026";

test("the submission receipt promises only what the product does", () => {
  const mail = buildSubmissionReceipt({ eventName: event, speaker, title: "Scaling Vector Search", coSpeakers: [] });
  assert.match(mail.subject, /received your proposal/i);
  assert.match(mail.html, /Scaling Vector Search/);
  // Public submitters have no account, so the email must not promise a portal.
  assert.doesNotMatch(mail.html, /portal|log ?in|sign ?in/i);
});

test("co-speakers are named in the receipt but the submitter is not listed as their own co-speaker", () => {
  const mail = buildSubmissionReceipt({
    eventName: event, speaker, title: "T",
    coSpeakers: [speaker, { name: "Ada Lovelace", email: "ada@example.test" }],
  });
  assert.match(mail.html, /Ada Lovelace/);
  assert.doesNotMatch(mail.html, /co-speakers know: Sofia/);
});

test("speaker-supplied text is escaped everywhere it lands in HTML", () => {
  const attack = '<img src=x onerror=alert(1)>';
  const receipt = buildSubmissionReceipt({ eventName: event, speaker: { name: attack, email: "a@b.c" }, title: attack, coSpeakers: [] });
  const alert = buildSubmissionAlert({ eventName: event, adminName: "Maya", title: attack, speakers: [speaker], categoryName: attack });
  const notice = buildCoSpeakerNotice({ eventName: event, coSpeaker: speaker, submitter: { name: attack, email: "a@b.c" }, title: "T" });
  for (const mail of [receipt, alert, notice]) {
    assert.doesNotMatch(mail.html, /<img/i);
    assert.match(mail.html, /&lt;img/);
  }
});

test("the decision email never leaks scores or reviewer identities", () => {
  const mail = buildDecisionEmail({
    eventName: event, speaker, title: "T", decision: "REJECTED",
    feedback: [{ comment: "Needs a sharper takeaway." }, { comment: "Great topic, thin on evidence." }],
  });
  assert.match(mail.html, /Needs a sharper takeaway\./);
  assert.match(mail.html, /Great topic, thin on evidence\./);
  assert.doesNotMatch(mail.html, /\b\d(\.\d)?\s*\/\s*5\b/);
  assert.doesNotMatch(mail.html, /reviewer \w+|evaluator/i);
});

test("acceptance and rejection read differently and both stay kind", () => {
  const accepted = buildDecisionEmail({ eventName: event, speaker, title: "T", decision: "ACCEPTED" });
  assert.match(accepted.subject, /accepted/i);
  assert.match(accepted.html, /accepted for Forward 2026/);

  const rejected = buildDecisionEmail({ eventName: event, speaker, title: "T", decision: "REJECTED" });
  assert.doesNotMatch(rejected.subject, /reject/i);
  assert.match(rejected.html, /welcome a proposal from you next time/);
});

test("empty feedback produces no empty feedback section", () => {
  const mail = buildDecisionEmail({
    eventName: event, speaker, title: "T", decision: "ACCEPTED",
    feedback: [{ comment: "   " }, { comment: "" }],
  });
  assert.doesNotMatch(mail.html, /Notes from the review team/);
  assert.doesNotMatch(mail.html, /<ul>/);
});

test("an admin's personal note keeps basic formatting but cannot inject script", () => {
  const mail = buildDecisionEmail({
    eventName: event, speaker, title: "T", decision: "ACCEPTED",
    personalNote: "<p>We loved this — <strong>please</strong> submit again.</p><script>alert(1)</script>",
  });
  assert.match(mail.html, /<strong>please<\/strong>/);
  assert.doesNotMatch(mail.html, /script/i);
});

test("delivery is refused unless the deployment is genuinely configured", () => {
  assert.equal(canDeliverEmail({ mocked: false, apiKey: "re_x", from: "a@b.c" }), true);
  assert.equal(canDeliverEmail({ mocked: true, apiKey: "re_x", from: "a@b.c" }), false);
  assert.equal(canDeliverEmail({ mocked: false, apiKey: undefined, from: "a@b.c" }), false);
  assert.equal(canDeliverEmail({ mocked: false, apiKey: "re_x", from: undefined }), false);
});

test("an unconfigured deployment records a mock instead of calling the provider", async () => {
  let called = false;
  const outcome = await deliverEmail(
    { to: "a@b.c", subject: "s", html: "<p>h</p>" },
    { mocked: true, apiKey: "re_x", from: "a@b.c", idempotencyKey: "k", fetcher: async () => { called = true; return new Response("{}"); } },
  );
  assert.deepEqual(outcome, { status: "mocked" });
  assert.equal(called, false);
});

test("a live send carries the idempotency key and the sender identity", async () => {
  let seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
  const outcome = await deliverEmail(
    { to: "a@b.c", subject: "s", html: "<p>h</p>", attachments: [{ filename: "invite.ics", content: "BEGIN:VCALENDAR" }] },
    {
      mocked: false, apiKey: "re_x", from: "Greenroom <a@b.c>", idempotencyKey: "greenroom-d1",
      fetcher: async (url, init) => {
        seen = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
      },
    },
  );
  assert.deepEqual(outcome, { status: "sent", providerId: "resend-1" });
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.headers?.["Idempotency-Key"], "greenroom-d1");
  assert.equal((seen.body as { from: string }).from, "Greenroom <a@b.c>");
  // Attachments are base64 for the provider, not raw text.
  const attachment = (seen.body as { attachments: { content: string }[] }).attachments[0];
  assert.equal(Buffer.from(attachment.content, "base64").toString("utf8"), "BEGIN:VCALENDAR");
});

test("logical email idempotency survives retries and changes with rendered content", () => {
  const input = {
    templateId: "template-1",
    message: { to: "Speaker@Example.test", subject: "Decision", html: "<p>Accepted</p>" },
    variables: { decision: "ACCEPTED", abstractId: "abstract-1" },
  };
  const first = logicalEmailIdempotencyKey(input, "Greenroom <hello@example.test>");
  const reordered = logicalEmailIdempotencyKey({
    ...input,
    variables: { abstractId: "abstract-1", decision: "ACCEPTED" },
  }, "Greenroom <hello@example.test>");
  assert.equal(first, reordered);
  assert.match(first, /^greenroom-[a-f0-9]{64}$/);
  assert.notEqual(first, logicalEmailIdempotencyKey({
    ...input,
    message: { ...input.message, html: "<p>Rejected</p>" },
  }, "Greenroom <hello@example.test>"));
  assert.notEqual(first, logicalEmailIdempotencyKey(input, "Another sender <hello@example.test>"));
});

test("provider failures come back as outcomes, never as throws", async () => {
  const rejected = await deliverEmail({ to: "a@b.c", subject: "s", html: "h" }, {
    mocked: false, apiKey: "re_x", from: "a@b.c", idempotencyKey: "k",
    fetcher: async () => new Response(JSON.stringify({ message: "Domain is not verified." }), { status: 403 }),
  });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error ?? "", /Domain is not verified/);

  const networkDown = await deliverEmail({ to: "a@b.c", subject: "s", html: "h" }, {
    mocked: false, apiKey: "re_x", from: "a@b.c", idempotencyKey: "k",
    fetcher: async () => { throw new Error("socket hang up"); },
  });
  assert.equal(networkDown.status, "failed");
  assert.match(networkDown.error ?? "", /socket hang up/);

  // A 200 with no id is still a failure — Resend answers that way on some errors.
  const noId = await deliverEmail({ to: "a@b.c", subject: "s", html: "h" }, {
    mocked: false, apiKey: "re_x", from: "a@b.c", idempotencyKey: "k",
    fetcher: async () => new Response("{}", { status: 200 }),
  });
  assert.equal(noId.status, "failed");
});
