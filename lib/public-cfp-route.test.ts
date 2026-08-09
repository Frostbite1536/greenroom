import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalPublicFormPath } from "./services/public-form-resolver";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("canonical public CFP paths preserve both event and form scope", () => {
  assert.equal(
    canonicalPublicFormPath({ eventSlug: "spring-conf", formSlug: "call-for-speakers" }),
    "/cfp/spring-conf/call-for-speakers",
  );
  assert.equal(
    canonicalPublicFormPath({ eventSlug: "event / 2027", formSlug: "talks & workshops" }),
    "/cfp/event%20%2F%202027/talks%20%26%20workshops",
  );
});

test("public RSC routes delegate canonical and legacy lookup to the shared resolver", () => {
  const canonicalPage = source("../app/cfp/[eventSlug]/[formSlug]/page.tsx");
  const legacyPage = source("../app/cfp/[eventSlug]/page.tsx");
  const reads = source("./data/reads.ts");

  assert.match(canonicalPage, /getPublicForm\(eventSlug, formSlug\)/);
  assert.match(legacyPage, /resolveLegacyPublishedPublicForm\(legacyFormIdOrSlug\)/);
  assert.match(legacyPage, /redirect\(canonicalPublicFormPath\(scope\)\)/);
  assert.match(reads, /resolvePublishedPublicForm\(\{ eventSlug, formSlug \}\)/);
  assert.doesNotMatch(reads.slice(reads.indexOf("// ---- Public surfaces")), /OR: \[\{ id: formId \}/);
});

test("admin public-link controls receive a server-computed canonical path", () => {
  const builder = source("../components/form-builder.tsx");
  const builderPage = source("../app/(app)/admin/forms/[formId]/page.tsx");
  const newFormDialog = source("../components/new-form-dialog.tsx");

  assert.match(builderPage, /publicFormPath=\{result\.publicFormPath\}/);
  assert.match(builder, /href=\{publicFormPath\}/);
  assert.match(builder, /\$\{location\.origin\}\$\{publicFormPath\}/);
  assert.doesNotMatch(builder, /\/cfp\/\$\{initial\.id\}/);
  assert.match(newFormDialog, /\/cfp\/\{eventSlug\}\/\{effectiveSlug/);
});
