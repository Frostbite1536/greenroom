import assert from "node:assert/strict";
import test from "node:test";
import {
  OPEN_CFP_LABELS,
  OPEN_CFP_LIST_TAKE,
  compareOpenCfpCandidates,
  emptyOpenCfpEntry,
  isOpenPublicCfp,
  openCfpNavItems,
  readOpenCfpEntry,
  selectOpenCfpEntry,
  type OpenCfpCandidate,
  type OpenCfpReaderClient,
} from "@/lib/data/open-cfp";

const NOW = new Date("2026-08-09T18:00:00.000Z");
const EVENT = { name: "Forward 2026", slug: "forward-2026", timezone: "America/Los_Angeles" };

function candidate(overrides: Partial<OpenCfpCandidate> & { id: string }): OpenCfpCandidate {
  return {
    name: `Form ${overrides.id}`,
    slug: `form-${overrides.id}`,
    published: true,
    opensAt: null,
    closesAt: null,
    ...overrides,
  };
}

// ---- window predicate -----------------------------------------------------

test("an unpublished form is never an open public CFP", () => {
  assert.equal(isOpenPublicCfp({ published: false, opensAt: null, closesAt: null }, NOW), false);
});

test("a published form with no window is open", () => {
  assert.equal(isOpenPublicCfp({ published: true, opensAt: null, closesAt: null }, NOW), true);
});

test("opensAt exactly at now is already open, one millisecond later is not", () => {
  assert.equal(isOpenPublicCfp({ published: true, opensAt: NOW, closesAt: null }, NOW), true);
  assert.equal(
    isOpenPublicCfp({ published: true, opensAt: new Date(NOW.getTime() + 1), closesAt: null }, NOW),
    false,
  );
});

test("closesAt exactly at now is already closed, one millisecond later is still open", () => {
  assert.equal(isOpenPublicCfp({ published: true, opensAt: null, closesAt: NOW }, NOW), false);
  assert.equal(
    isOpenPublicCfp({ published: true, opensAt: null, closesAt: new Date(NOW.getTime() + 1) }, NOW),
    true,
  );
});

test("a form whose window has passed is closed even though it is published", () => {
  assert.equal(
    isOpenPublicCfp(
      { published: true, opensAt: new Date("2026-01-01T00:00:00.000Z"), closesAt: new Date("2026-02-01T00:00:00.000Z") },
      NOW,
    ),
    false,
  );
});

// ---- ordering -------------------------------------------------------------

test("chooser order is closesAt ascending with nulls last, then name, then id", () => {
  const soon = candidate({ id: "b", name: "Beta", closesAt: new Date("2026-08-10T00:00:00.000Z") });
  const later = candidate({ id: "c", name: "Gamma", closesAt: new Date("2026-09-01T00:00:00.000Z") });
  const openEnded = candidate({ id: "a", name: "Alpha", closesAt: null });
  const sameCloseLaterName = candidate({ id: "d", name: "Zeta", closesAt: soon.closesAt });
  const sameCloseSameName = candidate({ id: "e", name: "Beta", closesAt: soon.closesAt });

  const ordered = [openEnded, later, sameCloseLaterName, sameCloseSameName, soon]
    .slice()
    .sort(compareOpenCfpCandidates)
    .map((form) => form.id);

  // b and e share a close date and name, so id breaks the tie; a has no close
  // date and sorts last even though its name and id sort first.
  assert.deepEqual(ordered, ["b", "e", "d", "c", "a"]);
});

test("two open-ended calls fall through to name then id", () => {
  const ordered = [
    candidate({ id: "z", name: "Same" }),
    candidate({ id: "a", name: "Same" }),
    candidate({ id: "m", name: "Earlier" }),
  ]
    .slice()
    .sort(compareOpenCfpCandidates)
    .map((form) => form.id);
  assert.deepEqual(ordered, ["m", "a", "z"]);
});

// ---- zero / one / many ----------------------------------------------------

test("zero open forms produces the explicit none state and no links", () => {
  const entry = selectOpenCfpEntry({
    event: EVENT,
    forms: [
      candidate({ id: "unpublished", published: false }),
      candidate({ id: "not-yet", opensAt: new Date(NOW.getTime() + 60_000) }),
      candidate({ id: "closed", closesAt: new Date(NOW.getTime() - 60_000) }),
    ],
    now: NOW,
  });
  assert.equal(entry.state, "none");
  assert.deepEqual(entry.forms, []);
  assert.equal(entry.truncated, false);
  assert.deepEqual(entry.event, EVENT);
});

test("a missing event is the none state rather than a throw or a dead link", () => {
  const entry = selectOpenCfpEntry({ event: null, forms: [candidate({ id: "a" })], now: NOW });
  assert.deepEqual(entry, emptyOpenCfpEntry(null));
  assert.equal(entry.state, "none");
});

test("exactly one open form projects the canonical public path and a localized close date", () => {
  const entry = selectOpenCfpEntry({
    event: EVENT,
    forms: [
      candidate({ id: "open", name: "Main CFP", slug: "main cfp", closesAt: new Date("2026-09-01T05:00:00.000Z") }),
      candidate({ id: "unpublished", published: false }),
    ],
    now: NOW,
  });
  assert.equal(entry.state, "one");
  assert.equal(entry.forms.length, 1);
  assert.deepEqual(entry.forms[0], {
    id: "open",
    name: "Main CFP",
    href: "/cfp/forward-2026/main%20cfp",
    closesAt: "2026-09-01T05:00:00.000Z",
    // 05:00Z is still August 31 in the event's Los Angeles timezone.
    closesAtLabel: "August 31, 2026",
  });
});

test("an open-ended call reports no close date instead of inventing one", () => {
  const entry = selectOpenCfpEntry({ event: EVENT, forms: [candidate({ id: "a" })], now: NOW });
  assert.equal(entry.state, "one");
  assert.equal(entry.forms[0]!.closesAt, null);
  assert.equal(entry.forms[0]!.closesAtLabel, null);
});

test("two or more open forms list every one of them in chooser order", () => {
  const entry = selectOpenCfpEntry({
    event: EVENT,
    forms: [
      candidate({ id: "c", name: "Workshops", closesAt: null }),
      candidate({ id: "a", name: "Talks", closesAt: new Date("2026-08-20T00:00:00.000Z") }),
      candidate({ id: "b", name: "Lightning", closesAt: new Date("2026-08-12T00:00:00.000Z") }),
      candidate({ id: "d", name: "Archived", published: false }),
    ],
    now: NOW,
  });
  assert.equal(entry.state, "many");
  assert.deepEqual(entry.forms.map((form) => form.id), ["b", "a", "c"]);
  assert.deepEqual(entry.forms.map((form) => form.href), [
    "/cfp/forward-2026/form-b",
    "/cfp/forward-2026/form-a",
    "/cfp/forward-2026/form-c",
  ]);
  assert.equal(entry.truncated, false);
});

test("the projection exposes only public fields", () => {
  const entry = selectOpenCfpEntry({
    event: EVENT,
    forms: [candidate({ id: "a", closesAt: new Date("2026-08-20T00:00:00.000Z") })],
    now: NOW,
  });
  assert.deepEqual(Object.keys(entry.forms[0]!).sort(), [
    "closesAt",
    "closesAtLabel",
    "href",
    "id",
    "name",
  ]);
  assert.equal("published" in entry.forms[0]!, false);
  assert.equal("opensAt" in entry.forms[0]!, false);
  assert.equal("slug" in entry.forms[0]!, false);
});

test("an oversized event is bounded and reports the truncation honestly", () => {
  const forms = Array.from({ length: OPEN_CFP_LIST_TAKE + 3 }, (_, index) =>
    candidate({ id: `f${String(index).padStart(3, "0")}` }),
  );
  const entry = selectOpenCfpEntry({ event: EVENT, forms, now: NOW });
  assert.equal(entry.forms.length, OPEN_CFP_LIST_TAKE);
  assert.equal(entry.truncated, true);
  assert.equal(entry.state, "many");
});

// ---- navigation entries ---------------------------------------------------

test("nav shows a visible destination-free entry when nothing is open", () => {
  const items = openCfpNavItems(selectOpenCfpEntry({ event: EVENT, forms: [], now: NOW }));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.href, null);
  assert.ok(items[0]!.label.includes(OPEN_CFP_LABELS.none));
});

test("nav links straight through for a single open call", () => {
  const items = openCfpNavItems(
    selectOpenCfpEntry({ event: EVENT, forms: [candidate({ id: "a", slug: "talks" })], now: NOW }),
  );
  assert.deepEqual(items, [{ href: "/cfp/forward-2026/talks", label: OPEN_CFP_LABELS.heading }]);
});

test("nav lists every open call and never collapses to one", () => {
  const items = openCfpNavItems(
    selectOpenCfpEntry({
      event: EVENT,
      forms: [
        candidate({ id: "a", name: "Talks", slug: "talks", closesAt: new Date("2026-08-20T00:00:00.000Z") }),
        candidate({ id: "b", name: "Workshops", slug: "workshops" }),
      ],
      now: NOW,
    }),
  );
  assert.deepEqual(items, [
    { href: "/cfp/forward-2026/talks", label: `${OPEN_CFP_LABELS.heading}: Talks` },
    { href: "/cfp/forward-2026/workshops", label: `${OPEN_CFP_LABELS.heading}: Workshops` },
  ]);
});

// ---- reader seam ----------------------------------------------------------

function readerFake(options: {
  event?: { id: string; name: string; slug: string; timezone: string } | null;
  forms?: readonly OpenCfpCandidate[];
}) {
  const calls: { events: string[]; lists: { eventId: string; take: number }[] } = { events: [], lists: [] };
  const client: OpenCfpReaderClient = {
    async findEvent(eventParam) {
      calls.events.push(eventParam);
      return options.event ?? null;
    },
    async listOpenPublishedForms({ eventId, take }) {
      calls.lists.push({ eventId, take });
      return options.forms ?? [];
    },
  };
  return { client, calls };
}

test("an unknown event short-circuits to the none state without listing forms", async () => {
  const { client, calls } = readerFake({ event: null });
  const entry = await readOpenCfpEntry("missing-event", client, NOW);
  assert.equal(entry.state, "none");
  assert.equal(entry.event, null);
  assert.deepEqual(calls.events, ["missing-event"]);
  assert.deepEqual(calls.lists, []);
});

test("the reader asks for one row past the bound so truncation is observed", async () => {
  const { client, calls } = readerFake({
    event: { id: "event-1", ...EVENT },
    forms: [candidate({ id: "a", slug: "talks" })],
  });
  const entry = await readOpenCfpEntry("forward-2026", client, NOW);
  assert.deepEqual(calls.lists, [{ eventId: "event-1", take: OPEN_CFP_LIST_TAKE + 1 }]);
  assert.equal(entry.state, "one");
  assert.equal(entry.forms[0]!.href, "/cfp/forward-2026/talks");
  assert.deepEqual(entry.event, EVENT);
});
