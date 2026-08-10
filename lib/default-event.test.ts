import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PUBLIC_EVENT } from "./default-event";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * D-C5-9 safety rail.
 *
 * Admin event creation must never change what `/` and `/embed/*` show. The
 * property that guarantees this is that the default public event is resolved by
 * an EXPLICIT pinned slug, never by an order-sensitive rule such as "the first
 * event" or "the lowest id". These checks pin that property in place, because a
 * later refactor to `findFirst()` with no `where` would hand the judged
 * programme to whichever empty event happened to be created.
 */

test("the default public event is an explicit pinned slug, not an ordering rule", () => {
  assert.equal(DEFAULT_PUBLIC_EVENT, "forward-2026");
  const pin = source("lib/default-event.ts");
  // The module must stay dependency-free so pure policy code can import it.
  assert.equal(/^\s*import\s/m.test(pin), false);
});

test("every public default-event read matches that slug exactly and orders nothing", () => {
  const surfaces: { file: string; anchors: string[] }[] = [
    { file: "lib/data/reads.ts", anchors: ["getPublicAgenda", "getPublicSpeakers"] },
    { file: "lib/data/open-cfp.ts", anchors: ["findEvent"] },
    { file: "app/api/agenda/public/route.ts", anchors: ["findFirst"] },
  ];

  for (const { file, anchors } of surfaces) {
    const text = source(file);
    for (const anchor of anchors) {
      assert.ok(text.includes(anchor), `${file} no longer contains ${anchor}`);
    }
    // Each event lookup is an exact id-or-slug match. An unqualified findFirst
    // (no `where`) would be the order-sensitive shape this rail forbids.
    const lookups = [...text.matchAll(/prisma\.event\.findFirst\(\{([\s\S]{0,220}?)\}\)/g)]
      .concat([...text.matchAll(/tx\.event\.findFirst\(\{([\s\S]{0,220}?)\}\)/g)]);
    assert.ok(lookups.length > 0, `${file} has no event.findFirst to check`);
    for (const [, body] of lookups) {
      assert.match(body, /where:\s*\{\s*OR:\s*\[\{\s*id:\s*eventParam\s*\},\s*\{\s*slug:\s*eventParam\s*\}\]\s*\}/);
      assert.equal(/orderBy/.test(body), false, `${file} orders its default-event lookup`);
    }
  }
});

test("the landing page and both embeds fall back to the pinned slug and nothing else", () => {
  const landing = source("app/page.tsx");
  assert.match(landing, /DEFAULT_PUBLIC_EVENT/);
  // The literal must not be re-typed at a call site; it comes from the pin.
  for (const file of ["app/embed/schedule/page.tsx", "app/embed/speakers/page.tsx"]) {
    const text = source(file);
    assert.equal(/findFirst/.test(text), false, `${file} resolves its own event`);
  }
});

test("event creation writes no default-event or public-resolution state", () => {
  const route = source("app/api/admin/events/route.ts");
  assert.match(route, /requireContext\(\["ADMIN"\]\)/);
  // The create path may not touch the pin, the demo event, or any other event.
  assert.equal(/DEFAULT_PUBLIC_EVENT/.test(route), false);
  assert.equal(/demo-event/.test(route), false);
  assert.equal(/event\.update|updateMany|deleteMany|event\.delete/.test(route), false);
  // Exactly one event is created, and the creator's membership rides the same
  // transaction so an event can never exist without an administrator.
  assert.match(route, /prisma\.\$transaction\(/);
  assert.match(route, /tx\.event\.create\(/);
  assert.match(route, /tx\.eventMember\.create\(/);
  assert.match(route, /userId: ctx\.userId/);
  assert.match(route, /role: "ADMIN"/);
  assert.ok(route.indexOf("tx.event.create") < route.indexOf("tx.eventMember.create"));
  assert.match(route, /409, "EVENT_SLUG_TAKEN"/);
});
