/**
 * Source contract for "My itinerary" on the public schedule.
 *
 * The arithmetic is covered by itinerary.test.ts and the route's id filtering by
 * ics-embed.test.ts. What is pinned here is the property that cannot be asserted
 * from a pure function: that adding this feature did not turn the server-rendered
 * public schedule into a client-rendered one, and that with JavaScript disabled
 * the page is the page it was before — every leaf renders nothing until it has
 * mounted, and the schedule component itself stays a server component.
 *
 * CRLF-safe: the source is split on `\r?\n` and no pattern crosses a line break.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const schedule = () => source("components/embed-schedule.tsx");
const island = () => source("components/schedule-itinerary.tsx");

test("the public schedule stays a server component with one island imported into it", () => {
  const tree = schedule();
  assert.doesNotMatch(tree, /"use client"/);
  // No hooks, no handlers: everything on the card is still server HTML.
  assert.doesNotMatch(tree, /\buseState\b|\buseEffect\b|\bonClick=/);
  assert.match(tree, /from "@\/components\/schedule-itinerary"/);
  // The three leaves, and only those three.
  assert.match(tree, /<ItineraryStar eventKey=\{eventKey\} sessionId=\{session\.sessionId\}/);
  assert.match(tree, /<ItineraryTab eventKey=\{itineraryKey\} \/>/);
  assert.match(tree, /<ItineraryView/);
  // The card's own key is the one the page resolved, threaded down as a prop.
  assert.match(tree, /eventKey=\{itineraryKey\}/);
});

test("the island is the only client file this feature adds", () => {
  assert.match(island(), /^"use client";/);
});

test("nothing interactive renders until it has mounted, so the no-JS page is unchanged", () => {
  const client = island();
  // One mount gate in the shared hook...
  assert.match(client, /const \[mounted, setMounted\] = useState\(false\);/);
  assert.match(client, /setMounted\(true\);/);
  // ...and every exported leaf honours it.
  assert.match(client, /if \(!mounted\) return null;/);
  assert.match(client, /if \(!mounted \|\| mode !== "itinerary"\) return <>\{children\}<\/>;/);
  // The server snapshot is honestly empty: the server cannot know localStorage.
  assert.match(client, /function getServerSnapshot\(\): StoreState \{/);
  assert.match(client, /return EMPTY;/);
});

test("the itinerary view swaps the server subtree instead of rebuilding the schedule", () => {
  const client = island();
  // The server-rendered day sections arrive as children and are handed back
  // untouched in schedule mode — no DOM walking, no injected stylesheet.
  assert.match(client, /children: ReactNode;/);
  assert.doesNotMatch(client, /document\.querySelector|innerHTML|createElement\(/);
  // The starred set is namespaced per event and read through the guarded helpers.
  assert.match(client, /readItinerary\(browserStorage\(\), eventKey\)/);
  assert.match(client, /writeItinerary\(browserStorage\(\), eventKey, ids\)/);
  assert.doesNotMatch(client, /window\.localStorage\.(?:getItem|setItem|removeItem)/);
});

test("the itinerary spans the whole programme and carries no session prose to the client", () => {
  const tree = schedule();
  // `agenda.sessions`, not `filtered`: a starred talk must not disappear from
  // the itinerary because a day tab or search term is active.
  assert.match(tree, /const itineraryData = agenda\.sessions\.map\(itineraryProjection\);/);
  // The projection is slim: no description reaches the client payload twice.
  const projection = tree.match(/function itineraryProjection\(session: ScheduleViewSession\): ItinerarySession \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(projection, "the slim projection exists");
  assert.equal(/description/.test(projection!), false);
  // Keyed by the resolved slug, so the same programme reached by id and by slug
  // is one itinerary rather than two.
  assert.match(tree, /const itineraryKey = agenda\.event\.slug;/);
});

test("storage diagnostics use bounded labels and never print a reader's picks", () => {
  const lib = readFileSync(new URL("./itinerary.ts", import.meta.url), "utf8");
  for (const label of ["Itinerary storage read failed", "Itinerary storage write failed"]) {
    assert.match(lib, new RegExp(`console\\.error\\("${label}", error\\);`));
  }
  assert.doesNotMatch(lib, /console\.error\([^;]*(?:sessionIds|eventKey|itineraryStorageKey)/);
  assert.match(island(), /console\.error\("Itinerary browser storage access failed", error\);/);
});
