import assert from "node:assert/strict";
import test from "node:test";
import { formatAnswer, type AnswerField } from "./answer-display";

const select: AnswerField = {
  label: "Audience level",
  type: "SELECT",
  options: [
    { label: "Beginner", value: "beginner" },
    { label: "Advanced", value: "advanced" },
  ],
};
const multi: AnswerField = { ...select, type: "MULTI_SELECT" };
const text: AnswerField = { label: "Notes", type: "LONG_TEXT", options: null };
const check: AnswerField = { label: "Needs A/V", type: "CHECKBOX", options: null };
const url: AnswerField = { label: "Prior talk", type: "URL", options: null };

test("select values render the configured label, not the slug", () => {
  assert.equal(formatAnswer("beginner", select).text, "Beginner");
});

test("an option removed from the form falls back to the stored value", () => {
  // Editing a form must never make an existing submission unreadable.
  assert.equal(formatAnswer("expert", select).text, "expert");
});

test("multi-select joins labels in order", () => {
  assert.equal(formatAnswer(["advanced", "beginner"], multi).text, "Advanced, Beginner");
});

test("checkbox renders Yes/No, and false is an answer rather than a blank", () => {
  assert.deepEqual(formatAnswer(true, check), { text: "Yes", empty: false, isUrl: false });
  assert.deepEqual(formatAnswer(false, check), { text: "No", empty: false, isUrl: false });
});

test("blank values of every shape collapse to an em dash", () => {
  for (const blank of [null, undefined, "", "   ", []]) {
    const out = formatAnswer(blank, text);
    assert.equal(out.empty, true, `expected blank for ${JSON.stringify(blank)}`);
    assert.equal(out.text, "—");
  }
});

test("an array of only blanks is still blank", () => {
  assert.equal(formatAnswer(["", null], multi).empty, true);
});

test("numbers and plain text render as themselves", () => {
  assert.equal(formatAnswer(42, { label: "Seats", type: "NUMBER", options: null }).text, "42");
  assert.equal(formatAnswer("  hello  ", text).text, "hello");
});

test("http(s) URLs are linkable", () => {
  assert.deepEqual(formatAnswer("https://example.com/talk", url), {
    text: "https://example.com/talk",
    empty: false,
    isUrl: true,
  });
});

test("a non-http URL value is shown as inert text, never linked", () => {
  // Guards against handing an untrusted scheme to an href.
  for (const hostile of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com"]) {
    const out = formatAnswer(hostile, url);
    assert.equal(out.isUrl, false, `${hostile} must not be linkified`);
    assert.equal(out.text, hostile);
  }
});

test("a value whose type no longer matches the field still renders", () => {
  // e.g. field switched SHORT_TEXT -> SELECT after submission.
  assert.equal(formatAnswer(7, select).text, "7");
  assert.equal(formatAnswer("yes", check).text, "Yes");
});
