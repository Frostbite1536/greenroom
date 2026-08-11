/**
 * Source contract for the workspace sidebar: its sixteen destinations, the
 * labelled groups they now render in, and the two overflow declarations that
 * make the nav reachable on a phone and on a short laptop screen.
 *
 * Two things this pins that a reader cannot see from the diff alone:
 *
 * 1. Grouping is presentation. The destinations were reordered into blocks, and
 *    the failure mode of that kind of edit is a link quietly lost in the move —
 *    so every href, label and role set is asserted by value, and the count is
 *    asserted exactly. A future entry must be added deliberately, not dropped
 *    accidentally.
 * 2. The drawer scrolls. `.mobile-nav-overlay` is `position: fixed`, so the
 *    document's scrollbar cannot reach into it; before this pass neither it nor
 *    `.mobile-nav-panel` declared `overflow-y`, and the panel's `min-height:
 *    100%` let the list grow past the fold with nowhere to go. Measured at
 *    390x664 the last of fifteen entries sat at 746px — 82px below the viewport
 *    and unreachable by any gesture. Deleting `overflow-y: auto` would restore
 *    that silently on every desktop browser, which is exactly why it is a test.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read a file with its comments removed — this lane's own prose quotes the
 * selectors and labels these tests assert on, and in one case quotes the
 * `min-height: 100%` the fix retired.
 */
const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
const shell = () => source("components/app-shell.tsx");
const drawer = () => source("components/mobile-navigation.tsx");
const css = () => source("app/globals.css");

/**
 * Every destination the sidebar offers, in render order, with the role set each
 * one mirrors from the server. `roles` is the authorization mirror described in
 * `app-shell.tsx`; `group` is the block it renders under.
 */
const DESTINATIONS = [
  { href: "/admin", label: "Dashboard", roles: '["ADMIN"]', group: "overview" },
  { href: "/admin/reports", label: "Reports", roles: '["ADMIN"]', group: "overview" },
  { href: "/admin/forms", label: "CFP forms", roles: '["ADMIN"]', group: "cfp" },
  { href: "/admin/abstracts", label: "Abstracts", roles: '["ADMIN"]', group: "cfp" },
  { href: "/admin/evaluations", label: "Evaluations", roles: '["ADMIN", "EVALUATOR"]', group: "cfp" },
  { href: "/admin/agenda", label: "Agenda builder", roles: '["ADMIN"]', group: "programme" },
  { href: "/admin/speakers", label: "Speaker onboarding", roles: '["ADMIN"]', group: "programme" },
  { href: "/admin/resources", label: "Resources & wiki", roles: '["ADMIN"]', group: "programme" },
  { href: "/admin/operations", label: "Operations", roles: '["ADMIN"]', group: "communications" },
  { href: "/admin/emails", label: "Email history", roles: '["ADMIN"]', group: "communications" },
  { href: "/admin/embeds", label: "Website embeds", roles: '["ADMIN"]', group: "public" },
  { href: "/embed/schedule", label: "Public schedule", roles: "EVERYONE", group: "public" },
  { href: "/embed/speakers", label: "Public speakers", roles: "EVERYONE", group: "public" },
  { href: "/portal", label: "Speaker portal", roles: '["ADMIN", "SPEAKER"]', group: "public" },
  { href: "/admin/settings", label: "Event settings", roles: '["ADMIN"]', group: "configure" },
  { href: "/admin/team", label: "Event team", roles: '["ADMIN"]', group: "configure" },
];

/** The labelled blocks, in the order the sidebar renders them. */
const GROUPS = [
  { key: "overview", label: "Overview" },
  { key: "cfp", label: "Call for proposals" },
  { key: "programme", label: "Program" },
  { key: "communications", label: "Communications" },
  { key: "public", label: "Public site" },
  { key: "configure", label: "Configure" },
];

/** Every `{ href, label, icon, roles, group }` entry in the navigation table. */
const entries = () =>
  [...shell().matchAll(
    /\{ href: "([^"]+)", label: "([^"]+)", icon: \w+, roles: (\[[^\]]*\]|EVERYONE), group: "(\w+)" \}/g,
  )].map(([, href, label, roles, group]) => ({ href, label, roles, group }));

test("grouping kept all sixteen destinations, with their hrefs and role sets", () => {
  const found = entries();
  // Exact count first: the whole risk of reordering a list into blocks is that
  // one entry does not survive the move, and a subset assertion would pass.
  assert.equal(found.length, DESTINATIONS.length, `sidebar declares ${found.length} destinations, expected ${DESTINATIONS.length}`);
  assert.deepEqual(found, DESTINATIONS);
});

test("every destination names a declared group, and every group is used", () => {
  const declared = [...shell().matchAll(/\{ key: "(\w+)", label: "([^"]+)" \}/g)]
    .map(([, key, label]) => ({ key, label }));
  assert.deepEqual(declared, GROUPS);
  const used = new Set(entries().map((entry) => entry.group));
  for (const { key } of GROUPS) {
    assert.equal(used.has(key), true, `group "${key}" is declared but no destination renders in it`);
  }
  for (const key of used) {
    assert.equal(declared.some((group) => group.key === key), true, `destination group "${key}" is not declared in NAV_GROUPS`);
  }
});

test("the sidebar renders one labelled, named block per non-empty group", () => {
  const component = shell();
  // The block is a real group with an accessible name, not a bare div with a
  // styled paragraph above it.
  assert.match(component, /role="group"/);
  assert.match(component, /aria-labelledby=\{`nav-group-\$\{key\}`\}/);
  assert.match(component, /<p className="nav-group-label" id=\{`nav-group-\$\{key\}`\}>\{label\}<\/p>/);
  // A role that reaches nothing in a group must not get an empty heading.
  assert.match(component, /if \(group\.length === 0\) return null;/);
  // Every entry still renders as the same <Link className="nav-link"> it did as
  // a flat list — the grouping added a wrapper, it did not change the entries.
  assert.match(component, /<Link className="nav-link" href=\{href\} key=\{href\}>/);
  // The role filter is still the only thing deciding visibility.
  assert.match(component, /const links = navigation\.filter\(\(item\) => item\.roles\.includes\(session\.role\)\);/);
  // The single labelled landmark is unchanged; groups live inside it.
  assert.match(component, /<nav aria-label="Workspace navigation">/);
});

test("the mobile drawer renders the same labelled blocks, off the same table", () => {
  const component = drawer();
  // The drawer rendered a flat column of every destination until this pass —
  // the exact reading problem the sidebar's grouping solved, on the screen
  // where the column is longest.
  assert.equal(
    /links=\{\[\.\.\.links\.map/.test(shell()),
    false,
    "the shell still hands the drawer one flat list",
  );
  assert.match(shell(), /groups=\{NAV_GROUPS\.map\(/);
  // One table, on the server. A second copy here is the drift this forbids.
  assert.equal(
    /NAV_GROUPS/.test(component),
    false,
    "the drawer holds its own copy of the group table",
  );
  assert.match(component, /groups\.map\(\(\{ key, label, links \}\) => \{/);
  // The same accessible structure the sidebar block above asserts: a real
  // group with a name, not a bare div behind a styled paragraph.
  assert.match(component, /role="group"/);
  assert.match(component, /aria-labelledby=\{`mobile-nav-group-\$\{key\}`\}/);
  assert.match(component, /<p className="nav-group-label" id=\{`mobile-nav-group-\$\{key\}`\}>\{label\}<\/p>/);
  // A role that reaches nothing in a group must not get an empty heading.
  assert.match(component, /if \(links\.length === 0\) return null;/);
  // Entries are the same `.mobile-nav-link` they were as a flat list: the
  // blocks wrap them, they do not replace them.
  assert.match(component, /<Link className="mobile-nav-link" href=\{link\.href\} key=\{link\.href\} onClick=\{closeMenu\}>/);
});

test("the drawer signs out through the sidebar's own server action, as a form post", () => {
  const component = drawer();
  // The same import the sidebar footer uses. The drawer had no sign-out at
  // all: on a phone the sidebar that owns it is `display: none`, so the only
  // way out was to widen the window.
  const importLine = /import \{ logout \} from "@\/app\/login\/actions";/;
  assert.match(shell(), importLine);
  assert.match(component, importLine);
  // A plain form whose action IS the server action, so React posts it: same
  // request identity and session handling as the sidebar's, and it still
  // works with JavaScript off. Not a click handler calling an endpoint.
  assert.match(component, /<form action=\{logout\} className="mobile-nav-signout">/);
  assert.match(component, /<button className="mobile-nav-link mobile-nav-signout-button" type="submit">/);
  assert.equal(/fetch\(/.test(component), false, "the drawer signs out with a hand-rolled request");
  assert.equal(/onSubmit/.test(component), false, "the sign-out form intercepts its own submit");
  // The sidebar's control is unchanged and still posts the same action.
  assert.match(shell(), /<form action=\{logout\} className="logout-form">/);
});

test("the drawer's sign-out scrolls with the drawer instead of floating over it", () => {
  const sheet = css();
  const mediaStart = sheet.indexOf("@media (max-width: 820px)");
  assert.ok(mediaStart > 0, "the 820px block was not found");
  const nextMedia = sheet.indexOf("@media", mediaStart + 1);
  const phone = sheet.slice(mediaStart, nextMedia > 0 ? nextMedia : sheet.length);
  const rule = /\.mobile-nav-signout \{([^}]*)\}/.exec(phone)?.[1] ?? "";
  assert.notEqual(rule, "", "`.mobile-nav-signout` is not declared in the phone block");
  // The panel is the scroll container. Taking this out of flow would put it
  // over the last entries — the fold problem `overflow-y` was added to fix.
  assert.equal(
    /position:\s*(fixed|absolute|sticky)/.test(rule),
    false,
    "the sign-out is taken out of the drawer's flow",
  );
  assert.match(rule, /border-top: 1px solid #394446;/);
});

test("the drawer shares the sidebar's label style rather than re-declaring it", () => {
  const sheet = css();
  // `.nav-group`/`.nav-group-label` are declared above the phone breakpoint,
  // so the sidebar and the drawer inside `@media (max-width: 820px)` render
  // one definition of the muted uppercase heading and cannot drift apart.
  const mediaStart = sheet.indexOf("@media (max-width: 820px)");
  assert.ok(mediaStart > 0, "the 820px block was not found");
  assert.ok(sheet.indexOf(".nav-group {") < mediaStart, "`.nav-group` is trapped inside the phone block");
  assert.ok(sheet.indexOf(".nav-group-label {") < mediaStart, "`.nav-group-label` is trapped inside the phone block");
  assert.equal(
    sheet.slice(mediaStart).includes(".nav-group-label"),
    false,
    "the phone block re-declares the label style instead of sharing it",
  );
});

test("the group labels are styled as the sidebar's existing muted uppercase text", () => {
  const sheet = css();
  assert.match(sheet, /\.nav-group \{[^}]*display: grid;[^}]*gap: 3px;/);
  assert.match(sheet, /\.nav-group \+ \.nav-group \{[^}]*margin-top: \d+px;/);
  const label = /\.nav-group-label \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
  // The same three declarations `.event-label` uses for "Current event".
  assert.match(label, /color: #9fabad;/);
  assert.match(label, /font-size: 11px;/);
  assert.match(label, /text-transform: uppercase;/);
});

test("the mobile drawer is a scroll container, so no entry can fall below the fold", () => {
  const sheet = css();
  const panel = /\.mobile-nav-panel \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
  assert.notEqual(panel, "", "`.mobile-nav-panel` rule not found");
  assert.match(panel, /overflow-y: auto;/);
  // A definite height is what `overflow-y` scrolls against. `min-height: 100%`
  // is the declaration that let the content grow instead of scroll.
  assert.match(panel, /height: 100%;/);
  assert.equal(/min-height: 100%;/.test(panel), false, "`.mobile-nav-panel` still lets its content grow past the viewport");
  // A flick at the end of the list must not scroll the page behind the drawer.
  assert.match(panel, /overscroll-behavior: contain;/);

  // Two rules share this selector: the `display: none` default at the top of
  // the sheet, and the real one inside the max-width:820px block. The last wins
  // and is the one that has to scroll.
  const overlayRules = [...sheet.matchAll(/\.mobile-nav-overlay \{([^}]*)\}/g)];
  assert.equal(overlayRules.length, 2, `expected the hidden default plus the drawer rule, found ${overlayRules.length}`);
  const overlay = overlayRules[overlayRules.length - 1]![1]!;
  // iOS Safari resolves `position: fixed; inset: 0` against the
  // toolbar-retracted viewport, so the panel needs a dynamic height with a
  // static fallback in front of it for engines that do not know the unit.
  assert.match(overlay, /height: 100vh;[^}]*height: 100dvh;/);
  assert.match(overlay, /position: fixed;/);
});

test("the desktop sidebar owns its own scrollbar rather than outgrowing the page", () => {
  const sheet = css();
  const sidebar = /\n\.sidebar \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
  assert.notEqual(sidebar, "", "`.sidebar` rule not found");
  assert.match(sidebar, /position: sticky;/);
  assert.match(sidebar, /top: 0;/);
  assert.match(sidebar, /height: 100vh;[^}]*height: 100dvh;/);
  assert.match(sidebar, /overflow-y: auto;/);
  // Measured 1124px of content in a 244px column; `min-height` would let the
  // sign-out footer sit below the fold again with nothing to scroll it.
  assert.equal(/min-height: 100vh;/.test(sidebar), false, "`.sidebar` still grows past the viewport instead of scrolling");
});
