import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("S1 direct event-owned writers lock and authorize stored rows before their write", () => {
  const rooms = source("app/api/admin/settings/rooms/route.ts");
  const roomPatch = rooms.slice(rooms.indexOf("export const PATCH"), rooms.indexOf("export const DELETE"));
  assert.match(roomPatch, /prisma\.\$transaction\(/);
  assert.match(roomPatch, /FROM "Room" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(roomPatch, /requireEventOwnedRow\(existing, ctx\.eventId, "ROOM_NOT_FOUND", "Room"\)/);
  assert.ok(roomPatch.indexOf("FOR UPDATE") < roomPatch.indexOf("tx.room.update"));

  const templates = source("app/api/comms/templates/[templateId]/route.ts");
  assert.match(templates, /prisma\.\$transaction\(/);
  assert.match(templates, /FROM "EmailTemplate" WHERE "id" = \$\{templateId\} FOR UPDATE/);
  assert.match(templates, /requireEventOwnedRow\(existing, auth\.eventId, "TEMPLATE_NOT_FOUND", "Template"\)/);
  assert.ok(templates.indexOf("FOR UPDATE") < templates.indexOf("tx.emailTemplate.update"));
});

test("S1 form writes derive creates from context and preserve the narrow Abstract delete guard under its parent lock", () => {
  const forms = source("app/api/cfp/forms/route.ts");
  assert.match(forms, /create: \{ eventId: ctx\.eventId, \.\.\.data \}/);
  assert.doesNotMatch(forms, /assertEventScope/);
  assert.match(forms, /lockFormConfigForShapeWrite\(tx, input\.id\)/);

  const formDelete = source("app/api/cfp/forms/[formId]/route.ts");
  assert.match(formDelete, /prisma\.\$transaction\(/);
  assert.match(formDelete, /lockFormConfigForShapeWrite\(tx, formId\)/);
  assert.match(formDelete, /requireEventOwnedRow\(existing, auth\.eventId, "FORM_NOT_FOUND", "Form"\)/);
  assert.match(formDelete, /tx\.abstract\.count\(\{ where: \{ formConfigId: form\.id \} \}\)/);
  assert.match(formDelete, /"FORM_HAS_ABSTRACTS"/);
  assert.match(formDelete, /tx\.formConfig\.delete\(\{ where: \{ id: form\.id \} \}\)/);
  assert.doesNotMatch(formDelete, /tx\.speakerTask|catch \(error\)/);
});
