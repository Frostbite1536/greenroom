/**
 * Small CSV parser and explicit mapping layer for the admin import endpoint.
 * The quoted-cell state machine is adapted from the approved CRM CSV helper;
 * it intentionally has no dependency on that repository.
 */

import type { FormAnswerValue } from "@/lib/services/types";

export type CsvImportMapping = {
  sourceField: string;
  targetField: string;
  fallback?: string;
};

export type ParsedCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type ParsedCsv = {
  headers: string[];
  rows: ParsedCsvRow[];
};

export type CsvFormField = {
  key: string;
  type: string;
  required: boolean;
  options: unknown;
};

export class CsvImportError extends Error {}

/** Stable advisory-lock key for one import identity; JSON prevents delimiter collisions. */
export function csvAbstractImportIdentityKey(input: {
  eventId: string;
  formConfigId: string;
  speakerEmail: string;
  title: string;
}): string {
  return JSON.stringify([
    input.eventId,
    input.formConfigId,
    input.speakerEmail.trim().toLowerCase(),
    input.title.trim().toLowerCase(),
  ]);
}

const REQUIRED_ABSTRACT_TARGETS = [
  "title",
  "speakerEmail",
  "speakerName",
  "formConfigId",
] as const;

const ABSTRACT_TARGETS = new Set([
  ...REQUIRED_ABSTRACT_TARGETS,
  "abstract",
  "format",
  "durationMinutes",
  "category",
]);

type RawCsvRow = { rowNumber: number; values: string[] };

/**
 * Parse records with RFC-style quoted cells. CRLF and LF inside quotes become
 * `\n` in the value while each record keeps its starting physical row number.
 */
function parseCsvRecords(payload: string): RawCsvRow[] {
  const rows: RawCsvRow[] = [];
  let rowNumber = 1;
  let recordStartRow = 1;
  let values: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteStartRow = 1;
  let fieldStart = true;
  let afterClosingQuote = false;

  const finishRecord = () => {
    values.push(current);
    rows.push({ rowNumber: recordStartRow, values });
    values = [];
    current = "";
    fieldStart = true;
    afterClosingQuote = false;
  };

  for (let index = 0; index < payload.length; index++) {
    const character = payload[index];
    const next = payload[index + 1];

    if (inQuotes) {
      if (character === '"' && next === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        inQuotes = false;
        afterClosingQuote = true;
      } else if (character === "\r" || character === "\n") {
        current += "\n";
        if (character === "\r" && next === "\n") index++;
        rowNumber++;
      } else {
        current += character;
      }
    } else if (afterClosingQuote) {
      if (character === ",") {
        values.push(current);
        current = "";
        fieldStart = true;
        afterClosingQuote = false;
      } else if (character === "\r" || character === "\n") {
        finishRecord();
        if (character === "\r" && next === "\n") index++;
        rowNumber++;
        recordStartRow = rowNumber;
      } else {
        throw new CsvImportError(`CSV has an unexpected character after a closing quote on row ${rowNumber}.`);
      }
    } else if (character === '"') {
      if (!fieldStart) {
        throw new CsvImportError(`CSV has an unexpected quote in an unquoted value on row ${rowNumber}.`);
      }
      inQuotes = true;
      quoteStartRow = rowNumber;
    } else if (character === ",") {
      values.push(current);
      current = "";
      fieldStart = true;
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && next === "\n") index++;
      rowNumber++;
      recordStartRow = rowNumber;
    } else {
      current += character;
      fieldStart = false;
    }
  }

  if (inQuotes) {
    throw new CsvImportError(`CSV contains an unterminated quoted value starting on row ${quoteStartRow}.`);
  }
  if (current.length > 0 || values.length > 0) finishRecord();
  return rows;
}

/** Parse a comma-delimited payload, retaining original CSV row numbers for errors. */
export function parseCsv(payload: string): ParsedCsv {
  const records = parseCsvRecords(payload);
  const firstContentRecord = records.findIndex((record) => record.values.some((value) => value.trim().length > 0));
  if (firstContentRecord === -1) throw new CsvImportError("CSV payload is empty.");

  const headers = records[firstContentRecord].values
    .map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new CsvImportError("CSV headers must be non-empty.");
  }
  if (new Set(headers).size !== headers.length) {
    throw new CsvImportError("CSV headers must be unique.");
  }

  const rows: ParsedCsvRow[] = [];
  for (const record of records.slice(firstContentRecord + 1)) {
    if (!record.values.some((value) => value.trim().length > 0)) continue;
    const cells = record.values;
    if (cells.length > headers.length) {
      throw new CsvImportError(`Row ${record.rowNumber} has more values than headers.`);
    }
    rows.push({
      rowNumber: record.rowNumber,
      values: Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]?.trim() ?? ""])),
    });
  }

  if (rows.length === 0) throw new CsvImportError("CSV payload has no data rows.");
  if (rows.length > 1_000) throw new CsvImportError("CSV payload may contain at most 1,000 data rows.");
  return { headers, rows };
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) =>
    typeof option === "object" && option !== null && typeof option.value === "string"
      ? [option.value]
      : [],
  );
}

/**
 * Convert mapped answer text to the stored form-answer shape before validation.
 * Multi-select values are JSON string arrays when the cell begins with `[`, or
 * otherwise a semicolon-delimited list (`Design; Platform; Community`).
 */
export function coerceCsvAnswer(value: string, field: CsvFormField): FormAnswerValue {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (field.type === "NUMBER") {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) throw new CsvImportError(`answers.${field.key} must be a finite number.`);
    return number;
  }
  if (field.type === "CHECKBOX") {
    const normalized = trimmed.toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
    throw new CsvImportError(`answers.${field.key} must be true/false, yes/no, or 1/0.`);
  }
  if (field.type === "MULTI_SELECT") {
    let selected: string[];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
          throw new Error("not a string array");
        }
        selected = parsed.map((entry) => entry.trim()).filter(Boolean);
      } catch {
        throw new CsvImportError(`answers.${field.key} must be a JSON string array or semicolon-delimited list.`);
      }
    } else {
      selected = trimmed.split(";").map((entry) => entry.trim()).filter(Boolean);
    }
    const allowed = optionValues(field.options);
    if (allowed.length > 0 && selected.some((entry) => !allowed.includes(entry))) {
      throw new CsvImportError(`answers.${field.key} contains a value outside this field's options.`);
    }
    return selected;
  }
  if (field.type === "SELECT") {
    const allowed = optionValues(field.options);
    if (allowed.length > 0 && !allowed.includes(trimmed)) {
      throw new CsvImportError(`answers.${field.key} must match one of this field's options.`);
    }
  }
  if (field.type === "URL") {
    try {
      new URL(trimmed);
    } catch {
      throw new CsvImportError(`answers.${field.key} must be a valid URL.`);
    }
  }
  return trimmed;
}

/** Import-only required checkbox rule: false is a valid value, but not a checked required consent. */
export function validateImportedAnswers(fields: CsvFormField[], answers: Record<string, FormAnswerValue>): void {
  const uncheckedRequired = fields.find((field) => field.type === "CHECKBOX" && field.required && answers[field.key] !== true);
  if (uncheckedRequired) {
    throw new CsvImportError(`answers.${uncheckedRequired.key} must be checked.`);
  }
}

/** Validate and normalize the only targets supported by the narrow abstract importer. */
export function validateAbstractMappings(mappings: CsvImportMapping[]): CsvImportMapping[] {
  const targets = new Set<string>();
  const normalized = mappings.map((mapping) => ({
    sourceField: mapping.sourceField.trim(),
    targetField: mapping.targetField.trim(),
    fallback: mapping.fallback?.trim() || undefined,
  }));

  for (const mapping of normalized) {
    const validTarget =
      ABSTRACT_TARGETS.has(mapping.targetField) ||
      /^answers\.[a-z][a-z0-9_]*$/.test(mapping.targetField);
    if (!validTarget) {
      throw new CsvImportError(`Unsupported abstract import target: ${mapping.targetField}.`);
    }
    if (targets.has(mapping.targetField)) {
      throw new CsvImportError(`Target is mapped more than once: ${mapping.targetField}.`);
    }
    targets.add(mapping.targetField);
  }

  for (const target of REQUIRED_ABSTRACT_TARGETS) {
    if (!targets.has(target)) throw new CsvImportError(`Missing required mapping: ${target}.`);
  }
  return normalized;
}

/** Apply explicit source-to-target mappings; a fallback is used for empty cells. */
export function mapCsvRows(parsed: ParsedCsv, mappings: CsvImportMapping[]) {
  for (const mapping of mappings) {
    if (!parsed.headers.includes(mapping.sourceField) && !mapping.fallback) {
      throw new CsvImportError(`Mapped source header not found: ${mapping.sourceField}.`);
    }
  }

  return parsed.rows.map((row) => ({
    rowNumber: row.rowNumber,
    values: Object.fromEntries(
      mappings.map((mapping) => [
        mapping.targetField,
        row.values[mapping.sourceField] || mapping.fallback || "",
      ]),
    ) as Record<string, string>,
  }));
}
