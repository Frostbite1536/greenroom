import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "./sanitize-html";

test("keeps allowlisted formatting tags", () => {
  const out = sanitizeHtml("<h2>Hi</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p><ul><li>one</li></ul>");
  assert.equal(out, "<h2>Hi</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p><ul><li>one</li></ul>");
});

test("removes script elements and their contents", () => {
  const out = sanitizeHtml("<p>ok</p><script>alert('xss')</script>");
  assert.equal(out, "<p>ok</p>");
  assert.ok(!out.includes("alert"));
});

test("removes style, iframe and svg payloads entirely", () => {
  assert.equal(sanitizeHtml("<style>body{display:none}</style><p>x</p>"), "<p>x</p>");
  assert.equal(sanitizeHtml("<iframe src='http://evil.test'></iframe><p>x</p>"), "<p>x</p>");
  assert.equal(sanitizeHtml("<svg onload=alert(1)></svg><p>x</p>"), "<p>x</p>");
});

test("strips event handler attributes", () => {
  const out = sanitizeHtml('<p onclick="steal()">text</p>');
  assert.equal(out, "<p>text</p>");
  assert.ok(!out.includes("onclick"));
});

test("blocks javascript: and data: hrefs but keeps http(s)", () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
  assert.equal(sanitizeHtml('<a href="data:text/html,<script>">x</a>'), "<a>x</a>");
  assert.ok(sanitizeHtml('<a href="https://ok.test">x</a>').startsWith('<a href="https://ok.test"'));
});

test("blocks obfuscated javascript URLs using control characters", () => {
  const out = sanitizeHtml('<a href="java\nscript:alert(1)">x</a>');
  assert.equal(out, "<a>x</a>");
});

test("adds noopener/noreferrer to surviving links", () => {
  const out = sanitizeHtml('<a href="https://ok.test">x</a>');
  assert.ok(out.includes('rel="noopener noreferrer nofollow"'));
});

test("drops unknown elements but is not fooled by nesting", () => {
  const out = sanitizeHtml("<div><p>kept</p></div><object data='x'></object>");
  assert.equal(out, "<p>kept</p>");
});

test("removes html comments", () => {
  assert.equal(sanitizeHtml("<!-- sneaky --><p>x</p>"), "<p>x</p>");
});
