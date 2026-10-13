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

/**
 * The sanitizer emits exactly two tag spellings: a bare `<name>`/`</name>`, and
 * the one decorated `<a>` with a vetted href. Removing those from an output
 * leaves the `<` characters the walk let through as TEXT — and the invariant
 * below is that there are none, because an output destined to be concatenated
 * with more HTML cannot be trusted to carry a half-open `<`.
 */
function strayLessThans(html: string): string[] {
  const emitted = /<a href="[^"]*" rel="noopener noreferrer nofollow" target="_blank">|<\/?[a-z0-9]+>/g;
  const text = html.replace(emitted, "");
  return text.split("<").slice(1).map((rest) => `<${rest.slice(0, 40)}`);
}

test("an unterminated tag is never passed through verbatim", () => {
  // The walk regex requires a closing `>`, so each of these used to come out of
  // the sanitizer byte-for-byte unchanged.
  for (const payload of [
    "<p>ok<img src=x onerror=alert(1)",
    '<script src="https://evil.test/x.js"',
    '<p>fine</p><iframe src="https://evil.test"',
    '<a href="javascript:alert(1)"',
    "<svg onload=alert(1)",
    "<p>x<style",
    "<p>x<!-- unterminated comment",
    "<<p>double",
  ]) {
    const out = sanitizeHtml(payload);
    assert.deepEqual(
      strayLessThans(out),
      [],
      `${JSON.stringify(payload)} left a raw "<" in ${JSON.stringify(out)}`,
    );
  }
  // Non-vacuity: the text is still there for a human to read, just inert.
  const img = sanitizeHtml("<p>ok<img src=x onerror=alert(1)");
  assert.match(img, /&lt;img src=x onerror=alert\(1\)/);
  assert.doesNotMatch(img, /<img/i);
});

test("a bare less-than in prose is escaped rather than left to start a tag", () => {
  assert.equal(sanitizeHtml("<p>1 < 2 and 3 > 2</p>"), "<p>1 &lt; 2 and 3 > 2</p>");
});

test("a leading slash followed by a backslash is not a same-origin path", () => {
  // `safeHref` admits a leading `/` as this app's own path. Browsers normalize
  // `\` to `/` in the authority position, so `/\evil.test` and `/\/evil.test`
  // resolve to `https://evil.test/` — a protocol-relative URL wearing the shape
  // of a local path. `//evil.test` was already refused; these are the same URL.
  for (const href of [
    "/\\evil.test",
    "/\\\\evil.test",
    "/\\/evil.test",
    "/\t\\evil.test",
    "/ \\evil.test",
    "/\\evil.test/phish?next=/admin",
  ]) {
    const attribute = href.replace(/"/g, "&quot;");
    assert.equal(
      sanitizeHtml(`<a href="${attribute}">x</a>`),
      "<a>x</a>",
      `${JSON.stringify(href)} must not survive as an href`,
    );
  }
  // Non-vacuity: an ordinary internal path is still a link.
  assert.match(sanitizeHtml('<a href="/admin/speakers">x</a>'), /^<a href="\/admin\/speakers"/);
  assert.match(sanitizeHtml('<a href="/api/files/clx1111111111">x</a>'), /^<a href="\/api\/files\//);
  // And a backslash INSIDE a path, where no browser reads an authority, is fine.
  assert.match(sanitizeHtml('<a href="/docs/a\\b">x</a>'), /^<a href="\/docs\/a\\b"/);
});
