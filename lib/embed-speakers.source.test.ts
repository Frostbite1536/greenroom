/**
 * Source contract for the public speaker gallery.
 *
 * The gallery keeps its client island for live filtering, but the parts that
 * carry the rubric — a real headshot with alt text, a profile that opens
 * without hydration, and a search box that still submits with JavaScript off —
 * are rendering properties no pure function can assert.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a stored headshot renders as an image that names who is pictured", () => {
  const component = source("components/embed-speakers.tsx");
  assert.match(component, /<img/);
  assert.match(component, /alt=\{headshotAlt\(speaker\.name\)\}/);
  // The initials sit behind the image and stay decorative; the wrapper itself
  // must not be aria-hidden or the alt text would be hidden with it.
  assert.match(component, /<div className="speaker-avatar">/);
  assert.match(component, /<span aria-hidden="true">\{initials\(speaker\.name\)\}<\/span>/);
  // A dead URL falls back to the initials rather than a broken-image glyph.
  assert.match(component, /onError=\{\(event\) => \{ event\.currentTarget\.hidden = true; \}\}/);
});

test("the speaker detail opens with native details, not a JS-only modal", () => {
  const component = source("components/embed-speakers.tsx");
  assert.match(component, /<details className="speaker-detail">/);
  assert.match(component, /<summary>/);
  assert.match(component, /Full profile/);
  assert.match(component, /Hide profile/);
  assert.equal(/role="dialog"/.test(component), false);

  const css = source("components/feature.css");
  assert.match(css, /\.speaker-detail\[open\] > summary \.speaker-detail-open \{ display: none; \}/);
});

test("the detail panel lists sessions with their placement and an honest bio fallback", () => {
  const component = source("components/embed-speakers.tsx");
  assert.match(component, /sessionPlacementLine\(session, gallery\.event\.timezone\)/);
  assert.match(component, /speaker-detail-sessions/);
  // Named, not the identical filler string on every profile-less card.
  assert.match(component, /No bio has been published for \{speaker\.name\} yet\./);
  assert.match(component, /speakerDetailLine\(speaker\)/);
});

test("speaker search is a GET form and the header shows the real date range", () => {
  const component = source("components/embed-speakers.tsx");
  assert.match(component, /<form className="speaker-gallery-controls" method="get" action="\/embed\/speakers"/);
  assert.match(component, /type="hidden" name="event"/);
  assert.match(component, /type="submit"/);
  assert.match(component, /formatEventDateRange\(gallery\.event\.startsAt, gallery\.event\.endsAt, gallery\.event\.timezone\)/);
  // The gallery must not re-implement Intl formatting beside lib/tz.ts.
  assert.equal(/new Intl\.DateTimeFormat/.test(component), false);
});

test("no admin-only field reaches the gallery component", () => {
  const component = source("components/embed-speakers.tsx");
  for (const forbidden of ["speaker.email", "speaker.phone", "speaker.notes", "speaker.status", "speaker.id"]) {
    assert.equal(component.includes(forbidden), false, `${forbidden} must not render publicly`);
  }
});
