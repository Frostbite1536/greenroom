/**
 * GRA2-06 — source contract for the three overlays that used to be hand-rolled
 * `<div role="dialog" aria-modal="true">` panels with no focus management.
 *
 * Focus order, Tab containment, Escape and focus restoration are the platform's
 * once the element is a real `<dialog>` opened with `showModal()`, and none of
 * that is observable without a browser. What IS checkable here — and what these
 * tests pin — is that each of the three sites actually uses that element and
 * that wiring, that no plain div has taken the dialog role back, and that each
 * dialog is named by its own visible heading rather than a bare `aria-label`
 * that can drift from the text on screen.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read a file with its comments removed.
 *
 * These tests assert that markup is ABSENT as often as present, and this lane's
 * own comments quote the very patterns it retired (`role="dialog"`, `<dialog>`).
 * Without this, prose about the migration would fail the migration.
 */
const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
const table = () => source("components/abstracts-table.tsx");
const agenda = () => source("components/agenda-builder.tsx");
const featureCss = () => source("components/feature.css");

/** The three migrated sites, by the file that owns them. */
const MIGRATED = [
  { name: "abstracts-table.tsx (abstract detail drawer)", read: table, dialogs: 1 },
  { name: "agenda-builder.tsx (auto-placement preview + schedule editor)", read: agenda, dialogs: 1 },
];

test("no migrated overlay hand-rolls the dialog role or aria-modal any more", () => {
  for (const { name, read } of MIGRATED) {
    const component = read();
    assert.equal(/role="dialog"/.test(component), false, `${name} still declares role="dialog"`);
    assert.equal(/aria-modal/.test(component), false, `${name} still declares aria-modal`);
    // The overlay divs these replaced were identified by a fixed full-viewport
    // inline backdrop. A native <dialog> gets that from ::backdrop, so its
    // return would mean a hand-rolled overlay came back.
    assert.equal(
      /background: "rgba\(20,28,30,0\.35\)"/.test(component),
      false,
      `${name} still paints an inline overlay backdrop`,
    );
  }
});

test("every migrated site opens a real <dialog> with showModal()", () => {
  for (const { name, read, dialogs } of MIGRATED) {
    const component = read();
    assert.match(component, /useRef<HTMLDialogElement>\(null\)/, name);
    // The open call itself, guarded the way every other dialog in this repo
    // guards it, so a double-open cannot throw.
    assert.match(component, /if \(dialog && !dialog\.open\) dialog\.showModal\(\);|if \(!dialog\.open\) dialog\.showModal\(\);/, name);
    // Escape and the backdrop both route back through the owner's close path.
    assert.match(component, /onCancel=\{/, name);
    assert.match(component, /onMouseDown=\{\(event\) => \{\r?\n\s*if \(event\.target === dialogRef\.current/, name);
    // One <dialog> element per file: the agenda builder's two dialogs share a
    // single shell, so a second literal would mean the shell was bypassed.
    const opened = [...component.matchAll(/<dialog\b/g)].length;
    assert.equal(opened, dialogs, `${name} renders ${opened} <dialog> elements, expected ${dialogs}`);
  }
});

test("each dialog is named by visible heading text, never a bare aria-label", () => {
  const component = table();
  // The drawer: aria-labelledby points at the <h2> that shows the proposal
  // title, and that heading carries the matching id.
  assert.match(component, /aria-labelledby=\{`\$\{ids\}-title`\}/);
  assert.match(component, /<h2 id=\{`\$\{ids\}-title`\} style=\{\{ marginTop: 0 \}\}>\{abstract\.title\}<\/h2>/);
  // The drawer's own label must not also be spelled out by hand.
  assert.equal(/aria-label=\{abstract\.title\}/.test(component), false);

  const builder = agenda();
  // Both agenda dialogs name themselves with their eyebrow plus their heading —
  // the same two lines the old aria-labels spelled out, now read from the DOM.
  assert.equal([...builder.matchAll(/labelledBy=\{`\$\{ids\}-eyebrow \$\{ids\}-title`\}/g)].length, 2);
  assert.equal([...builder.matchAll(/<p className="eyebrow" id=\{`\$\{ids\}-eyebrow`\}>/g)].length, 2);
  assert.equal([...builder.matchAll(/<h2 id=\{`\$\{ids\}-title`\}/g)].length, 2);
  // The strings the old aria-labels carried are gone as labels.
  assert.equal(/aria-label="Fill open slots"/.test(builder), false);
  assert.equal(/aria-label=\{`Schedule \$\{session\.title\}`\}/.test(builder), false);
  // Ids come from useId, so two drawers can never collide.
  for (const component2 of [component, builder]) assert.match(component2, /\buseId\b/);
});

test("the deep-linked drawer is still server-rendered open, and React never flips it", () => {
  const component = table();
  // The server can only write the attribute; the effect upgrades it to a modal.
  assert.match(component, /open=\{serverOpen \|\| undefined\}/);
  // Frozen at mount. A prop React could re-render as false would dismiss a live
  // modal behind the dialog's own state, which is the whole reason for useState.
  assert.match(component, /const \[serverOpen\] = useState\(initiallyOpen\);/);
  assert.equal(/setServerOpen/.test(component), false);
  // Only the deep-linked selection renders open — a click-opened drawer mounts
  // closed and is opened by showModal alone.
  assert.match(
    component,
    /initiallyOpen=\{initialSelectedId !== null && selectedId === initialSelectedId\}/,
  );
  // close() would queue a `close` event that unmounts the drawer before it can
  // be re-opened modally, so the attribute is dropped directly instead.
  assert.match(component, /if \(dialog\.open\) dialog\.removeAttribute\("open"\);/);
  assert.equal(/dialog\.close\(\)/.test(component), false);
});

test("the agenda builder's two dialogs share one shell and keep their handlers", () => {
  const builder = agenda();
  assert.match(builder, /function AgendaDialog\(\{/);
  assert.equal([...builder.matchAll(/<AgendaDialog\b/g)].length, 2);
  assert.match(builder, /className="agenda-preview-dialog"/);
  assert.match(builder, /className="agenda-schedule-dialog"/);
  // A write in flight must not be discardable by Escape or a stray backdrop
  // click; both routes consult the same `busy` the buttons already disable on.
  assert.match(builder, /if \(busy\) event\.preventDefault\(\);/);
  assert.match(builder, /if \(event\.target === dialogRef\.current && !busy\) onClose\(\);/);
  // Everything the two dialogs did before still hangs off them: the preview's
  // single write path, and the editor's save/force-save/unschedule set.
  assert.match(builder, /onClick=\{onApply\}/);
  assert.match(builder, /onClick=\{\(\) => save\(false\)\}/);
  assert.match(builder, /onClick=\{\(\) => save\(true\)\}/);
  assert.match(builder, /onClick=\{onUnschedule\}/);
  // Drag-and-drop lives in the grids, not the dialogs, and is untouched.
  assert.match(builder, /onDragStart=\{/);
  assert.match(builder, /onDrop=\{/);
});

test("the replacement geometry is declared in CSS, not left to the UA stylesheet", () => {
  const css = featureCss();
  // The drawer keeps the right-edge, full-height panel the overlay produced.
  assert.match(css, /\.abstract-drawer \{/);
  assert.match(css, /margin: 0 0 0 auto;/);
  assert.match(css, /\.abstract-drawer::backdrop \{/);
  // Padding on the body, never on the dialog: `event.target === dialog` is only
  // a backdrop click if the dialog has no padding of its own to click on.
  assert.match(css, /\.abstract-drawer-body \{[^}]*padding: 24px;/);
  assert.match(css, /\.agenda-dialog-body \{[^}]*padding: 24px;/);
  for (const selector of [/\.abstract-drawer \{[^}]*padding: 0;/, /\.agenda-dialog \{[^}]*padding: 0;/]) {
    assert.match(css, selector);
  }
  assert.match(css, /\.agenda-dialog::backdrop \{/);
  // The auto-placement preview keeps its wider, height-capped card.
  assert.match(css, /\.agenda-dialog\.agenda-preview-dialog \{ width: min\(640px, calc\(100vw - 32px\)\); max-height: 85vh; \}/);
});
