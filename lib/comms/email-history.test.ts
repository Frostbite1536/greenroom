import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_INTENTIONALLY_UNPROJECTED_FIELDS,
  EMAIL_HISTORY_CAP,
  EMAIL_HISTORY_TAKE,
  describeEmailDispatchStatus,
  emailHistoryOrderBy,
  emailHistorySelect,
  emailHistoryWhere,
  toEmailHistory,
  toEmailHistoryEntry,
  type EmailDispatchRow,
} from "./email-history";

function row(overrides: Partial<EmailDispatchRow> = {}): EmailDispatchRow {
  return {
    id: "dispatch-1",
    recipient: "speaker@example.test",
    status: "sent",
    error: null,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    sentAt: new Date("2026-05-01T10:00:01.000Z"),
    template: { key: "cfp.submitted", subject: "Thanks for your proposal", trigger: "cfp.submitted" },
    sender: { name: "Ada Organizer" },
    ...overrides,
  };
}

test("dispatch scoping traverses the template parent, the only event link the row has", () => {
  // EmailDispatch carries no eventId. Scoping by recipient or sender would pull
  // in another event's mail for the same person (INV-EVENT-001).
  assert.deepEqual(emailHistoryWhere("evt-1"), { template: { eventId: "evt-1" } });
});

test("the log is newest first with a tiebreaker so a bulk send has one stable order", () => {
  assert.deepEqual(emailHistoryOrderBy, [{ createdAt: "desc" }, { id: "desc" }]);
});

test("the read is cap-plus-one so truncation is observed, not guessed", () => {
  assert.equal(EMAIL_HISTORY_CAP, 100);
  assert.equal(EMAIL_HISTORY_TAKE, EMAIL_HISTORY_CAP + 1);
});

test("the projection excludes provider handles and the operator-supplied variable bag", () => {
  const selected = Object.keys(emailHistorySelect).sort();
  assert.deepEqual(selected, ["createdAt", "error", "id", "recipient", "sender", "sentAt", "status", "template"]);
  for (const field of EMAIL_INTENTIONALLY_UNPROJECTED_FIELDS) {
    assert.equal(field in emailHistorySelect, false, `${field} must never reach the panel`);
  }
  // The template parent contributes identification only — never its rendered body.
  assert.deepEqual(Object.keys(emailHistorySelect.template.select).sort(), ["key", "subject", "trigger"]);
  assert.deepEqual(Object.keys(emailHistorySelect.sender.select), ["name"]);
});

test("a projected entry carries no provider credential, bearer, or payload key", () => {
  const serialized = JSON.stringify(toEmailHistoryEntry(row()));
  for (const forbidden of ["providerId", "variables", "apiKey", "Bearer", "re_", "htmlBody"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into the panel projection`);
  }
});

test("a mocked attempt is never rendered as delivered even though it carries a sentAt", () => {
  // dispatchEmail stamps sentAt for mocked sends, so a timestamp cannot be the
  // delivery signal — only the status can be.
  const entry = toEmailHistoryEntry(row({ status: "mocked", sentAt: new Date("2026-05-01T10:00:01.000Z") }));
  assert.equal(entry.delivered, false);
  assert.equal(entry.attemptCompletedAt, "2026-05-01T10:00:01.000Z");
  assert.equal(entry.statusLabel.includes("not delivered"), true);
  assert.equal(/\bDelivered\b/.test(entry.statusLabel), false);
  assert.equal(entry.statusTone, "warn");
});

test("only a provider-accepted send is reported as delivered", () => {
  assert.equal(describeEmailDispatchStatus("sent", null).delivered, true);
  for (const status of ["mocked", "failed", "queued", "something-new"]) {
    assert.equal(describeEmailDispatchStatus(status, null).delivered, false, status);
  }
});

test("a failure surfaces the stored reason so a bulk send's failed count is actionable", () => {
  const entry = toEmailHistoryEntry(row({ status: "failed", error: "Recipient domain not found.", sentAt: null }));
  assert.equal(entry.outcome, "Recipient domain not found.");
  assert.equal(entry.statusTone, "bad");
  assert.equal(entry.attemptCompletedAt, null);
});

test("a failure with no stored reason says so instead of inventing one", () => {
  const blank = describeEmailDispatchStatus("failed", "   ");
  assert.equal(blank.detail, "The provider rejected this message and recorded no reason.");
  assert.equal(describeEmailDispatchStatus("failed", null).detail, blank.detail);
});

test("a row still queued is reported as unfinished rather than in flight forever", () => {
  const queued = describeEmailDispatchStatus("queued", null);
  assert.equal(queued.delivered, false);
  assert.equal(queued.detail.includes("undelivered"), true);
});

test("an oversize log renders one capped page and admits what it withheld", () => {
  const rows = Array.from({ length: EMAIL_HISTORY_CAP + 1 }, (_, index) =>
    row({ id: `dispatch-${index}`, status: index === 0 ? "failed" : "mocked", error: index === 0 ? "boom" : null }),
  );
  const history = toEmailHistory(rows);
  assert.equal(history.entries.length, EMAIL_HISTORY_CAP);
  assert.equal(history.shown, EMAIL_HISTORY_CAP);
  assert.equal(history.truncated, true);
  assert.equal(history.entries.at(-1)?.id, `dispatch-${EMAIL_HISTORY_CAP - 1}`);
});

test("a log inside the cap reports itself complete and counts only what it shows", () => {
  const history = toEmailHistory([
    row({ id: "a", status: "sent" }),
    row({ id: "b", status: "mocked" }),
    row({ id: "c", status: "failed", error: "no mailbox" }),
  ]);
  assert.equal(history.truncated, false);
  assert.equal(history.shown, 3);
  assert.equal(history.shownDelivered, 1);
  assert.equal(history.shownUndelivered, 2);
  assert.equal(history.shownFailed, 1);
});

test("an empty log is an empty page, not a truncated one", () => {
  const history = toEmailHistory([]);
  assert.deepEqual(history.entries, []);
  assert.equal(history.truncated, false);
  assert.equal(history.shown, 0);
});

test("the page states no volume it did not read from its own single query", () => {
  // Regression guard for the dropped `count()`: the panel used to pair this
  // read with an independently-snapshotted total, so a dispatch inserted
  // between the two could make the header contradict the rows below it. There
  // is now no field that can disagree with `entries`.
  const history = toEmailHistory([row({ id: "a", status: "sent" }), row({ id: "b", status: "failed", error: "bounced" })]);
  assert.equal("total" in history, false);
  assert.equal(history.shown, history.entries.length);
  assert.equal(history.shownDelivered + history.shownUndelivered, history.entries.length);
  assert.equal(history.shownFailed <= history.shownUndelivered, true);

  // Truncated: `shown` is the page size, never advertised as an event total.
  const capped = toEmailHistory(Array.from({ length: EMAIL_HISTORY_CAP + 1 }, (_, i) => row({ id: `d-${i}` })));
  assert.equal(capped.shown, capped.entries.length);
  assert.equal(capped.shown, capped.cap);
});
