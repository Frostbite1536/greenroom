import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_DISPATCH_STATUSES,
  EMAIL_DISPATCH_STATUS_META,
  EMAIL_HISTORY_CURSOR_ID_MAX_LENGTH,
  EMAIL_HISTORY_CURSOR_MAX_LENGTH,
  EMAIL_HISTORY_DEFAULT_DIRECTION,
  EMAIL_HISTORY_DIRECTIONS,
  EMAIL_HISTORY_PAGE_SIZE,
  EMAIL_HISTORY_PAGE_TAKE,
  EMAIL_HISTORY_PARAMS,
  EMAIL_HISTORY_PATH,
  EMAIL_INTENTIONALLY_UNPROJECTED_FIELDS,
  EMAIL_RECIPIENT_SEARCH_MAX_LENGTH,
  EMAIL_STATUS_ALL,
  EMAIL_STATUS_FILTERS,
  decodeEmailHistoryCursor,
  describeEmailDispatchStatus,
  emailHistoryEmptyState,
  emailHistoryHref,
  emailHistoryIsFiltered,
  emailHistoryKeysetWhere,
  emailHistoryNewerHref,
  emailHistoryNewestHref,
  emailHistoryOlderHref,
  emailHistoryOrderBy,
  emailHistoryOrderByFor,
  emailHistoryRangeLabel,
  emailHistorySelect,
  emailHistoryStatusHref,
  emailHistoryWhere,
  encodeEmailHistoryCursor,
  parseEmailHistoryDirection,
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
  return {
    status: EMAIL_STATUS_ALL,
    template: null,
    query: "",
    cursor: null,
    direction: "older",
    ...overrides,
  };
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
  const page = toEmailHistoryPage(rows, view());
  assert.equal(page.entries.length, EMAIL_HISTORY_PAGE_SIZE);
  assert.equal(page.shown, EMAIL_HISTORY_PAGE_SIZE);
  assert.equal(page.hasOlder, true);
  assert.equal(page.hasNewer, false);
  // The extra probe row is never rendered.
  assert.equal(page.entries.at(-1)?.id, `dispatch-${EMAIL_HISTORY_PAGE_SIZE - 1}`);
  // No page count and no absolute positions, because neither is stable on a
  // log that grows while it is read.
  for (const absent of ["total", "pages", "page", "firstShown", "lastShown"]) {
    assert.equal(absent in page, false, absent);
  }
});

test("a page inside the view reports no older page and counts only what it shows", () => {
  const page = toEmailHistoryPage([
    row({ id: "a", status: "sent" }),
    row({ id: "b", status: "mocked" }),
    row({ id: "c", status: "failed", error: "no mailbox" }),
  ], view());
  assert.equal(page.hasOlder, false);
  assert.equal(page.hasNewer, false);
  assert.equal(page.shown, 3);
  assert.equal(page.shownDelivered, 1);
  assert.equal(page.shownUndelivered, 2);
  assert.equal(page.shownFailed, 1);
});

test("an anchored page knows the side it came from holds rows", () => {
  const anchor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const older = toEmailHistoryPage(
    [row({ id: "a" }), row({ id: "b" })],
    view({ cursor: anchor, direction: "older" }),
  );
  // Arrived from the newer side, so there is certainly something newer.
  assert.equal(older.hasNewer, true);
  assert.equal(older.hasOlder, false, "no probe row, so this is the oldest end");

  const newer = toEmailHistoryPage(
    [row({ id: "a" }), row({ id: "b" })],
    view({ cursor: anchor, direction: "newer" }),
  );
  assert.equal(newer.hasOlder, true);
  assert.equal(newer.hasNewer, false, "no probe row, so this is the newest end");
});

test("a newer read is re-reversed, so the table is newest-first either way", () => {
  // The database returns ascending for a `newer` read so the rows nearest the
  // anchor come back; rendering them in that order would show the log upside
  // down on exactly one of the two pager directions.
  const ascending = [
    row({ id: "old", createdAt: new Date("2026-05-01T10:00:00.000Z") }),
    row({ id: "mid", createdAt: new Date("2026-05-01T11:00:00.000Z") }),
    row({ id: "new", createdAt: new Date("2026-05-01T12:00:00.000Z") }),
  ];
  const page = toEmailHistoryPage(
    ascending,
    view({ cursor: { createdAt: "2026-05-01T09:00:00.000Z", id: "anchor" }, direction: "newer" }),
  );
  assert.deepEqual(page.entries.map((entry) => entry.id), ["new", "mid", "old"]);
  // The anchors are this page's own visible edges, in render order.
  assert.deepEqual(page.newerCursor, { createdAt: "2026-05-01T12:00:00.000Z", id: "new" });
  assert.deepEqual(page.olderCursor, { createdAt: "2026-05-01T10:00:00.000Z", id: "old" });
});

test("an empty view is an empty page, and offers no anchor it did not observe", () => {
  const first = toEmailHistoryPage([], view());
  assert.deepEqual(first.entries, []);
  assert.equal(first.shown, 0);
  assert.equal(first.hasOlder, false);
  assert.equal(first.hasNewer, false);
  assert.equal(first.olderCursor, null);
  assert.equal(first.newerCursor, null);

  // Past the end of a real view: the way back is known, but there is no row on
  // screen to anchor it, which is why the page always offers "Newest" too.
  const past = toEmailHistoryPage([], view({ cursor: { createdAt: "2026-05-01T10:00:00.000Z", id: "x" } }));
  assert.equal(past.hasNewer, true);
  assert.equal(past.newerCursor, null);
});

test("the page states no volume it did not read from its own single query", () => {
  // Regression guard for the dropped `count()`: the panel used to pair this
  // read with an independently-snapshotted total, so a dispatch inserted
  // between the two could make the header contradict the rows below it. There
  // is now no field that can disagree with `entries` — and pagination did not
  // bring a total back in through a page count.
  const page = toEmailHistoryPage(
    [row({ id: "a", status: "sent" }), row({ id: "b", status: "failed", error: "bounced" })],
    view(),
  );
  assert.equal("total" in page, false);
  assert.equal(page.shown, page.entries.length);
  assert.equal(page.shownDelivered + page.shownUndelivered, page.entries.length);
  assert.equal(page.shownFailed <= page.shownUndelivered, true);

  // Full page: `shown` is the page size, never advertised as any total.
  const full = toEmailHistoryPage(
    Array.from({ length: EMAIL_HISTORY_PAGE_TAKE }, (_, i) => row({ id: `d-${i}` })),
    view(),
  );
  assert.equal(full.shown, full.entries.length);
  assert.equal(full.shown, full.pageSize);
});

test("the position line describes this page and never numbers it", () => {
  const empty = emailHistoryRangeLabel(toEmailHistoryPage([], view()));
  assert.equal(empty, "No emails in this view.");

  const one = emailHistoryRangeLabel(toEmailHistoryPage([row({ id: "a" })], view()));
  assert.match(one, /^Showing 1 email of this view, newest first\./);
  assert.match(one, /This is the oldest end of this view\.$/);

  const more = emailHistoryRangeLabel(
    toEmailHistoryPage(
      Array.from({ length: EMAIL_HISTORY_PAGE_TAKE }, (_, i) => row({ id: `d-${i}` })),
      view({ cursor: { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" } }),
    ),
  );
  assert.match(more, /^Showing 50 emails of this view, newest first\./);
  assert.match(more, /Newer emails are on the previous page\./);
  assert.match(more, /Older emails continue on the next page\.$/);
  // No lifetime claim and no absolute numbering anywhere in the sentence.
  for (const label of [empty, one, more]) {
    assert.equal(/\bof \d+\b|\btotal\b|\bpage \d+\b/i.test(label), false, label);
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

test("a cursor round-trips, and every malformed token is the newest page", () => {
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "cmsp9ois200g3x22womm4wfdp" };
  const token = encodeEmailHistoryCursor(cursor);
  assert.deepEqual(decodeEmailHistoryCursor(token), cursor);
  assert.match(token, /^[A-Za-z0-9_-]+$/, "the token must survive a URL unescaped");
  assert.ok(token.length <= EMAIL_HISTORY_CURSOR_MAX_LENGTH);
  // Opaque, not secret: the position is already visible on the page that
  // issued it. Encoding only stops callers hand-assembling offsets.
  assert.equal(Buffer.from(token, "base64url").toString("utf8"), `${cursor.createdAt}|${cursor.id}`);

  for (const bogus of [
    undefined,
    ["a", "b"],
    "",
    "   ",
    "not base64!!",
    Buffer.from("no-separator", "utf8").toString("base64url"),
    Buffer.from("|missing-instant", "utf8").toString("base64url"),
    Buffer.from("2026-05-01T10:00:00.000Z|", "utf8").toString("base64url"),
    // Parses as a Date but is not the string this page issues — a coerced
    // anchor pages from somewhere other than the URL names.
    Buffer.from("2026-05-01|abc", "utf8").toString("base64url"),
    Buffer.from("May 1 2026|abc", "utf8").toString("base64url"),
    Buffer.from("not-a-date|abc", "utf8").toString("base64url"),
    // An id that could never be a cuid, and one past the bound.
    Buffer.from("2026-05-01T10:00:00.000Z|../../etc", "utf8").toString("base64url"),
    Buffer.from(`2026-05-01T10:00:00.000Z|${"x".repeat(EMAIL_HISTORY_CURSOR_ID_MAX_LENGTH + 1)}`, "utf8").toString("base64url"),
    "A".repeat(EMAIL_HISTORY_CURSOR_MAX_LENGTH + 1),
  ]) {
    assert.equal(
      decodeEmailHistoryCursor(bogus as string | string[] | undefined),
      null,
      String(bogus).slice(0, 40),
    );
  }
});

test("the direction parameter is one of two words, defaulting to older", () => {
  assert.deepEqual([...EMAIL_HISTORY_DIRECTIONS], ["older", "newer"]);
  assert.equal(parseEmailHistoryDirection("newer"), "newer");
  for (const bogus of [undefined, "", "older", "NEWER", " newer ", "sideways", ["newer"]]) {
    assert.equal(parseEmailHistoryDirection(bogus as string | string[] | undefined), "older", String(bogus));
  }
});

test("one URL resolves into one bounded view of all four narrowings", () => {
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  assert.deepEqual(
    parseEmailHistoryQuery(
      {
        [EMAIL_HISTORY_PARAMS.status]: "failed",
        [EMAIL_HISTORY_PARAMS.template]: "decision.accepted",
        [EMAIL_HISTORY_PARAMS.query]: "  nadia@ ",
        [EMAIL_HISTORY_PARAMS.cursor]: encodeEmailHistoryCursor(cursor),
        [EMAIL_HISTORY_PARAMS.direction]: "newer",
      },
      TEMPLATE_KEYS,
    ),
    { status: "failed", template: "decision.accepted", query: "nadia@", cursor, direction: "newer" },
  );
  assert.deepEqual(parseEmailHistoryQuery({}, TEMPLATE_KEYS), view());
  assert.equal(emailHistoryIsFiltered(view()), false);
  assert.equal(emailHistoryIsFiltered(view({ cursor })), false, "paging is not a filter");
  assert.equal(emailHistoryIsFiltered(view({ status: "failed" })), true);
  assert.equal(emailHistoryIsFiltered(view({ template: "cfp.submitted" })), true);
  assert.equal(emailHistoryIsFiltered(view({ query: "a" })), true);
});

test("a direction without a valid anchor resolves to the newest page, not an inverted one", () => {
  // The defect (A-1916): the cursor and the direction were resolved
  // independently, so `?dir=newer` survived a token the decoder had already
  // refused. `newer` names a side of a specific row; with no row to be newer
  // than, the only honest read is the one a bare `/admin/emails` performs.
  // Left independent, the read ordered ascending with no keyset predicate and
  // the fold reversed it — the newest page rendered as the oldest fifty rows.
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const token = encodeEmailHistoryCursor(cursor);

  // Every token `decodeEmailHistoryCursor` refuses, carrying `dir=newer`.
  for (const bogus of [
    "not base64!!",
    Buffer.from("no-separator", "utf8").toString("base64url"),
    Buffer.from("May 1 2026|abc", "utf8").toString("base64url"),
    Buffer.from("2026-05-01T10:00:00.000Z|../../etc", "utf8").toString("base64url"),
    "A".repeat(EMAIL_HISTORY_CURSOR_MAX_LENGTH + 1),
    "",
  ]) {
    assert.deepEqual(
      parseEmailHistoryQuery(
        {
          [EMAIL_HISTORY_PARAMS.cursor]: bogus,
          [EMAIL_HISTORY_PARAMS.direction]: "newer",
        },
        TEMPLATE_KEYS,
      ),
      view(),
      bogus.slice(0, 40),
    );
  }

  // A repeated `?cursor=` is refused the same way, and takes the direction with it.
  assert.deepEqual(
    parseEmailHistoryQuery(
      {
        [EMAIL_HISTORY_PARAMS.cursor]: [token, token],
        [EMAIL_HISTORY_PARAMS.direction]: "newer",
      },
      TEMPLATE_KEYS,
    ),
    view(),
  );

  // No token at all is the same request: `dir=newer` alone anchors nothing.
  assert.deepEqual(
    parseEmailHistoryQuery({ [EMAIL_HISTORY_PARAMS.direction]: "newer" }, TEMPLATE_KEYS),
    view(),
  );

  // The fallback narrows nothing else: the filters on the URL still apply, it
  // is only the anchor and its direction that are dropped.
  assert.deepEqual(
    parseEmailHistoryQuery(
      {
        [EMAIL_HISTORY_PARAMS.status]: "failed",
        [EMAIL_HISTORY_PARAMS.query]: "nadia@",
        [EMAIL_HISTORY_PARAMS.cursor]: "not base64!!",
        [EMAIL_HISTORY_PARAMS.direction]: "newer",
      },
      TEMPLATE_KEYS,
    ),
    view({ status: "failed", query: "nadia@" }),
  );

  // Preserved exactly: a valid anchor still pages both ways.
  assert.equal(
    parseEmailHistoryQuery(
      { [EMAIL_HISTORY_PARAMS.cursor]: token, [EMAIL_HISTORY_PARAMS.direction]: "newer" },
      TEMPLATE_KEYS,
    ).direction,
    "newer",
  );
  assert.equal(
    parseEmailHistoryQuery(
      { [EMAIL_HISTORY_PARAMS.cursor]: token, [EMAIL_HISTORY_PARAMS.direction]: "older" },
      TEMPLATE_KEYS,
    ).direction,
    "older",
  );
  // The standalone parser is unchanged — it is the composition that had to hold
  // the anchor and the direction together.
  assert.equal(EMAIL_HISTORY_DEFAULT_DIRECTION, "older");
  assert.equal(parseEmailHistoryDirection("newer"), "newer");
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

test("the keyset predicate is a tuple comparison, not a bare createdAt one", () => {
  // This is the whole correctness of the pager. A bulk send writes many rows
  // inside one millisecond, so `createdAt` alone is not unique: `lt` would skip
  // every tied row after the anchor and `lte` would repeat all of them. The
  // second disjunct — same instant, smaller id — is what makes the boundary
  // exact.
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const instant = new Date(cursor.createdAt);

  assert.deepEqual(emailHistoryKeysetWhere(cursor, "older"), {
    OR: [
      { createdAt: { lt: instant } },
      { createdAt: instant, id: { lt: "anchor" } },
    ],
  });
  // The mirror, for walking back towards the newest.
  assert.deepEqual(emailHistoryKeysetWhere(cursor, "newer"), {
    OR: [
      { createdAt: { gt: instant } },
      { createdAt: instant, id: { gt: "anchor" } },
    ],
  });
  assert.equal(emailHistoryKeysetWhere(null, "older"), null);

  // It reaches the query ANDed as its own clause, so a future narrowing that
  // also needs an OR cannot overwrite it and silently restore a full re-scan.
  const where = emailHistoryWhere("evt-1", view({ status: "failed", cursor }));
  assert.deepEqual(where.AND, [emailHistoryKeysetWhere(cursor, "older")]);
  assert.deepEqual(where.template, { eventId: "evt-1" });
  assert.equal(where.status, "failed");
  // And no offset survives anywhere in the composition.
  assert.equal("skip" in where, false);
});

test("a newer read reverses the order so the database returns the nearest rows", () => {
  assert.deepEqual(emailHistoryOrderByFor("older"), [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(emailHistoryOrderByFor("newer"), [{ createdAt: "asc" }, { id: "asc" }]);
  // The render order constant is untouched: the table is always newest-first.
  assert.deepEqual([...emailHistoryOrderBy], [{ createdAt: "desc" }, { id: "desc" }]);
});

test("the unfiltered chip is a bare path and every other state is spelled out", () => {
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const token = encodeEmailHistoryCursor(cursor);
  assert.equal(emailHistoryHref(view()), EMAIL_HISTORY_PATH);
  // A direction without an anchor means nothing, so it is never written alone.
  assert.equal(emailHistoryHref(view({ direction: "newer" })), EMAIL_HISTORY_PATH);
  assert.equal(
    emailHistoryHref(view({ status: "failed", template: "cfp.submitted", query: "a b", cursor })),
    `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=a+b&cursor=${token}`,
  );
  assert.equal(
    emailHistoryHref(view({ cursor, direction: "newer" })),
    `${EMAIL_HISTORY_PATH}?cursor=${token}&dir=newer`,
  );
  // Anything an operator can type is encoded, never interpolated raw.
  assert.equal(
    emailHistoryHref(view({ query: "a&b=c#d" })),
    `${EMAIL_HISTORY_PATH}?q=a%26b%3Dc%23d`,
  );
});

test("a chip link carries the search and template but drops the anchor", () => {
  const cursor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const current = view({ status: "sent", template: "cfp.submitted", query: "nadia", cursor });
  const href = emailHistoryStatusHref(current, "failed");
  assert.equal(href, `${EMAIL_HISTORY_PATH}?status=failed&template=cfp.submitted&q=nadia`);
  // A position inside one filtered set names no position in another; carrying
  // it would land the operator mid-way through a set they just narrowed.
  assert.equal(href.includes("cursor="), false);
  assert.equal(
    emailHistoryStatusHref(current, EMAIL_STATUS_ALL),
    `${EMAIL_HISTORY_PATH}?template=cfp.submitted&q=nadia`,
  );
  assert.equal(
    emailHistoryNewestHref(current),
    `${EMAIL_HISTORY_PATH}?status=sent&template=cfp.submitted&q=nadia`,
  );
});

test("a pager link carries every active filter, so paging never changes the set", () => {
  const anchor = { createdAt: "2026-05-01T10:00:00.000Z", id: "anchor" };
  const next = { createdAt: "2026-05-01T09:00:00.000Z", id: "edge" };
  const current = view({ status: "failed", template: "cfp.submitted", query: "nadia", cursor: anchor });
  const filters = "status=failed&template=cfp.submitted&q=nadia";

  assert.equal(
    emailHistoryOlderHref(current, next),
    `${EMAIL_HISTORY_PATH}?${filters}&cursor=${encodeEmailHistoryCursor(next)}`,
  );
  assert.equal(
    emailHistoryNewerHref(current, next),
    `${EMAIL_HISTORY_PATH}?${filters}&cursor=${encodeEmailHistoryCursor(next)}&dir=newer`,
  );
  // Back to the top drops the anchor rather than naming a first page.
  assert.equal(emailHistoryNewestHref(current), `${EMAIL_HISTORY_PATH}?${filters}`);
  // No link this page can build contains an offset.
  for (const href of [
    emailHistoryOlderHref(current, next),
    emailHistoryNewerHref(current, next),
    emailHistoryNewestHref(current),
  ]) {
    assert.equal(/page=|skip=|offset=/.test(href), false, href);
  }
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

  const past = emailHistoryEmptyState(view({ cursor: { createdAt: "2026-05-01T10:00:00.000Z", id: "x" } }));
  assert.equal(past.title, "Nothing further in this view");
  assert.match(past.body, /Go back to the newest emails/);
  // An anchor that outlived what it pointed at is a stale link, not an empty
  // log — and the copy says so rather than picking one of the two.
  assert.match(past.body, /the log has changed since that link was made/);

  // Never claims the log is empty once anything narrowed it.
  for (const narrowed of [
    view({ status: "failed" }),
    view({ template: "cfp.submitted" }),
    view({ query: "nadia" }),
    view({ cursor: { createdAt: "2026-05-01T10:00:00.000Z", id: "x" } }),
  ]) {
    const state = emailHistoryEmptyState(narrowed);
    assert.notEqual(state.title, "No emails sent yet", JSON.stringify(narrowed));
    assert.equal(/sent yet|no emails have been attempted/i.test(state.body), false, state.body);
  }
});
