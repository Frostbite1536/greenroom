import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { speakerAnchorHref, speakerAnchorId, speakerAnchorSlug } from "@/lib/speaker-anchor";

test("a speaker's name becomes a readable, stable anchor", () => {
  assert.equal(speakerAnchorSlug("Elena Rodriguez"), "elena-rodriguez");
  assert.equal(speakerAnchorId("Elena Rodriguez"), "speaker-elena-rodriguez");
});

test("both pages derive the SAME anchor from the same name", () => {
  // The whole mechanism: the schedule page computes this for a name it is
  // rendering and the speakers page puts it on the matching card, with neither
  // holding the other's data. If they ever disagreed, every link would 404 in
  // place — silently, since a missing fragment just does nothing.
  const name = "Théo Lindqvist";
  assert.equal(speakerAnchorHref("/speakers?event=x", name), `/speakers?event=x#${speakerAnchorId(name)}`);
});

test("accented names produce a readable slug rather than a row of dashes", () => {
  assert.equal(speakerAnchorSlug("Théo Lindqvist"), "theo-lindqvist");
  assert.equal(speakerAnchorSlug("Ana Muñoz-García"), "ana-munoz-garcia");
  assert.equal(speakerAnchorSlug("Åsa Öberg"), "asa-oberg");
});

test("punctuation, case and runs of spaces collapse the same way every time", () => {
  assert.equal(speakerAnchorSlug("  Dr.   Maya   CHEN, PhD  "), "dr-maya-chen-phd");
  assert.equal(speakerAnchorSlug("O'Brien"), "o-brien");
  // Idempotent: slugging a slug changes nothing.
  assert.equal(speakerAnchorSlug(speakerAnchorSlug("Elena Rodriguez")), "elena-rodriguez");
});

test("a name with nothing sluggable still gets a valid, stable fragment", () => {
  // An all-CJK or all-punctuation name must not produce `id=""`, which would
  // make the anchor a no-op and, worse, be duplicated across every such card.
  const cjk = speakerAnchorId("陳美玲");
  assert.match(cjk, /^speaker-s-[a-z0-9]+$/);
  assert.equal(cjk, speakerAnchorId("陳美玲"));
  assert.notEqual(cjk, speakerAnchorId("田中太郎"));
  assert.match(speakerAnchorId("!!!"), /^speaker-s-[a-z0-9]+$/);
});

test("a very long name is bounded and never ends in a dash", () => {
  const slug = speakerAnchorSlug(`${"Alexandra ".repeat(20)}Konstantinopoulos`);
  assert.ok(slug.length <= 64, `slug was ${slug.length} chars`);
  assert.doesNotMatch(slug, /-$/);
});

test("the anchor is derived from the name, never from a user id", () => {
  // The identity boundary this respects: `buildPublicSpeakers` drops user ids
  // before serializing, and `getPublicAgenda` selects `user.name` alone. An
  // id-based anchor would have required breaking one of those.
  const anchorSource = readFileSync(new URL("../lib/speaker-anchor.ts", import.meta.url), "utf8");
  // Scoped past the module docstring, which discusses ids by name on purpose.
  const code = anchorSource.slice(anchorSource.indexOf("function nameHash"));
  assert.match(anchorSource, /export function speakerAnchorSlug\(name: string\)/);
  assert.match(anchorSource, /export function speakerAnchorId\(name: string\)/);
  assert.doesNotMatch(code, /userId|user\.id|speaker\.id/);

  const serializer = readFileSync(new URL("../lib/public-speakers.ts", import.meta.url), "utf8");
  assert.match(serializer, /sortKey: user\.id/);
  assert.doesNotMatch(serializer, /\bid: user\.id/);
});

test("both public pages are linked to each other and use the shared anchor", () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const schedule = source("components/embed-schedule.tsx");
  const speakers = source("components/embed-speakers.tsx");

  // Session card -> speaker card.
  assert.match(schedule, /speakerAnchorHref\(speakersUrl, name\)/);
  // ...to the directory on the SAME surface, carrying the event through.
  assert.match(schedule, /publicSurfaceUrl\(speakersPath, eventParam \?\? agenda\.event\.slug\)/);
  // A header link each way, so neither page is a dead end.
  assert.match(schedule, /<Users size=\{15\} aria-hidden="true" \/> Speakers/);
  assert.match(speakers, /<CalendarDays size=\{15\} aria-hidden="true" \/> Schedule/);
  // Speaker card -> the anchor those links target.
  assert.match(speakers, /id=\{speakerAnchorId\(speaker\.name\)\}/);
  // Speaker card -> session card, already present, still surface-aware.
  assert.match(speakers, /\$\{scheduleUrl\}#session-\$\{session\.id\}/);

  // Both directions are plain links: no hydration, no JS-only navigation.
  assert.doesNotMatch(schedule, /onClick=/);

  const css = source("components/feature.css");
  // A card jumped to must not land under the header, and must be visible as
  // the thing that was jumped to.
  assert.match(css, /\.speaker-card \{ scroll-margin-top/);
  assert.match(css, /\.speaker-card:target \{/);
});
