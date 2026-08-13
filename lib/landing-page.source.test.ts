/**
 * Source contract for the public landing page's two claims about the world.
 *
 * `app/page.tsx` is a server component that reads the database, so it cannot be
 * imported into a unit test without one. What matters here is not the render
 * anyway — it is that two specific statements the page makes stay true of the
 * deployment it is served from:
 *
 *   1. The hero's entry control must not advertise a password-free demo on a
 *      deployment whose personas are switched off. The label and the note both
 *      switch, because a softened sentence under a button still reading "Open
 *      the live demo" walks a visitor to a sign-in form that cannot let them
 *      in. `lib/env.ts` `arePersonaLoginsEnabled` is the one source of truth,
 *      shared with the sign-in page and the server action that refuses.
 *
 *   2. Every public-programme URL the page offers must carry the RESOLVED
 *      `?event=`. The four links in the "Public pages" panel were bare
 *      constants, so a visitor who arrived on `/?event=<other>` was shown a
 *      hero describing one programme and a link list pointing at another.
 *
 * Both are properties of the source, not of a pure function, so they are pinned
 * the way this repository already pins that class of wiring — by reading the
 * file. Every regex is newline-agnostic (`[\s\S]`, no `\n` literals) so a CRLF
 * checkout does not fail these.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = () => source("app/page.tsx");

/** The `heroEntry` initializer, bounded at its terminating `};`. */
function heroEntry(): string {
  const file = page();
  const start = file.indexOf("const heroEntry = demoOneClick");
  assert.notEqual(start, -1, "the hero entry must be chosen from one switch");
  const end = file.indexOf("};", start);
  assert.notEqual(end, -1, "the heroEntry initializer must terminate");
  return file.slice(start, end);
}

/** The two branches of that switch: personas on, personas off. */
function heroBranches(): { enabled: string; disabled: string } {
  const block = heroEntry();
  // The `? {` / `: {` split, located by the ternary's own punctuation so this
  // does not depend on how the object is indented.
  const enabledStart = block.indexOf("? {");
  const disabledStart = block.indexOf(": {");
  assert.notEqual(enabledStart, -1, "the personas-enabled branch must exist");
  assert.notEqual(disabledStart, -1, "the personas-disabled branch must exist");
  assert.ok(enabledStart < disabledStart, "the enabled branch comes first");
  return {
    enabled: block.slice(enabledStart, disabledStart),
    disabled: block.slice(disabledStart),
  };
}

test("the hero entry is keyed off the same persona switch the login action is", () => {
  const component = page();
  assert.match(component, /import \{ arePersonaLoginsEnabled \} from "@\/lib\/env";/);
  assert.match(component, /const demoOneClick = arePersonaLoginsEnabled\(\);/);
  // The page must not decide this for itself from an env var it reads directly.
  assert.equal(
    /process\.env/.test(component),
    false,
    "the landing page must not read process.env; the helper is the boundary",
  );
});

test("the demo CTA's LABEL is conditional, not only the note under it", () => {
  const component = page();
  // Both strings are rendered from the switch, so neither can be left behind
  // when the other changes.
  assert.match(component, /<span>\{heroEntry\.label\}<\/span>/);
  assert.match(component, /<p className="landing-demo-note">\{heroEntry\.note\}<\/p>/);
  // And no demo wording is hard-coded into the markup. Matched as JSX text
  // (`>…<`) rather than as a bare substring, because the switch's own comment
  // quotes the label to explain why it is conditional.
  assert.equal(
    />\s*Open the live demo\s*</.test(component),
    false,
    "the demo label must only come from the persona switch, never as JSX text",
  );
  // The one place the label may appear as a literal is inside the switch.
  const occurrences = (component.match(/Open the live demo/g) ?? []).length;
  const inSwitch = (heroEntry().match(/Open the live demo/g) ?? []).length;
  assert.equal(inSwitch, 1, "the enabled branch carries the label exactly once");
  assert.ok(occurrences <= 2, "the label should not be duplicated across the page");
});

test("with personas OFF the page promises no one-click, password-free, seeded entry", () => {
  const { disabled } = heroBranches();
  // The exact promises that a personas-off deployment cannot honour. Each is
  // listed separately so a failure names the phrase that crept back in.
  const forbidden: Array<[RegExp, string]> = [
    [/one[- ]click/i, "a one-click entry"],
    [/no sign-up/i, "a sign-up-free entry"],
    [/seeded/i, "a seeded event"],
    [/organizer, a reviewer, or a speaker/i, "a choice of seeded roles"],
    [/demo event/i, "entry to the demo event"],
    [/without a password|no password required/i, "entry without credentials"],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(
      pattern.test(disabled),
      false,
      `the personas-disabled copy must not promise ${label}: ${disabled.slice(0, 200)}`,
    );
  }
  // It says plainly that there is no password-free way in, and points at the
  // one that does work.
  assert.match(disabled, /label: "Organizer sign in"/);
  assert.match(disabled, /no password-free demo accounts/i);
  assert.match(disabled, /email and password your organizer gave you/i);
});

test("with personas ON the one-click demo wording is kept", () => {
  const { enabled } = heroBranches();
  assert.match(enabled, /label: "Open the live demo"/);
  assert.match(enabled, /One click on the sign-in page/);
  assert.match(enabled, /no password and no sign-up/);
  assert.match(enabled, /fully seeded event/);
});

test("the landing page never promises self-service event creation", () => {
  // No auth route in this repository creates an Event, so an invitation to
  // "start your own event" from the front door would be the same defect the
  // conditional demo copy exists to prevent.
  const component = page();
  assert.equal(
    /start your own event|create an account and start|sign up free/i.test(component),
    false,
    "no signup route creates an event; the landing page must not imply one does",
  );
});

test("every public-programme link on the page carries the resolved ?event=", () => {
  const component = page();
  assert.match(component, /publicSurfaceUrl,/);
  // The hero's two buttons.
  assert.match(component, /const schedulePath = publicSurfaceUrl\(CANONICAL_SCHEDULE_PATH, resolution\.eventParam\);/);
  assert.match(component, /const speakersPath = publicSurfaceUrl\(CANONICAL_SPEAKERS_PATH, resolution\.eventParam\);/);
  // The four rows of the "Public pages" panel, rendered through the same helper
  // with the same resolved parameter.
  assert.match(component, /const href = publicSurfaceUrl\(path, resolution\.eventParam\);/);
  // No path constant may be used as an href directly — that is exactly the bug
  // this pins, and it is the shape it would come back in.
  assert.equal(
    /href=\{(CANONICAL_|EMBED_)[A-Z_]+\}/.test(component),
    false,
    "a public surface constant is being linked unscoped, dropping the ?event=",
  );
  // The visible text is the same string as the href, so a copied URL is the
  // offered URL, `?event=` included.
  assert.match(component, /<Link href=\{href\}>\{href\}<\/Link>/);
});

test("the public-pages panel still advertises all four surfaces, in order", () => {
  const component = page();
  const start = component.indexOf("const publicSurfaces = [");
  assert.notEqual(start, -1, "the panel must render from one list");
  const list = component.slice(start, component.indexOf("] as const;", start));
  const paths = (list.match(/path: ([A-Z_]+),/g) ?? []).map((line) => line.slice(6, -1));
  assert.deepEqual(paths, [
    "CANONICAL_SCHEDULE_PATH",
    "CANONICAL_SPEAKERS_PATH",
    "EMBED_SCHEDULE_PATH",
    "EMBED_SPEAKERS_PATH",
  ]);
});
