/**
 * GRA-TZ — source contract for the two time-zone pickers.
 *
 * The reported defect: "when creating an event only UTC time zone is
 * available." Nothing was missing from the list. A `<datalist>` filters its
 * options by substring against the input's CURRENT value, and the creation
 * dialog pre-filled the field with the literal "UTC", so exactly one of the
 * twelve suggestions ever matched. The event settings form had the same shape
 * with the event's saved zone in the box.
 *
 * The fix has three parts, and the third is the one that can silently rot:
 *
 *  1. offer every zone the runtime knows, not a curated twelve;
 *  2. default the creation dialog to the organizer's own zone;
 *  3. read NEITHER of those from a render.
 *
 * Part 3 is the hydration guard. `Intl.supportedValuesOf` and
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` answer differently in Node
 * than in a browser — the server has no visitor to ask and runs in UTC — so a
 * value read while rendering puts a different DOM in the client than the server
 * sent. That is invisible in a passing build and loud in a production console,
 * which is exactly the kind of regression a source contract is for.
 *
 * These are source assertions because none of it is observable without a
 * browser: whether a datalist filtered, and whether React logged a hydration
 * mismatch, are both runtime facts. What IS checkable here is that the code
 * still has the shape those facts follow from.
 *
 * This file deliberately imports no application code, so the same assertions
 * can be replayed against the pre-fix sources to prove they are not vacuous.
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read a component with its comments removed.
 *
 * These tests assert that code is ABSENT as often as present, and this lane's
 * own comments quote the very patterns it retired ("UTC", COMMON_TIME_ZONES,
 * detectTimeZone). Without this, prose explaining the fix would fail the fix.
 */
const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
const dialog = () => source("components/new-event-dialog.tsx");
const settings = () => source("components/event-settings.tsx");

/**
 * The body of every `useEffect(() => { ... }, [])` in a component — its MOUNT
 * effects, and nothing else.
 *
 * Split rather than matched, so a mount effect that follows an effect with real
 * dependencies cannot be captured together with it: each chunk starts at one
 * effect's body and stops at the next effect's opener, and only chunks whose
 * own first closer carries an empty dependency array are kept.
 */
const mountEffects = (component: string): string[] =>
  component
    .split(/useEffect\(\(\) => \{/)
    .slice(1)
    .map((chunk) => {
      const closer = /\r?\n\s*\}, \[([^\]]*)\]\);/.exec(chunk);
      return closer && closer[1].trim() === "" ? chunk.slice(0, closer.index) : "";
    })
    .filter((body) => body !== "");

/** How many times a call appears, ignoring the bare name in an import list. */
const calls = (component: string, name: string) =>
  [...component.matchAll(new RegExp(`\\b${name}\\(`, "g"))].length;

test("the creation dialog does not hard-code UTC as the zone it starts on", () => {
  const component = dialog();
  // The defect in one line: a literal default that the datalist then filtered
  // the whole list down to. The dialog now seeds from the shared constant the
  // server also renders, and adopts the organizer's own zone after mount.
  assert.doesNotMatch(component, /useState\("UTC"\)/);
  assert.doesNotMatch(component, /setTimezone\("UTC"\)/);
  assert.equal(/"UTC"/.test(component), false, "the dialog still carries a literal UTC default");
  assert.match(component, /const \[timezone, setTimezone\] = useState\(FALLBACK_TIME_ZONE\);/);
  // Reopening the dialog must land on the same default a first open did, so
  // the reset path resets to the detected zone rather than back to the seed.
  assert.match(component, /setTimezone\(detectedZone\);/);
  assert.match(component, /const \[detectedZone, setDetectedZone\] = useState\(FALLBACK_TIME_ZONE\);/);
});

test("the creation dialog reads its zone environment only from a mount effect", () => {
  const component = dialog();
  const onMount = mountEffects(component).join("\n");
  // Both environment lookups happen after hydration has already matched.
  assert.match(onMount, /setZoneOptions\(timeZoneOptions\(supportedTimeZones\(\)\)\);/);
  assert.match(onMount, /const detected = detectTimeZone\(\);/);
  // ...and NOWHERE else. One call site each, both of them the ones above, so a
  // later edit cannot quietly move either into the render path.
  assert.equal(calls(component, "supportedTimeZones"), 1, "supportedTimeZones is called outside the mount effect");
  assert.equal(calls(component, "detectTimeZone"), 1, "detectTimeZone is called outside the mount effect");
  // Neither Intl entry point is reached directly: both live behind the lib
  // helpers that document the constraint.
  assert.equal(/\bIntl\./.test(component), false, "the dialog calls Intl directly again");
  // A zone the organizer already typed outranks the detected default.
  assert.match(onMount, /if \(!timezoneTouched\.current\) setTimezone\(detected\);/);
  assert.match(component, /timezoneTouched\.current = true;/);
});

test("the settings form reads its zone environment only from a mount effect, and never rewrites the saved zone", () => {
  const component = settings();
  const onMount = mountEffects(component).join("\n");
  assert.match(onMount, /setZoneOptions\(timeZoneOptions\(supportedTimeZones\(\)\)\);/);
  assert.equal(calls(component, "supportedTimeZones"), 1, "supportedTimeZones is called outside the mount effect");
  assert.equal(/\bIntl\./.test(component), false, "the settings form calls Intl directly");
  // This field shows a zone the event was already SAVED with. Only the
  // suggestions may be upgraded on mount; detecting a default here would
  // silently retype an organizer's stored choice on every page load.
  assert.equal(calls(component, "detectTimeZone"), 0, "the settings form detects a zone over the saved one");
  assert.doesNotMatch(onMount, /setEvent\(|updateEvent\(/);
});

test("neither picker is still limited to the twelve common zones", () => {
  for (const [name, read] of [["new-event-dialog.tsx", dialog], ["event-settings.tsx", settings]] as const) {
    const component = read();
    // The rendered list is the state the mount effect widens, not the constant.
    assert.match(component, /\{zoneOptions\.map\(/, name);
    assert.doesNotMatch(component, /COMMON_TIME_ZONES\.map\(/, name);
    // The constant survives as the hydration-safe seed — the server and the
    // client's first paint must agree on it — and as the head of the list.
    assert.match(component, /useState<readonly string\[\]>\(COMMON_TIME_ZONES\)/, name);
  }
});

test("both pickers stay free-text and put the whole list one keystroke away", () => {
  for (const [name, read, listAttr] of [
    ["new-event-dialog.tsx", dialog, /list=\{`\$\{ids\}-timezone-options`\}/],
    ["event-settings.tsx", settings, /list="event-timezone-options"/],
  ] as const) {
    const component = read();
    // An organizer in a zone no list carries can still type it, and the server
    // stays the authority on what is valid — so this must not become a <select>.
    assert.match(component, listAttr, name);
    assert.equal(/<select/.test(component), false, `${name} replaced the free-text zone field with a select`);
    // A datalist ALWAYS filters against the current value, so a field holding a
    // complete zone name offers exactly one suggestion. Selecting on focus is
    // what makes the rest of the list reachable without a manual clear.
    assert.match(component, /onFocus=\{\((event|change)\) => \1\.currentTarget\.select\(\)\}/, name);
  }
});
