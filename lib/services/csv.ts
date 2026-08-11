/**
 * The one CSV writer every export in this app goes through.
 *
 * Extracted verbatim from `lib/services/decision-export-csv.ts` (ABS-13) when
 * the reports lane added three more exports. Not copied — *moved*: a second
 * implementation of "which characters make a spreadsheet execute a cell" is
 * exactly how one export ends up safe and another one dangerous. The decision
 * export re-exports `csvCell`/`csvRow` from here, so its own tests and callers
 * are unchanged and there is still only one escaper in the codebase.
 */

/** RFC 4180 record separator. Excel and Sheets both expect CRLF. */
export const CRLF = "\r\n";

/**
 * Leading characters a spreadsheet treats as the start of a formula. A cell
 * beginning with one is prefixed with `'` so an imported proposal title, speaker
 * name, or room name can never execute in the recipient's spreadsheet.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Escape one cell: formula guard first, then RFC 4180 quoting.
 *
 * The guard runs before quoting so the apostrophe lands inside the quoted
 * value. It is applied to every cell, including numeric ones, which means a
 * negative number exports as text rather than a number. That is the intended
 * trade: a safe export beats a marginally tidier one.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "number" ? String(value) : value;
  if (raw === "") return "";
  const guarded = FORMULA_LEAD.has(raw[0]) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Assemble a document from a header row, its records, and an optional final
 * comment row. Every export in this app has that exact shape, and the trailing
 * CRLF after the last record is part of it.
 */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
  notice?: string | null,
): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  if (notice) lines.push(csvRow([notice]));
  return lines.join(CRLF) + CRLF;
}

/**
 * A dated, input-free download name: nothing user-supplied reaches the
 * `Content-Disposition` header. `slug` is a literal chosen at the call site.
 */
export function csvFilename(slug: string, now: Date = new Date()): string {
  return `greenroom-${slug}-${now.toISOString().slice(0, 10)}.csv`;
}
