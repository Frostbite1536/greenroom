/**
 * Small CSV parser and explicit mapping layer for the admin import endpoint.
 * The quoted-cell state machine is adapted from the approved CRM CSV helper;
 * it intentionally has no dependency on that repository.
 */

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

export class CsvImportError extends Error {}

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

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const next = line[index + 1];

    if (inQuotes) {
      if (character === '"' && next === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  if (inQuotes) throw new CsvImportError("CSV contains an unterminated quoted value.");
  values.push(current);
  return values;
}

/** Parse a comma-delimited payload, retaining original CSV row numbers for errors. */
export function parseCsv(payload: string): ParsedCsv {
  const lines = payload.split(/\r?\n/);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine === -1) throw new CsvImportError("CSV payload is empty.");

  const headers = parseCsvLine(lines[firstContentLine])
    .map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new CsvImportError("CSV headers must be non-empty.");
  }
  if (new Set(headers).size !== headers.length) {
    throw new CsvImportError("CSV headers must be unique.");
  }

  const rows: ParsedCsvRow[] = [];
  for (let index = firstContentLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (cells.length > headers.length) {
      throw new CsvImportError(`Row ${index + 1} has more values than headers.`);
    }
    rows.push({
      rowNumber: index + 1,
      values: Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]?.trim() ?? ""])),
    });
  }

  if (rows.length === 0) throw new CsvImportError("CSV payload has no data rows.");
  if (rows.length > 1_000) throw new CsvImportError("CSV payload may contain at most 1,000 data rows.");
  return { headers, rows };
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
