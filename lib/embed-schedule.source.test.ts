/**
 * Source contract for the public schedule embed.
 *
 * The embed's value in a headless or JS-disabled context is a rendering
 * property, not a pure function, so it cannot be asserted through
 * embed-schedule-view.test.ts. What can be locked is the shape that makes the
 * property true: no client boundary, native <details> for expansion, a GET form
 * for search, and links (not stateful buttons) for the day and track filters.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the schedule embed renders on the server with no client boundary", () => {
  const component = source("components/embed-schedule.tsx");
  assert.equal(component.includes('"use client"'), false);
  // A client hook here would silently reintroduce the hydration requirement.
  assert.equal(/\buseState\(|\buseMemo\(|\buseEffect\(/.test(component), false);
});

test("descriptions and their expand control are in the served markup", () => {
  const component = source("components/embed-schedule.tsx");
  assert.match(component, /<details className="embed-session-detail">/);
  assert.match(component, /<summary>/);
  assert.match(component, /Show more/);
  assert.match(component, /Show less/);
  // <details> keeps its body in the DOM while collapsed, so the full text is
  // served even before a click — that is what makes it crawlable and no-JS.
  assert.match(component, /embed-session-full/);
});

test("search is a GET form that preserves the other filters", () => {
  const component = source("components/embed-schedule.tsx");
  assert.match(component, /<form[^>]*method="get"/);
  // Surface-aware: search must return to the page the reader is on, so a day
  // tab on `/schedule` cannot drop them into the chrome-free embed. The default
  // is the frameable path, which is where this form lived before `/schedule`
  // became a real page.
  assert.match(component, /action=\{basePath\}/);
  assert.match(component, /basePath = EMBED_SCHEDULE_PATH/);
  assert.match(component, /name="q"/);
  assert.match(component, /type="hidden" name="event"/);
  assert.match(component, /type="hidden" name="track"/);
  assert.match(component, /type="hidden" name="day"/);
});

test("day and track filters are links carrying aria-current, not colour-only buttons", () => {
  const component = source("components/embed-schedule.tsx");
  assert.match(component, /aria-label="Filter by day"/);
  assert.match(component, /aria-label="Filter by track"/);
  assert.match(component, /aria-current=\{filters\.day === ALL \? "page" : undefined\}/);
  assert.match(component, /aria-current=\{filters\.track === t\.id \? "true" : undefined\}/);

  const css = source("components/feature.css");
  const selected = css.match(/\n\.embed-filters a\[aria-current\]\s*\{([^}]*)\}/);
  assert.ok(selected, "expected a rule for .embed-filters a[aria-current]");
  // Weight plus background, not hue alone — WCAG 1.4.1.
  assert.match(selected![1]!, /font-weight:\s*700/);
  assert.match(selected![1]!, /background:/);
});

test("the collapsed preview is hidden only when its own details is open", () => {
  const css = source("components/feature.css");
  // Scoped through `[open] > summary`, so one expanded card cannot blank the
  // preview of the sibling cards next to it.
  assert.match(css, /\.embed-session-detail\[open\] > summary \.embed-session-preview \{ display: none; \}/);
  assert.match(css, /\.embed-session-detail > summary::-webkit-details-marker/);
});

test("§5-2: every public time is labelled with the event's own timezone", () => {
  const component = source("components/embed-schedule.tsx");
  // The card's time range and the header note both come from lib/tz, which
  // derives the abbreviation at the event's instant rather than at render time.
  assert.match(component, /formatTimeRange\(session\.startsAt, session\.endsAt, timeZone\)/);
  assert.match(component, /timeZoneNote\(tz, agenda\.event\.startsAt\)/);
  // A bare formatTime pair here would silently drop the label again.
  assert.equal(/formatTime\(session\.(?:starts|ends)At/.test(component), false);
  // Formatting stays in lib/tz.ts rather than being re-implemented beside it.
  assert.equal(/new Intl\.DateTimeFormat/.test(component), false);
});
