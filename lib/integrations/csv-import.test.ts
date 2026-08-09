import assert from "node:assert/strict";
import test from "node:test";
import {
  CsvImportError,
  coerceCsvAnswer,
  csvAbstractImportIdentityKey,
  MAX_CSV_IMPORT_ROWS,
  mapCsvRows,
  parseCsv,
  validateImportedAnswers,
  validateAbstractMappings,
} from "@/lib/integrations/csv-import";

test("parseCsv supports BOMs, quoted commas, and escaped quotes", () => {
  const parsed = parseCsv('\uFEFFTitle,Speaker\n"Platform, scale","Ada ""The Builder"""');

  assert.deepEqual(parsed.headers, ["Title", "Speaker"]);
  assert.deepEqual(parsed.rows, [
    {
      rowNumber: 2,
      values: { Title: "Platform, scale", Speaker: 'Ada "The Builder"' },
    },
  ]);
});

test("parseCsv preserves embedded quoted newlines and physical row diagnostics", () => {
  const parsed = parseCsv('Title,Notes\r\nTalk,"First line\r\nSecond line"\r\nNext,Done');

  assert.deepEqual(parsed.rows, [
    { rowNumber: 2, values: { Title: "Talk", Notes: "First line\nSecond line" } },
    { rowNumber: 4, values: { Title: "Next", Notes: "Done" } },
  ]);
  assert.throws(
    () => parseCsv('Title,Notes\nTalk,"missing close\nnext row'),
    (error: unknown) =>
      error instanceof CsvImportError && /unterminated quoted value starting on row 2/.test(error.message),
  );
  assert.deepEqual(
    parseCsv('Title,Notes\nTalk,"First\nSecond"\nNext,Done').rows.map((row) => row.rowNumber),
    [2, 4],
  );
});

test("parseCsv rejects quotes outside RFC-style field boundaries with physical rows", () => {
  assert.throws(
    () => parseCsv('Title,Speaker\nTalk"quoted",Ada'),
    (error: unknown) => error instanceof CsvImportError && /unexpected quote.*row 2/i.test(error.message),
  );
  assert.throws(
    () => parseCsv('Title,Speaker\n"Talk" trailing,Ada'),
    (error: unknown) => error instanceof CsvImportError && /after a closing quote.*row 2/i.test(error.message),
  );
});

test("CSV import identity keys normalize retries without delimiter collisions", () => {
  const normalized = csvAbstractImportIdentityKey({
    eventId: "event-1", formConfigId: "form-1", speakerEmail: " ADA@Example.test ", title: " My Talk ",
  });
  assert.equal(normalized, csvAbstractImportIdentityKey({
    eventId: "event-1", formConfigId: "form-1", speakerEmail: "ada@example.test", title: "my talk",
  }));
  assert.notEqual(
    csvAbstractImportIdentityKey({ eventId: "event-1", formConfigId: "form-1\u0000extra", speakerEmail: "ada@example.test", title: "my talk" }),
    normalized,
  );
});

test("parseCsv rejects an over-limit row set before any import database reads", () => {
  const rows = Array.from({ length: MAX_CSV_IMPORT_ROWS + 1 }, (_value, index) => `Talk ${index}`);
  assert.throws(
    () => parseCsv(["Title", ...rows].join("\n")),
    (error: unknown) => error instanceof CsvImportError && /at most 1,000 data rows/.test(error.message),
  );
});

test("mapped rows use explicit fallbacks when a CSV cell is empty", () => {
  const parsed = parseCsv("Title,Email,Name\nA talk,ada@example.test,Ada");
  const mappings = validateAbstractMappings([
    { sourceField: "Title", targetField: "title" },
    { sourceField: "Email", targetField: "speakerEmail" },
    { sourceField: "Name", targetField: "speakerName" },
    { sourceField: "Unused", targetField: "formConfigId", fallback: "form-1" },
    { sourceField: "Unused", targetField: "format", fallback: "Talk" },
  ]);

  assert.deepEqual(mapCsvRows(parsed, mappings), [
    {
      rowNumber: 2,
      values: {
        title: "A talk",
        speakerEmail: "ada@example.test",
        speakerName: "Ada",
        formConfigId: "form-1",
        format: "Talk",
      },
    },
  ]);
});

test("abstract mappings reject missing required and unsupported targets", () => {
  assert.throws(
    () => validateAbstractMappings([{ sourceField: "Title", targetField: "title" }]),
    (error: unknown) => error instanceof CsvImportError && /Missing required mapping/.test(error.message),
  );
  assert.throws(
    () =>
      validateAbstractMappings([
        { sourceField: "Title", targetField: "title" },
        { sourceField: "Email", targetField: "speakerEmail" },
        { sourceField: "Name", targetField: "speakerName" },
        { sourceField: "Form", targetField: "formConfigId" },
        { sourceField: "Unsafe", targetField: "status" },
      ]),
    (error: unknown) => error instanceof CsvImportError && /Unsupported abstract import target/.test(error.message),
  );
});

test("coerceCsvAnswer converts typed values and validates options", () => {
  assert.equal(
    coerceCsvAnswer("12.5", { key: "capacity", type: "NUMBER", required: false, options: null }),
    12.5,
  );
  assert.equal(
    coerceCsvAnswer("yes", { key: "consent", type: "CHECKBOX", required: true, options: null }),
    true,
  );
  assert.equal(
    coerceCsvAnswer("0", { key: "consent", type: "CHECKBOX", required: true, options: null }),
    false,
  );
  assert.deepEqual(
    coerceCsvAnswer("Design; Platform", {
      key: "topics",
      type: "MULTI_SELECT",
      required: false,
      options: [{ label: "Design", value: "Design" }, { label: "Platform", value: "Platform" }],
    }),
    ["Design", "Platform"],
  );
  assert.deepEqual(
    coerceCsvAnswer('["Design", "Platform"]', {
      key: "topics",
      type: "MULTI_SELECT",
      required: false,
      options: null,
    }),
    ["Design", "Platform"],
  );
  assert.throws(
    () => coerceCsvAnswer("maybe", { key: "consent", type: "CHECKBOX", required: true, options: null }),
    CsvImportError,
  );
  assert.throws(
    () =>
      coerceCsvAnswer("Other", {
        key: "track",
        type: "SELECT",
        required: false,
        options: [{ label: "Main", value: "Main" }],
      }),
    CsvImportError,
  );
  assert.throws(
    () => coerceCsvAnswer("not a URL", { key: "website", type: "URL", required: false, options: null }),
    CsvImportError,
  );
  assert.throws(
    () => coerceCsvAnswer("javascript:alert(1)", { key: "website", type: "URL", required: false, options: null }),
    CsvImportError,
  );
});

test("required imported checkboxes must be checked", () => {
  const field = { key: "consent", type: "CHECKBOX", required: true, options: null };
  assert.throws(() => validateImportedAnswers([field], { consent: false }), CsvImportError);
  assert.doesNotThrow(() => validateImportedAnswers([field], { consent: true }));
});
