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
  { key: "programme", label: "Programme" },
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
