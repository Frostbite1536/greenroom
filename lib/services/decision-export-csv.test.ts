import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionExportCsv,
  csvCell,
  csvRow,
  decisionExportFilename,
  DECISION_EXPORT_HEADER,
  type DecisionExportInput,
  type DecisionExportRow,
} from "@/lib/services/decision-export-csv";

// --- cell escaping ----------------------------------------------------------

test("a plain cell is emitted unquoted", () => {
  assert.equal(csvCell("Distributed systems"), "Distributed systems");
  assert.equal(csvCell(4), "4");
});

test("null, undefined, and empty string all become an empty cell", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(""), "");
});

test("commas, quotes, and newlines are quoted and doubled per RFC 4180", () => {
  assert.equal(csvCell("Scaling, safely"), '"Scaling, safely"');
  assert.equal(csvCell('The "hard" parts'), '"The ""hard"" parts"');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("carriage\rreturn"), '"carriage\rreturn"');
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
});

test("a cell that would run as a spreadsheet formula is neutralized", () => {
  // A proposal title is untrusted text: it must never execute on open.
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+44 800 000"), "'+44 800 000");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@import"), "'@import");
  // A tab is not a CSV special character, so it is guarded but not quoted.
  assert.equal(csvCell("\tlead tab"), "'\tlead tab");
});

test("the formula guard lands inside the quotes when a cell also needs quoting", () => {
  // `'=x` outside the quotes would be a malformed record, not a safe one.
  assert.equal(csvCell('=cmd|"calc"!A1'), `"'=cmd|""calc""!A1"`);
  assert.equal(csvCell("=a,b"), `"'=a,b"`);
});

test("a formula lead only counts in the first position", () => {
  assert.equal(csvCell("Kafka + Flink"), "Kafka + Flink");
  assert.equal(csvCell("2 = two"), "2 = two");
});

test("a row joins escaped cells with commas", () => {
  assert.equal(csvRow(["a", "b,c", null, 3]), 'a,"b,c",,3');
});

// --- document assembly ------------------------------------------------------

const rows: DecisionExportRow[] = [
  {
    id: "abs-1",
    title: "Scaling, safely",
    status: "ACCEPTED",
    categoryName: "Platform",
    speakerNames: ["Ada Lovelace", "Grace Hopper"],
    submittedAt: "2026-02-01T10:00:00.000Z",
    decidedAt: "2026-03-02T09:00:00.000Z",
  },
  {
    id: "abs-2",
    title: "=SUM(A1:A9)",
    status: "SUBMITTED",
    categoryName: null,
    speakerNames: [],
    submittedAt: null,
    decidedAt: null,
  },
];

const baseInput: DecisionExportInput = {
  rows,
  summariesByAbstractId: {
    "abs-1": { completedAssignments: 3, includedReviews: 2, weightedAverage: 4.25 },
    "abs-2": { completedAssignments: 0, includedReviews: 0, weightedAverage: null },
  },
  selectedPlan: { id: "plan-1", name: "Programme review", ordinal: 1 },
  total: 2,
  hasMore: false,
};

function lines(csv: string): string[] {
  return csv.split("\r\n").filter((line) => line.length > 0);
}

test("the header row is the documented column contract", () => {
  assert.equal(
    lines(buildDecisionExportCsv(baseInput))[0],
    "abstract_id,title,status,category,speakers,submitted_at,decided_at,review_round,completed_reviews,included_reviews,weighted_average",
  );
  assert.equal(DECISION_EXPORT_HEADER.length, 11);
});

test("every record ends with CRLF, including the last one", () => {
  const csv = buildDecisionExportCsv(baseInput);
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(lines(csv).length, 3);
});

test("a row carries the summary numbers verbatim and the selected round label", () => {
  const [, first] = lines(buildDecisionExportCsv(baseInput));
  assert.equal(
    first,
    'abs-1,"Scaling, safely",ACCEPTED,Platform,Ada Lovelace; Grace Hopper,2026-02-01T10:00:00.000Z,2026-03-02T09:00:00.000Z,Round 1 — Programme review,3,2,4.25',
  );
});

test("a null weighted average is blank, never zero", () => {
  // Zero is a real score. Reporting "no valid reviews yet" as 0.00 would invent
  // a finding an organizer could act on.
  const [, , second] = lines(buildDecisionExportCsv(baseInput));
  assert.ok(second.endsWith(",0,0,"));
  assert.ok(!second.endsWith("0.00"));
});

test("a formula-shaped proposal title is neutralized in the assembled document", () => {
  const csv = buildDecisionExportCsv(baseInput);
  assert.ok(csv.includes("'=SUM(A1:A9)"));
  assert.ok(!csv.includes(",=SUM"));
});

test("an abstract missing from the summary map exports blank counts, not zeros", () => {
  const csv = buildDecisionExportCsv({ ...baseInput, summariesByAbstractId: {} });
  const [, first] = lines(csv);
  assert.ok(first.endsWith(",,,"), first);
});

test("no evaluation plan yields an empty round cell rather than an invented name", () => {
  const [, first] = lines(buildDecisionExportCsv({ ...baseInput, selectedPlan: null }));
  assert.ok(first.includes(",,3,2,4.25"), first);
});

test("a truncated export states its own bound in a final comment row", () => {
  const csv = buildDecisionExportCsv({ ...baseInput, total: 250, hasMore: true });
  const all = lines(csv);
  assert.equal(all.length, 4);
  assert.equal(
    all[all.length - 1],
    "# Truncated: this export contains the newest 2 of 250 recorded proposals; older proposals are not included in this export.",
  );
});

test("the truncation notice recommends no next step this route cannot honour", () => {
  // The endpoint takes `planId` and nothing else. Telling an operator to narrow
  // by status or form would send them looking for a control the export does not
  // have, so the notice names the limit instead of inventing a workflow.
  const last = lines(buildDecisionExportCsv({ ...baseInput, total: 250, hasMore: true })).at(-1) ?? "";
  assert.ok(!/\bfilter\b/i.test(last), last);
  assert.ok(!/export again|try again|narrow/i.test(last), last);
  assert.ok(last.includes("not included in this export"), last);
});

test("an untruncated export adds no comment row", () => {
  assert.ok(!buildDecisionExportCsv(baseInput).includes("# Truncated"));
});

test("the export carries no evaluator identity for any input shape", () => {
  // The summary type has no evaluator field, so this is a guard against a
  // future widening: the whole document must stay free of reviewer identity.
  const csv = buildDecisionExportCsv({ ...baseInput, total: 250, hasMore: true });
  assert.ok(!/evaluator/i.test(csv));
  assert.ok(!/reviewer/i.test(csv));
  for (const column of DECISION_EXPORT_HEADER) {
    assert.ok(!/evaluator|reviewer_id|reviewer_name/i.test(column), column);
  }
});

test("an empty event still exports a usable header-only document", () => {
  const csv = buildDecisionExportCsv({ ...baseInput, rows: [], total: 0, hasMore: false });
  assert.equal(lines(csv).length, 1);
  assert.ok(csv.startsWith("abstract_id,"));
});

// --- download name ----------------------------------------------------------

test("the filename is fixed and input-free, so nothing user-supplied reaches the header", () => {
  const name = decisionExportFilename(new Date("2026-08-10T12:00:00.000Z"));
  assert.equal(name, "greenroom-review-results-2026-08-10.csv");
  assert.ok(!/["\r\n;]/.test(name));
});
