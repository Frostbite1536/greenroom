import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * GRA-06. The audit's finding was a file-existence one — zero `loading.tsx`,
 * `error.tsx` or `not-found.tsx` anywhere under `app/` — so the regression it
 * guards against is a deletion, and these assertions are deliberately shaped
 * that way. Everything else here pins the two properties that make a boundary
 * useful rather than decorative: an error boundary must be able to recover, and
 * it must not show a user anything it does not understand.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));

/** Comment text stripped, so "this file says X" is asserted against code. */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const ERROR_BOUNDARIES = ["app/error.tsx", "app/(app)/error.tsx"];
const LOADING_BOUNDARIES = ["app/loading.tsx", "app/(app)/loading.tsx"];
const NOT_FOUND_BOUNDARIES = ["app/not-found.tsx", "app/(app)/not-found.tsx"];
const ALL = [...ERROR_BOUNDARIES, ...LOADING_BOUNDARIES, ...NOT_FOUND_BOUNDARIES];

test("every route segment that needs a boundary has one", () => {
  for (const path of ALL) {
    assert.ok(exists(path), `${path} must exist`);
  }
});

test("the workspace boundaries sit inside the shell, and the public ones stand alone", () => {
  // Below `app/(app)/layout.tsx`, so the sidebar and topbar survive: no <main>
  // of its own (the shell already renders one) and no full-viewport background.
  for (const path of ["app/(app)/error.tsx", "app/(app)/loading.tsx", "app/(app)/not-found.tsx"]) {
    const boundary = code(path);
    assert.doesNotMatch(boundary, /<main/, `${path} must not nest a second <main>`);
    assert.doesNotMatch(boundary, /boundary-standalone/, `${path} must not paint over the shell`);
  }
  // Outside the group there is no shell, so these own the document body.
  for (const path of ["app/error.tsx", "app/loading.tsx", "app/not-found.tsx"]) {
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

test("loading boundaries stay server components and announce themselves", () => {
  for (const path of LOADING_BOUNDARIES) {
    const boundary = read(path);
    // A skeleton has no state; making it a client component would ship bundle
    // for nothing.
    assert.doesNotMatch(boundary, /"use client"/, `${path} must stay a Server Component`);
    assert.match(boundary, /role="status"/, `${path} must expose a live region`);
    assert.match(boundary, /aria-busy="true"/, `${path} must mark itself busy`);
    // Decorative bars are hidden; the one announced string is the text.
    assert.match(boundary, /className="sr-only">Loading/, `${path} must name its state`);
    assert.match(boundary, /aria-hidden="true"/, `${path} must hide the placeholder shapes`);
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
    "skeleton-stack", "skeleton-panel", "skeleton-bar",
    "boundary", "boundary-standalone", "boundary-card", "boundary-actions", "boundary-link",
  ]) {
    assert.ok(css.includes(`.${className}`), `.${className} must be defined in globals.css`);
  }
  // The sheen animation is suppressed for readers who ask for less motion.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.skeleton-bar \{ animation: none; \} \}/);
});
