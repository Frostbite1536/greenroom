import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * GRA-06, as amended by D-C5-11 #4. The audit's finding was a file-existence
 * one — zero `error.tsx` or `not-found.tsx` anywhere under `app/` — so the
 * regression it guards against is a deletion, and these assertions are
 * deliberately shaped that way. Everything else here pins the two properties
 * that make a boundary useful rather than decorative: an error boundary must be
 * able to recover, and it must not show a user anything it does not understand.
 *
 * `loading.tsx` is DELIBERATELY ABSENT and asserted absent. A segment-level
 * loading boundary makes Next commit status 200 and start streaming before the
 * page's own `redirect()`/`notFound()` runs, so unauthorized hits to admin
 * surfaces answered 200 where the authorization contract (and five smoke
 * checks) require a real 307/404. Refusal semantics outrank a skeleton. If you
 * are re-adding one, you are re-introducing that bug.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));

/** Comment text stripped, so "this file says X" is asserted against code. */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const ERROR_BOUNDARIES = ["app/error.tsx", "app/(app)/error.tsx"];
const NOT_FOUND_BOUNDARIES = ["app/not-found.tsx", "app/(app)/not-found.tsx"];
const BANNED_LOADING_BOUNDARIES = ["app/loading.tsx", "app/(app)/loading.tsx"];
const ALL = [...ERROR_BOUNDARIES, ...NOT_FOUND_BOUNDARIES];

test("every route segment that needs a boundary has one", () => {
  for (const path of ALL) {
    assert.ok(exists(path), `${path} must exist`);
  }
});

test("no segment reintroduces a loading boundary that would break refusal statuses", () => {
  for (const path of BANNED_LOADING_BOUNDARIES) {
    assert.ok(
      !exists(path),
      `${path} must NOT exist: a segment loading boundary streams status 200 ` +
        `before redirect()/notFound() runs, breaking 307/404 refusal semantics ` +
        `on protected surfaces (D-C5-11 #4 amendment)`,
    );
  }
});

test("the workspace boundaries sit inside the shell, and the public ones stand alone", () => {
  // Below `app/(app)/layout.tsx`, so the sidebar and topbar survive: no <main>
  // of its own (the shell already renders one) and no full-viewport background.
  for (const path of ["app/(app)/error.tsx", "app/(app)/not-found.tsx"]) {
    const boundary = code(path);
    assert.doesNotMatch(boundary, /<main/, `${path} must not nest a second <main>`);
    assert.doesNotMatch(boundary, /boundary-standalone/, `${path} must not paint over the shell`);
  }
  // Outside the group there is no shell, so these own the document body.
  for (const path of ["app/error.tsx", "app/not-found.tsx"]) {
    assert.match(code(path), /<main/, `${path} must render its own <main>`);
  }
});

test("error boundaries are client components that can actually retry", () => {
  for (const path of ERROR_BOUNDARIES) {
    const boundary = read(path);
    // Next requires it, and without it the build fails on the hook/handler.
    assert.match(boundary, /^"use client";/, `${path} must be a Client Component`);
    // `retry()` refreshes the router and re-fetches the segment; `reset()`
    // alone re-renders the same failed payload, which for a failed server read
    // puts the identical error straight back. Verified against the installed
    // Next 16.3.0 error boundary, which passes both.
    assert.match(boundary, /\{ retry \}: \{ retry: \(\) => void \}/, `${path} must take retry`);
    assert.match(boundary, /onClick=\{\(\) => retry\(\)\}/, `${path} must offer the retry`);
    assert.match(boundary, /role="alert"/, `${path} must announce itself`);
  }
});

test("no boundary leaks an error message, digest, or stack to a user", () => {
  for (const path of ERROR_BOUNDARIES) {
    const boundary = code(path);
    for (const leak of [/error\.message/, /error\.digest/, /\.stack/, /JSON\.stringify/]) {
      assert.doesNotMatch(boundary, leak, `${path} must not render internals`);
    }
    // It does not even accept the error object, so it cannot render it.
    assert.doesNotMatch(boundary, /\berror\b\s*[,:}]/, `${path} must not take the error prop`);
  }
});

test("not-found boundaries are static server components with no dead links", () => {
  for (const path of NOT_FOUND_BOUNDARIES) {
    const boundary = read(path);
    assert.doesNotMatch(boundary, /"use client"/, `${path} must stay a Server Component`);
    assert.doesNotMatch(code(path), /onClick/, `${path} must not be interactive`);
  }
  // The public one links only to routes that exist in this app.
  const publicNotFound = read("app/not-found.tsx");
  assert.match(publicNotFound, /href=\{CANONICAL_SCHEDULE_PATH\}/);
  assert.match(publicNotFound, /href="\/"/);
  for (const route of ["app/schedule/page.tsx", "app/page.tsx"]) {
    assert.ok(exists(route), `${route} must exist for the not-found link to be live`);
  }
  // The workspace one deliberately links nowhere: the roles below `(app)` have
  // different homes and the shell beside it is already the correct navigation.
  assert.doesNotMatch(code("app/(app)/not-found.tsx"), /href=/);
});

test("the boundary styles the markup names are all defined", () => {
  const css = read("app/globals.css");
  for (const className of [
    "boundary", "boundary-standalone", "boundary-card", "boundary-actions", "boundary-link",
  ]) {
    assert.ok(css.includes(`.${className}`), `.${className} must be defined in globals.css`);
  }
});
