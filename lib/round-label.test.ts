import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { roundLabel, roundNameSuffix } from "./round-label";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the reported regression: the round number is never printed twice", () => {
  // The exact string the evaluations UI rendered, from the exact stored name
  // both the seed (lib/demo/seed.ts) and the New round dialog default to.
  assert.equal(
    roundLabel({ ordinal: 1, name: "Round 1 — Program Committee" }),
    "Round 1 — Program Committee",
  );
  assert.equal(roundLabel({ ordinal: 1, name: "Round 1 — Program Committee" }).match(/Round 1/g)?.length, 1);
  assert.equal(
    roundLabel({ ordinal: 2, name: "Round 2 — Program Committee" }),
    "Round 2 — Program Committee",
  );
});

test("a name that adds nothing collapses to the round number alone", () => {
  assert.equal(roundLabel({ ordinal: 1, name: "Round 1" }), "Round 1");
  assert.equal(roundLabel({ ordinal: 3, name: "  Round 3  " }), "Round 3");
  assert.equal(roundLabel({ ordinal: 1, name: "Round 1 —" }), "Round 1");
  // Defensive: the schema requires a name, but an empty one must not render a
  // dangling separator.
  assert.equal(roundLabel({ ordinal: 4, name: "" }), "Round 4");
  assert.equal(roundNameSuffix({ ordinal: 1, name: "Round 1" }), null);
  assert.equal(roundNameSuffix({ ordinal: 1, name: "" }), null);
});

test("a name carrying real information keeps all of it", () => {
  assert.equal(
    roundLabel({ ordinal: 1, name: "Program Committee" }),
    "Round 1 — Program Committee",
  );
  assert.equal(roundNameSuffix({ ordinal: 1, name: "Program Committee" }), "Program Committee");
  // A name that merely starts with a word beginning "round" is not a prefix.
  assert.equal(
    roundLabel({ ordinal: 1, name: "Rounds and rebuttals" }),
    "Round 1 — Rounds and rebuttals",
  );
  assert.equal(
    roundLabel({ ordinal: 1, name: "Roundtable screening" }),
    "Round 1 — Roundtable screening",
  );
});

test("every separator an author plausibly types is collapsed, not just the em dash", () => {
  for (const separator of ["—", "–", "-", ":", "·", "|"]) {
    assert.equal(
      roundLabel({ ordinal: 2, name: `Round 2 ${separator} Chairs` }),
      "Round 2 — Chairs",
      separator,
    );
  }
  // No separator at all, and no space after the number.
  assert.equal(roundLabel({ ordinal: 2, name: "Round 2 Chairs" }), "Round 2 — Chairs");
  assert.equal(roundLabel({ ordinal: 2, name: "Round2 — Chairs" }), "Round 2 — Chairs");
  // Case is the author's business, not the matcher's.
  assert.equal(roundLabel({ ordinal: 2, name: "ROUND 2 — Chairs" }), "Round 2 — Chairs");
  assert.equal(roundLabel({ ordinal: 2, name: "round 2 — Chairs" }), "Round 2 — Chairs");
});

test("a name naming a DIFFERENT round is shown in full, never silently hidden", () => {
  // The ordinal is the authority for the number; the name disagreeing with it
  // is a real data problem an organizer needs to see in order to fix it.
  assert.equal(
    roundLabel({ ordinal: 1, name: "Round 2 — Rebuttals" }),
    "Round 1 — Round 2 — Rebuttals",
  );
  assert.equal(roundNameSuffix({ ordinal: 1, name: "Round 2 — Rebuttals" }), "Round 2 — Rebuttals");
  // "Round 1" must not swallow the prefix of "Round 10".
  assert.equal(
    roundLabel({ ordinal: 1, name: "Round 10 — Finals" }),
    "Round 1 — Round 10 — Finals",
  );
  assert.equal(roundLabel({ ordinal: 10, name: "Round 10 — Finals" }), "Round 10 — Finals");
});

test("every surface that prints a round composes it through this module", () => {
  // The regression was four independent `Round ${ordinal} — ${name}` template
  // literals. Pinned by source so a fifth cannot reintroduce it.
  for (const path of [
    "components/abstracts-table.tsx",
    "components/evaluation-workspace.tsx",
    "components/evaluation-setup.tsx",
    "lib/services/decision-export-csv.ts",
  ]) {
    const file = source(path);
    assert.match(file, /from "@\/lib\/round-label"/, path);
    // CRLF-safe: `[^\r\n]*` rather than a dot that must not cross lines.
    assert.equal(
      /`Round \$\{[^\r\n]*\} — \$\{[^\r\n]*\}`/.test(file),
      false,
      `${path} still composes a round label inline`,
    );
  }
});
