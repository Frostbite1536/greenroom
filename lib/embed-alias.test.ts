import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CANONICAL_SCHEDULE_PATH,
  CANONICAL_SPEAKERS_PATH,
  EMBED_SCHEDULE_PATH,
  EMBED_SPEAKERS_PATH,
  publicSurfaceUrl,
  schedulePathFor,
  speakersPathFor,
} from "@/lib/embed-alias";

test("a public surface URL without an event is the bare path", () => {
  assert.equal(publicSurfaceUrl(CANONICAL_SCHEDULE_PATH), "/schedule");
  assert.equal(publicSurfaceUrl(CANONICAL_SPEAKERS_PATH, undefined), "/speakers");
  assert.equal(publicSurfaceUrl(EMBED_SCHEDULE_PATH), "/embed/schedule");
  assert.equal(publicSurfaceUrl(EMBED_SPEAKERS_PATH, undefined), "/embed/speakers");
});

test("an explicit event is carried through and encoded", () => {
  assert.equal(publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, "forward 2026"), "/schedule?event=forward%202026");
  assert.equal(publicSurfaceUrl(EMBED_SPEAKERS_PATH, "a&b"), "/embed/speakers?event=a%26b");
});

test("a blank event is treated as absent rather than an empty filter", () => {
  assert.equal(publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, "   "), "/schedule");
  assert.equal(publicSurfaceUrl(EMBED_SPEAKERS_PATH, ""), "/embed/speakers");
});

test("each surface resolves to its own pair of paths", () => {
  // The property that keeps a framed reader inside the frame and a standalone
  // reader on the standalone site: a page never links to the other variant.
  assert.equal(schedulePathFor("canonical"), "/schedule");
  assert.equal(speakersPathFor("canonical"), "/speakers");
  assert.equal(schedulePathFor("embed"), "/embed/schedule");
  assert.equal(speakersPathFor("embed"), "/embed/speakers");
});

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the programme is served at the canonical paths, not redirected away from them", () => {
  // The reversal itself. `/schedule` and `/speakers` used to `redirect()`; if
  // either goes back to being a redirect, the guessable URL stops being a page.
  for (const path of ["app/schedule/page.tsx", "app/speakers/page.tsx"]) {
    const page = source(path);
    assert.doesNotMatch(page, /redirect\(/, `${path} must render, not redirect`);
    assert.match(page, /surface="canonical"/, `${path} draws the standalone chrome`);
  }
  // ...and the embed variant still renders, so framing is not broken either.
  for (const path of ["app/embed/schedule/page.tsx", "app/embed/speakers/page.tsx"]) {
    const page = source(path);
    assert.doesNotMatch(page, /redirect\(/, `${path} must stay frameable`);
    assert.match(page, /surface="embed"/, `${path} omits the standalone chrome`);
  }
});

test("the remaining aliases point at the canonical schedule", () => {
  for (const path of ["app/agenda/page.tsx", "app/sessions/page.tsx"]) {
    const page = source(path);
    assert.match(page, /redirect\(publicSurfaceUrl\(CANONICAL_SCHEDULE_PATH, event\)\)/, path);
  }
});

test("both surfaces render one component tree, not two implementations", () => {
  const shared = source("components/programme-pages.tsx");
  for (const path of [
    "app/schedule/page.tsx",
    "app/speakers/page.tsx",
    "app/embed/schedule/page.tsx",
    "app/embed/speakers/page.tsx",
  ]) {
    assert.match(source(path), /@\/components\/programme-pages/, `${path} delegates to the shared module`);
  }
  // The one read per surface lives there too, so the page and its metadata
  // cannot describe different events.
  assert.match(shared, /getPublicAgenda\(event\)/);
  assert.match(shared, /getPublicSpeakers\(event\)/);
});

test("the landing page sends visitors to the canonical pages", () => {
  const landing = source("app/page.tsx");
  assert.match(landing, /publicSurfaceUrl\(CANONICAL_SCHEDULE_PATH, resolution\.eventParam\)/);
  assert.match(landing, /publicSurfaceUrl\(CANONICAL_SPEAKERS_PATH, resolution\.eventParam\)/);
  // The embed URLs stay advertised — they are what an organizer pastes into an
  // iframe — but no longer as the only public programme link on the page.
  assert.match(landing, /EMBED_SCHEDULE_PATH/);
  assert.match(landing, /EMBED_SPEAKERS_PATH/);
});
