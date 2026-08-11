import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_DISPATCH_STATUSES,
  EMAIL_DISPATCH_STATUS_META,
  EMAIL_HISTORY_MAX_PAGE,
  EMAIL_HISTORY_PAGE_SIZE,
  EMAIL_HISTORY_PAGE_TAKE,
  EMAIL_HISTORY_PARAMS,
  EMAIL_HISTORY_PATH,
  EMAIL_INTENTIONALLY_UNPROJECTED_FIELDS,
  EMAIL_RECIPIENT_SEARCH_MAX_LENGTH,
  EMAIL_STATUS_ALL,
  EMAIL_STATUS_FILTERS,
  clampEmailHistoryPage,
  describeEmailDispatchStatus,
  emailHistoryEmptyState,
  emailHistoryHref,
  emailHistoryIsFiltered,
  emailHistoryOrderBy,
  emailHistoryPageHref,
  emailHistoryRangeLabel,
  emailHistorySelect,
  emailHistorySkip,
  emailHistoryStatusHref,
  emailHistoryWhere,
  parseEmailHistoryPage,
  parseEmailHistoryQuery,
  parseEmailRecipientQuery,
  parseEmailStatusFilter,
  parseEmailTemplateFilter,
  toEmailHistoryEntry,
  toEmailHistoryPage,
  type EmailDispatchRow,
  type EmailHistoryQuery,
} from "./email-history";

const TEMPLATE_KEYS = ["cfp.submitted", "decision.accepted", "speaker.reminder"];

function view(overrides: Partial<EmailHistoryQuery> = {}): EmailHistoryQuery {
  return { status: EMAIL_STATUS_ALL, template: null, query: "", page: 1, ...overrides };
}

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

test("the read is page-plus-one so a next page is observed, not guessed", () => {
  assert.equal(EMAIL_HISTORY_PAGE_SIZE, 50);
  assert.equal(EMAIL_HISTORY_PAGE_TAKE, EMAIL_HISTORY_PAGE_SIZE + 1);
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

test("an oversize view renders one page and says another follows, never how many", () => {
  const rows = Array.from({ length: EMAIL_HISTORY_PAGE_SIZE + 1 }, (_, index) =>
    row({ id: `dispatch-${index}`, status: index === 0 ? "failed" : "mocked", error: index === 0 ? "boom" : null }),
  );
  const page = toEmailHistoryPage(rows, 1);
  assert.equal(page.entries.length, EMAIL_HISTORY_PAGE_SIZE);
  assert.equal(page.shown, EMAIL_HISTORY_PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.equal(page.hasPrevious, false);
  // The extra probe row is never rendered.
  assert.equal(page.entries.at(-1)?.id, `dispatch-${EMAIL_HISTORY_PAGE_SIZE - 1}`);
  // No page count, because no total was read.
  assert.equal("total" in page, false);
  assert.equal("pages" in page, false);
});

test("a page inside the view reports no next page and counts only what it shows", () => {
  const page = toEmailHistoryPage([
    row({ id: "a", status: "sent" }),
    row({ id: "b", status: "mocked" }),
    row({ id: "c", status: "failed", error: "no mailbox" }),
  ], 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.shown, 3);
  assert.equal(page.shownDelivered, 1);
  assert.equal(page.shownUndelivered, 2);
  assert.equal(page.shownFailed, 1);
  assert.equal(page.firstShown, 1);
  assert.equal(page.lastShown, 3);
});

test("a later page numbers its rows by its own offset, not from one again", () => {
  const page = toEmailHistoryPage([row({ id: "a" }), row({ id: "b" })], 3);
  assert.equal(page.page, 3);
  assert.equal(page.hasPrevious, true);
  assert.equal(page.hasMore, false);
  assert.equal(page.firstShown, 2 * EMAIL_HISTORY_PAGE_SIZE + 1);
  assert.equal(page.lastShown, 2 * EMAIL_HISTORY_PAGE_SIZE + 2);
});

test("an empty view is an empty page, and claims no position in it", () => {
  const first = toEmailHistoryPage([], 1);
  assert.deepEqual(first.entries, []);
  assert.equal(first.shown, 0);
  assert.equal(first.hasMore, false);
  assert.equal(first.hasPrevious, false);
  assert.equal(first.firstShown, 0);
  assert.equal(first.lastShown, 0);

  // Past the end of a real view: previous still exists, position still does not.
  const past = toEmailHistoryPage([], 4);
  assert.equal(past.hasPrevious, true);
  assert.equal(past.firstShown, 0);
  assert.equal(past.lastShown, 0);
});

test("the page states no volume it did not read from its own single query", () => {
  // Regression guard for the dropped `count()`: the panel used to pair this
  // read with an independently-snapshotted total, so a dispatch inserted
  // between the two could make the header contradict the rows below it. There
  // is now no field that can disagree with `entries` — and pagination did not
  // bring a total back in through a page count.
  const page = toEmailHistoryPage(
    [row({ id: "a", status: "sent" }), row({ id: "b", status: "failed", error: "bounced" })],
    1,
  );
  assert.equal("total" in page, false);
  assert.equal(page.shown, page.entries.length);
  assert.equal(page.shownDelivered + page.shownUndelivered, page.entries.length);
  assert.equal(page.shownFailed <= page.shownUndelivered, true);

  // Full page: `shown` is the page size, never advertised as any total.
  const full = toEmailHistoryPage(
    Array.from({ length: EMAIL_HISTORY_PAGE_TAKE }, (_, i) => row({ id: `d-${i}` })),
    1,
  );
  assert.equal(full.shown, full.entries.length);
  assert.equal(full.shown, full.pageSize);
});

test("the range line states a position in this view and never a total", () => {
  const empty = emailHistoryRangeLabel(toEmailHistoryPage([], 1));
  assert.equal(empty, "No emails in this view.");

  const one = emailHistoryRangeLabel(toEmailHistoryPage([row({ id: "a" })], 1));
  assert.match(one, /^Showing email 1 of this view, newest first/);
  assert.match(one, /the oldest email in this view is on this page\.$/);

  const more = emailHistoryRangeLabel(
    toEmailHistoryPage(Array.from({ length: EMAIL_HISTORY_PAGE_TAKE }, (_, i) => row({ id: `d-${i}` })), 2),
  );
  assert.match(more, /^Showing emails 51–100 of this view/);
  assert.match(more, /older ones continue on the next page\.$/);
  // No lifetime claim anywhere in the sentence.
  for (const label of [empty, one, more]) {
    assert.equal(/\bof \d+\b|\btotal\b|\bpage \d+ of\b/i.test(label), false, label);
  }
});

// ---- Filter, search and page composition ----------------------------------

test("every dispatch status has a chip, and every chip names a real status", () => {
  const values = EMAIL_STATUS_FILTERS.map((chip) => chip.value);
  assert.equal(values[0], EMAIL_STATUS_ALL, "the unfiltered chip comes first");
  assert.equal(new Set(values).size, values.length, "a repeated chip would filter twice");
  // The gap this closes is the abstracts one: a status that is stored, rendered
  // and reachable by no filter at all. `queued` is the live example — the
  // schema default, written before any attempt reports back.
  for (const status of EMAIL_DISPATCH_STATUSES) {
    assert.ok(values.includes(status), `${status} has no filter chip`);
  }
  // And the reverse: a chip naming no status is an equality test that can never
  // be true, which shows an empty table rather than failing.
  for (const value of values) {
    if (value === EMAIL_STATUS_ALL) continue;
    assert.ok(
      (EMAIL_DISPATCH_STATUSES as readonly string[]).includes(value),
      `${value} is not a stored status`,
    );
  }
  // The chip label must be the same vocabulary the row pill uses.
  for (const status of EMAIL_DISPATCH_STATUSES) {
    const chip = EMAIL_STATUS_FILTERS.find((candidate) => candidate.value === status);
    assert.equal(chip?.label, EMAIL_DISPATCH_STATUS_META[status].chipLabel);
  }
});

test("no chip label lets a mocked or unfinished attempt read as delivered", () => {
  for (const status of EMAIL_DISPATCH_STATUSES) {
    const meta = EMAIL_DISPATCH_STATUS_META[status];
    if (meta.delivered) continue;
    for (const label of [meta.label, meta.chipLabel, meta.emptyTitle]) {
      assert.equal(/\bdelivered\b/i.test(label) && !/not delivered/i.test(label), false, label);
    }
  }
  assert.equal(EMAIL_DISPATCH_STATUS_META.sent.delivered, true);
});

test("the status parameter accepts exactly the chip keys and falls back to All", () => {
  for (const chip of EMAIL_STATUS_FILTERS) {
    assert.equal(parseEmailStatusFilter(chip.value), chip.value);
  }
  assert.equal(parseEmailStatusFilter("  failed  "), "failed");
  for (const bogus of [undefined, "", "SENT", "delivered", "drop table", ["failed", "sent"]]) {
    assert.equal(parseEmailStatusFilter(bogus as string | string[] | undefined), EMAIL_STATUS_ALL, String(bogus));
  }
});

test("the template parameter is validated against keys this event actually has", () => {
  assert.equal(parseEmailTemplateFilter("cfp.submitted", TEMPLATE_KEYS), "cfp.submitted");
  assert.equal(parseEmailTemplateFilter(" cfp.submitted ", TEMPLATE_KEYS), "cfp.submitted");
  // An unknown key would render an empty table that reads as "this template
  // sent nothing" for a template that does not exist.
  assert.equal(parseEmailTemplateFilter("cfp.invented", TEMPLATE_KEYS), null);
  assert.equal(parseEmailTemplateFilter("cfp.submitted", []), null);
  assert.equal(parseEmailTemplateFilter(["cfp.submitted"], TEMPLATE_KEYS), null);
  assert.equal(parseEmailTemplateFilter(undefined, TEMPLATE_KEYS), null);
});

test("the recipient search is trimmed and bounded before it reaches a predicate", () => {
  assert.equal(parseEmailRecipientQuery(undefined), "");
  assert.equal(parseEmailRecipientQuery("   "), "");
  assert.equal(parseEmailRecipientQuery("  Speaker@Example.test "), "Speaker@Example.test");
  const long = "x".repeat(EMAIL_RECIPIENT_SEARCH_MAX_LENGTH + 500);
  assert.equal(parseEmailRecipientQuery(long).length, EMAIL_RECIPIENT_SEARCH_MAX_LENGTH);
  assert.equal(parseEmailRecipientQuery(["a", "b"]), "");
});

test("the page parameter is a bounded positive integer or the first page", () => {
  assert.equal(parseEmailHistoryPage(undefined), 1);
  assert.equal(parseEmailHistoryPage("1"), 1);
  assert.equal(parseEmailHistoryPage(" 7 "), 7);
  for (const bogus of ["0", "-3", "1.5", "1e9", "abc", "", "٣", ["2"]]) {
    assert.equal(parseEmailHistoryPage(bogus as string | string[]), 1, String(bogus));
  }
  // `skip` is work the database does before returning anything, so an unbounded
  // `?page=` would be an unbounded offset scan requested by a URL.
  assert.equal(parseEmailHistoryPage(String(EMAIL_HISTORY_MAX_PAGE + 5_000)), EMAIL_HISTORY_MAX_PAGE);
  assert.equal(parseEmailHistoryPage("9".repeat(40)), 1, "an over-long digit run is not a page number");
  assert.equal(clampEmailHistoryPage(Number.NaN), 1);
  assert.equal(clampEmailHistoryPage(Number.POSITIVE_INFINITY), EMAIL_HISTORY_MAX_PAGE);
  assert.equal(clampEmailHistoryPage(-4), 1);
  assert.equal(clampEmailHistoryPage(2.9), 2);
});

test("skip follows the bounded page, never the raw parameter", () => {
  assert.equal(emailHistorySkip(1), 0);
  assert.equal(emailHistorySkip(3), 2 * EMAIL_HISTORY_PAGE_SIZE);
  assert.equal(emailHistorySkip(0), 0);
  assert.equal(emailHistorySkip(-9), 0);
  assert.equal(
    emailHistorySkip(EMAIL_HISTORY_MAX_PAGE + 1_000),
    (EMAIL_HISTORY_MAX_PAGE - 1) * EMAIL_HISTORY_PAGE_SIZE,
  );
});

test("one URL resolves into one bounded view of all four narrowings", () => {
  assert.deepEqual(
    parseEmailHistoryQuery(
      {
        [EMAIL_HISTORY_PARAMS.status]: "failed",
        [EMAIL_HISTORY_PARAMS.template]: "decision.accepted",
        [EMAIL_HISTORY_PARAMS.query]: "  nadia@ ",
        [EMAIL_HISTORY_PARAMS.page]: "4",
      },
      TEMPLATE_KEYS,
    ),
    { status: "failed", template: "decision.accepted", query: "nadia@", page: 4 },
  );
  assert.deepEqual(parseEmailHistoryQuery({}, TEMPLATE_KEYS), view());
  assert.equal(emailHistoryIsFiltered(view()), false);
  assert.equal(emailHistoryIsFiltered(view({ page: 3 })), false, "paging is not a filter");
  assert.equal(emailHistoryIsFiltered(view({ status: "failed" })), true);
  assert.equal(emailHistoryIsFiltered(view({ template: "cfp.submitted" })), true);
  assert.equal(emailHistoryIsFiltered(view({ query: "a" })), true);
});

test("every narrowing rides on the event scope rather than replacing it", () => {
  // The unfiltered shape is unchanged, so the scoping regression guard above
  // still describes the same query.
  assert.deepEqual(emailHistoryWhere("evt-1", view()), { template: { eventId: "evt-1" } });

  // The template filter travels through the same parent traversal the event
  // scope uses — never a second one that could widen it.
  assert.deepEqual(emailHistoryWhere("evt-1", view({ template: "cfp.submitted" })), {
    template: { eventId: "evt-1", key: "cfp.submitted" },
  });

  const all = emailHistoryWhere("evt-1", view({ status: "failed", template: "cfp.submitted", query: "nadia" }));
  assert.deepEqual(all, {
    template: { eventId: "evt-1", key: "cfp.submitted" },
    status: "failed",
    // Prisma binds `contains` as a parameter; nothing here concatenates SQL.
    recipient: { contains: "nadia", mode: "insensitive" },
  });

  // A search is never a raw fragment handed to the database as syntax.
  const injected = emailHistoryWhere("evt-1", view({ query: "' OR 1=1 --" }));
  assert.deepEqual(injected.recipient, { contains: "' OR 1=1 --", mode: "insensitive" });
  assert.deepEqual(injected.template, { eventId: "evt-1" });
});

test("the unfiltered chip is a bare path and every other state is spelled out", () => {
  assert.equal(emailHistoryHref(view()), EMAIL_HISTORY_PATH);
  // A no-op parameter is noise in a shared URL.
  assert.equal(emailHistoryHref(view({ page: 1 })), EMAIL_HISTORY_PATH);
  assert.equal(
    emailHistoryHref(view({ status: "failed", template: "cfp.submitted", query: "a b", page: 2 })),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=a+b&page=2`,
  );
  // Anything an operator can type is encoded, never interpolated raw.
  assert.equal(
    emailHistoryHref(view({ query: "a&b=c#d" })),
    `${EMAIL_HISTORY_PATH}?q=a%26b%3Dc%23d`,
  );
});

test("a chip link carries the search and template but returns to the first page", () => {
  const current = view({ status: "sent", template: "cfp.submitted", query: "nadia", page: 6 });
  const href = emailHistoryStatusHref(current, "failed");
  assert.equal(href, `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia`);
  // Page 6 of one filter is not page 6 of another; keeping it lands the
  // operator on an empty page of a set they just narrowed.
  assert.equal(href.includes("page="), false);
  assert.equal(
    emailHistoryStatusHref(current, EMAIL_STATUS_ALL),
    `${EMAIL_HISTORY_PATH}?template=cfp.submitted&q=nadia`,
  );
});

test("a pager link carries every active filter, so paging never changes the set", () => {
  const current = view({ status: "failed", template: "cfp.submitted", query: "nadia", page: 3 });
  assert.equal(
    emailHistoryPageHref(current, 4),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia&page=4`,
  );
  assert.equal(
    emailHistoryPageHref(current, 2),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia&page=2`,
  );
  // Back to the first page drops the parameter rather than writing `page=1`.
  assert.equal(
    emailHistoryPageHref(current, 1),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia`,
  );
  assert.equal(
    emailHistoryPageHref(current, EMAIL_HISTORY_MAX_PAGE + 10),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia&page=${EMAIL_HISTORY_MAX_PAGE}`,
  );
});

test("only the unfiltered first page may claim the log itself is empty", () => {
  const fresh = emailHistoryEmptyState(view());
  assert.equal(fresh.title, "No emails sent yet");
  assert.match(fresh.body, /every attempt, delivered or not, is recorded here/);
});

test("an empty view names what it narrowed to instead of the whole log", () => {
  assert.deepEqual(emailHistoryEmptyState(view({ status: "failed" })), {
    title: "No failed dispatches",
    body: "No email in this event's log carries that status. That says nothing about the other statuses — clear the filter to see them.",
  });
  assert.equal(emailHistoryEmptyState(view({ status: "mocked" })).title, "No mocked attempts");
  assert.equal(emailHistoryEmptyState(view({ status: "sent" })).title, "No delivered emails");
  assert.equal(emailHistoryEmptyState(view({ status: "queued" })).title, "No unfinished attempts");

  const searched = emailHistoryEmptyState(view({ status: "failed", query: "nadia" }));
  assert.equal(searched.title, "No failed dispatches");
  assert.match(searched.body, /recipients containing “nadia”/);

  const both = emailHistoryEmptyState(view({ template: "cfp.submitted", query: "nadia" }));
  assert.equal(both.title, "No emails match these filters");
  assert.match(both.body, /the “cfp\.submitted” template and recipients containing “nadia”/);

  const past = emailHistoryEmptyState(view({ page: 4 }));
  assert.equal(past.title, "Nothing on this page");
  assert.match(past.body, /Go back a page/);

  // Never claims the log is empty once anything narrowed it.
  for (const narrowed of [
    view({ status: "failed" }),
    view({ template: "cfp.submitted" }),
    view({ query: "nadia" }),
    view({ page: 2 }),
  ]) {
    const state = emailHistoryEmptyState(narrowed);
    assert.notEqual(state.title, "No emails sent yet", JSON.stringify(narrowed));
    assert.equal(/sent yet|no emails have been attempted/i.test(state.body), false, state.body);
  }
});
