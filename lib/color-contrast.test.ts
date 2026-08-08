import assert from "node:assert/strict";
import test from "node:test";
import {
  DARK_TEXT,
  FALLBACK_BACKGROUND,
  LIGHT_TEXT,
  contrastRatio,
  parseHex,
  readableChip,
  relativeLuminance,
} from "./color-contrast";

/** The three track colours in the seed, and what Lighthouse measured on them. */
const SEED_TRACKS = { amber: "#f59e0b", sky: "#0ea5e9", indigo: "#6366f1" };

test("relativeLuminance anchors at black and white", () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test("contrastRatio matches the known black/white extreme", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
});

test("contrastRatio reproduces the reported white-on-track failures", () => {
  // These are the numbers in requests/ops-a11y-frontend-findings.md; if they
  // drift, the fix below is being measured against the wrong baseline.
  assert.equal(contrastRatio(SEED_TRACKS.amber, LIGHT_TEXT).toFixed(2), "2.15");
  assert.equal(contrastRatio(SEED_TRACKS.sky, LIGHT_TEXT).toFixed(2), "2.77");
  assert.equal(contrastRatio(SEED_TRACKS.indigo, LIGHT_TEXT).toFixed(2), "4.47");
});

test("parseHex accepts 3- and 6-digit forms with or without #", () => {
  assert.deepEqual(parseHex("#f59e0b"), { r: 245, g: 158, b: 11 });
  assert.deepEqual(parseHex("f59e0b"), { r: 245, g: 158, b: 11 });
  assert.deepEqual(parseHex("#abc"), { r: 170, g: 187, b: 204 });
});

test("parseHex rejects anything it cannot render", () => {
  for (const bad of ["", "  ", "#12", "#12345", "rgb(1,2,3)", "red", null, undefined]) {
    assert.equal(parseHex(bad as string), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("every seeded track clears 4.5:1 after readableChip", () => {
  for (const [name, hex] of Object.entries(SEED_TRACKS)) {
    const chip = readableChip(hex);
    assert.ok(chip.ratio >= 4.5, `${name} only reached ${chip.ratio.toFixed(2)}:1`);
  }
});

test("light tracks keep their exact colour and switch to dark text", () => {
  // Preferring a text swap over recolouring keeps the operator's palette intact.
  for (const hex of [SEED_TRACKS.amber, SEED_TRACKS.sky]) {
    const chip = readableChip(hex);
    assert.equal(chip.color, DARK_TEXT);
    assert.equal(chip.background, hex);
  }
});

test("a mid-luminance track is nudged only as far as it needs", () => {
  const chip = readableChip(SEED_TRACKS.indigo);
  assert.equal(chip.color, LIGHT_TEXT);
  assert.notEqual(chip.background, SEED_TRACKS.indigo);
  assert.ok(chip.ratio >= 4.5, `reached only ${chip.ratio.toFixed(2)}:1`);
  // One 4% step; a large jump would mean the loop overshot the hue.
  assert.ok(contrastRatio(chip.background, SEED_TRACKS.indigo) < 1.2);
});

test("very dark and very light backgrounds are left alone", () => {
  const dark = readableChip("#101010");
  assert.equal(dark.color, LIGHT_TEXT);
  assert.equal(dark.background, "#101010");

  const light = readableChip("#fefefe");
  assert.equal(light.color, DARK_TEXT);
  assert.equal(light.background, "#fefefe");
});

test("readableChip falls back safely for missing or invalid colours", () => {
  for (const bad of [null, undefined, "", "not-a-colour"]) {
    const chip = readableChip(bad as string);
    assert.equal(chip.background, FALLBACK_BACKGROUND);
    assert.ok(chip.ratio >= 4.5, `fallback only reached ${chip.ratio.toFixed(2)}:1`);
  }
});

test("readableChip is deterministic across repeated calls (cache safety)", () => {
  assert.deepEqual(readableChip(SEED_TRACKS.indigo), readableChip(SEED_TRACKS.indigo));
});
