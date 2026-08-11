/**
 * Pagination stability for `/admin/emails` (EML-01 review fix).
 *
 * The defect these tests exist for: the panel first shipped with numeric
 * `skip`/`page` pagination over `EmailDispatch`, which is a log that grows and
 * whose filtered subsets change while an operator reads them. An offset counts
 * rows from the top, so one dispatch inserted between two page requests — or
 * one `queued` row resolving into `sent` under an active status chip — shifts
 * every later offset by one and makes "page 2" repeat a row from page 1 or drop
 * one entirely, silently.
 *
 * Proving that needs a store, so this file has a small one: an in-memory
 * evaluator for exactly the `where`/`orderBy`/`take` shapes
 * `lib/comms/email-history.ts` emits. It is deliberately literal — it reads the
 * emitted clause rather than reimplementing the intent — so a keyset predicate
 * that regressed to a bare `createdAt` comparison would be faithfully executed
 * as such and fail these assertions rather than being quietly corrected. Any
 * operator it does not model throws, so the module cannot drift past it either.
 *
 * Not a substitute for Postgres: it proves the *composition* is stable, and the
 * source contract plus the smokes cover the query actually running.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_HISTORY_PAGE_SIZE,
  EMAIL_HISTORY_PAGE_TAKE,
  EMAIL_STATUS_ALL,
  emailHistoryOrderByFor,
  emailHistoryWhere,
  toEmailHistoryPage,
  type EmailDispatchRow,
  type EmailHistoryQuery,
} from "./email-history";

const EVENT = "evt-1";

/** A projected dispatch plus the parent event the scope traverses to reach. */
type StoredRow = EmailDispatchRow & { templateEventId: string };

type Clause = Record<string, unknown>;

function compare(actual: unknown, operand: unknown): number {
  if (actual instanceof Date && operand instanceof Date) {
    return actual.getTime() - operand.getTime();
  }
  if (typeof actual === "string" && typeof operand === "string") {
    return actual < operand ? -1 : actual > operand ? 1 : 0;
  }
  throw new Error(`cannot compare ${typeof actual} with ${typeof operand}`);
}

function matchesField(actual: unknown, expected: unknown): boolean {
  // An equality on a Date is `{ createdAt: someDate }`, not an operator object.
  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }
  if (expected !== null && typeof expected === "object") {
    const operators = expected as Record<string, unknown>;
    const insensitive = operators.mode === "insensitive";
    for (const [operator, operand] of Object.entries(operators)) {
      switch (operator) {
        case "mode":
          break;
        case "lt":
          if (!(compare(actual, operand) < 0)) return false;
          break;
        case "gt":
          if (!(compare(actual, operand) > 0)) return false;
          break;
        case "contains": {
          const haystack = insensitive ? String(actual).toLowerCase() : String(actual);
          const needle = insensitive ? String(operand).toLowerCase() : String(operand);
          if (!haystack.includes(needle)) return false;
          break;
        }
        default:
          // Loud rather than lenient: an operator this store does not model is
          // a query it cannot honestly claim to have evaluated.
          throw new Error(`unsupported operator: ${operator}`);
      }
    }
    return true;
  }
  return actual === expected;
}

function matches(row: StoredRow, where: Clause): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      if (!(value as Clause[]).every((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(value as Clause[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "template") {
      const template = value as { eventId?: string; key?: string };
      if (template.eventId !== undefined && template.eventId !== row.templateEventId) return false;
      if (template.key !== undefined && template.key !== row.template.key) return false;
      continue;
    }
    if (key === "skip" || key === "cursor") {
      throw new Error(`offset pagination leaked into the where clause: ${key}`);
    }
    if (!matchesField((row as unknown as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}

type Order = { createdAt?: "asc" | "desc"; id?: "asc" | "desc" };

function sortRows(rows: StoredRow[], orderBy: Order[]): StoredRow[] {
  return [...rows].sort((a, b) => {
    for (const term of orderBy) {
      const [field, direction] = Object.entries(term)[0] as ["createdAt" | "id", "asc" | "desc"];
      const delta = compare(a[field], b[field]);
      if (delta !== 0) return direction === "asc" ? delta : -delta;
    }
    return 0;
  });
}

function makeStore(initial: StoredRow[]) {
  const rows = [...initial];
  return {
    rows,
    insert(row: StoredRow) {
      rows.push(row);
    },
    /** The one read `getEmailHistory` performs, against this store. */
    read(query: EmailHistoryQuery): EmailDispatchRow[] {
      const where = emailHistoryWhere(EVENT, query) as unknown as Clause;
      const matching = rows.filter((row) => matches(row, where));
      return sortRows(matching, emailHistoryOrderByFor(query.direction) as Order[]).slice(
        0,
        EMAIL_HISTORY_PAGE_TAKE,
      );
    },
    /** What numeric pagination would have returned — the defect, for contrast. */
    readByOffset(query: EmailHistoryQuery, skip: number): EmailDispatchRow[] {
      const where = emailHistoryWhere(EVENT, { ...query, cursor: null }) as unknown as Clause;
      const matching = rows.filter((row) => matches(row, where));
      return sortRows(matching, emailHistoryOrderByFor("older") as Order[]).slice(
        skip,
        skip + EMAIL_HISTORY_PAGE_SIZE,
      );
    },
  };
}

function storedRow(index: number, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: `d-${String(index).padStart(4, "0")}`,
    recipient: `speaker${index}@example.test`,
    status: "sent",
    error: null,
    // Descending index means descending time, so d-0000 is the newest.
    createdAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 0) + (5_000 - index) * 60_000),
    sentAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 1) + (5_000 - index) * 60_000),
    template: { key: "speaker.reminder", subject: "Reminder", trigger: "speaker.reminder" },
    sender: { name: "Ada Organizer" },
    templateEventId: EVENT,
    ...overrides,
  };
}

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

/** Ids in the order the store itself returns them, never an assumed order. */
function newestFirstIds(store: ReturnType<typeof makeStore>): string[] {
  return sortRows(store.rows, emailHistoryOrderByFor("older") as Order[]).map((row) => row.id);
}

test("a dispatch inserted between two page requests neither duplicates nor omits a row", () => {
  const store = makeStore(Array.from({ length: 120 }, (_, index) => storedRow(index)));
  const before = newestFirstIds(store);

  const first = view();
  const page1 = toEmailHistoryPage(store.read(first), first);
  assert.equal(page1.shown, EMAIL_HISTORY_PAGE_SIZE);
  assert.ok(page1.olderCursor, "a full page must offer an anchor to continue from");

  // The event sends one more email while the operator reads page 1. It lands at
  // the top of the log, which is precisely what shifts every offset below it.
  store.insert(storedRow(-1, { id: "d-inserted", recipient: "late@example.test" }));

  const second = view({ cursor: page1.olderCursor, direction: "older" });
  const page2 = toEmailHistoryPage(store.read(second), second);

  const ids1 = page1.entries.map((entry) => entry.id);
  const ids2 = page2.entries.map((entry) => entry.id);

  // Nothing seen twice.
  assert.deepEqual(ids1.filter((id) => ids2.includes(id)), [], "a row appeared on both pages");
  // Nothing skipped: the two pages are exactly the 100 newest rows of the log
  // as it stood when paging began, contiguous and in order.
  assert.deepEqual([...ids1, ...ids2], before.slice(0, 100));
  // The row inserted above the anchor is correctly absent — it is newer than
  // the page being walked away from, not a member of the older side.
  assert.equal(ids2.includes("d-inserted"), false);

  // The defect, stated: the same insert against numeric pagination repeats the
  // anchor row and loses the one that should have followed the page.
  const offsetPage2 = store.readByOffset(first, EMAIL_HISTORY_PAGE_SIZE).map((row) => row.id);
  assert.equal(offsetPage2[0], ids1.at(-1), "offset paging repeats page 1's last row");
  assert.equal(offsetPage2.includes(before[100 - 1]), false, "offset paging drops a row entirely");
});

test("a status changing out of the filtered set does not skip the row behind it", () => {
  // The subtler half of the same defect, and the one a status chip makes
  // reachable: a `queued` row resolving into `sent` leaves the filtered set, so
  // every offset below it moves up by one and a row is never rendered at all.
  const store = makeStore(
    Array.from({ length: 120 }, (_, index) => storedRow(index, { status: "queued", sentAt: null })),
  );
  const filtered = view({ status: "queued" });
  const before = sortRows(store.rows, emailHistoryOrderByFor("older") as Order[]).map((row) => row.id);

  const page1 = toEmailHistoryPage(store.read(filtered), filtered);
  const ids1 = page1.entries.map((entry) => entry.id);
  assert.equal(ids1.length, EMAIL_HISTORY_PAGE_SIZE);

  // A row already shown on page 1 finishes sending and leaves the filtered set.
  const resolved = store.rows.find((row) => row.id === ids1[10]);
  assert.ok(resolved);
  resolved.status = "sent";

  const second = view({ status: "queued", cursor: page1.olderCursor, direction: "older" });
  const ids2 = toEmailHistoryPage(store.read(second), second).entries.map((entry) => entry.id);

  assert.deepEqual(ids1.filter((id) => ids2.includes(id)), []);
  // The row immediately after page 1 is still the first row of page 2.
  assert.equal(ids2[0], before[EMAIL_HISTORY_PAGE_SIZE]);
  assert.deepEqual([...ids1, ...ids2], before.slice(0, 100));

  // Offset paging skips it: one row left the set above the offset, so the
  // window slides past the row that should have come next.
  const offsetPage2 = store.readByOffset(filtered, EMAIL_HISTORY_PAGE_SIZE).map((row) => row.id);
  assert.equal(
    offsetPage2.includes(before[EMAIL_HISTORY_PAGE_SIZE]),
    false,
    "offset paging skipped the row directly after page 1",
  );
});

test("a bulk send sharing one millisecond pages exactly, tie by tie", () => {
  // The case a bare `createdAt` comparison fails outright. `dispatchEmail`
  // writes a bulk reminder's rows inside the same millisecond, so `createdAt`
  // alone is not a position: `lt` would return nothing at all here, and `lte`
  // would return the whole page again.
  const instant = new Date("2026-05-01T10:00:00.000Z");
  const store = makeStore(
    Array.from({ length: 120 }, (_, index) => storedRow(index, { createdAt: instant })),
  );
  const before = newestFirstIds(store);
  assert.equal(new Set(store.rows.map((row) => row.createdAt.getTime())).size, 1);

  const first = view();
  const page1 = toEmailHistoryPage(store.read(first), first);
  const ids1 = page1.entries.map((entry) => entry.id);

  const second = view({ cursor: page1.olderCursor, direction: "older" });
  const page2 = toEmailHistoryPage(store.read(second), second);
  const ids2 = page2.entries.map((entry) => entry.id);

  assert.equal(ids2.length, EMAIL_HISTORY_PAGE_SIZE, "a tie-only log must still page");
  assert.deepEqual(ids1.filter((id) => ids2.includes(id)), []);
  assert.deepEqual([...ids1, ...ids2], before.slice(0, 100));
});

test("walking older and back newer returns to the same rows", () => {
  const store = makeStore(Array.from({ length: 120 }, (_, index) => storedRow(index)));
  const first = view();
  const page1 = toEmailHistoryPage(store.read(first), first);

  const second = view({ cursor: page1.olderCursor, direction: "older" });
  const page2 = toEmailHistoryPage(store.read(second), second);
  assert.ok(page2.newerCursor);

  const back = view({ cursor: page2.newerCursor, direction: "newer" });
  const returned = toEmailHistoryPage(store.read(back), back);

  // Same rows, same newest-first render order as the page departed from.
  assert.deepEqual(
    returned.entries.map((entry) => entry.id),
    page1.entries.map((entry) => entry.id),
  );
  assert.equal(returned.hasOlder, true);
  assert.equal(returned.hasNewer, false, "back at the newest end of the view");
});

test("the store refuses any query shape it cannot honestly evaluate", () => {
  // Guards the guard: if the module started emitting an operator this store
  // silently ignored, every assertion above would pass vacuously.
  const store = makeStore([storedRow(0)]);
  assert.throws(
    () => store.rows.filter((row) => matches(row, { status: { startsWith: "s" } })),
    /unsupported operator: startsWith/,
  );
  assert.throws(() => store.rows.filter((row) => matches(row, { skip: 50 })), /offset pagination/);
});
