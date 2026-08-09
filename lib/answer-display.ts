/**
 * Present stored CFP answers to an admin.
 *
 * `FormAnswer.value` is a JSON column, so a value can legitimately be a string,
 * number, boolean or string[] — and, for a field whose type or options changed
 * after submission, something that no longer matches the field at all. Every
 * case has to render as readable text rather than `[object Object]` or a raw
 * option slug: these screens are read by event producers, not engineers.
 */

export type AnswerField = {
  label: string;
  type: string;
  options: { label: string; value: string }[] | null;
};

export type FormattedAnswer = {
  /** Display text; `"—"` when there is nothing to show. */
  text: string;
  /** True when the speaker left this field blank. */
  empty: boolean;
  /** True when the value should render as a link. */
  isUrl: boolean;
};

const BLANK: FormattedAnswer = { text: "—", empty: true, isUrl: false };

/** Option slugs are meaningless to an admin — show the label they configured. */
function optionLabel(field: AnswerField, raw: string): string {
  const match = field.options?.find((o) => o.value === raw);
  return match ? match.label : raw;
}

const MAX_DISPLAY_CHARS = 5_000;

/** Legacy JSON can predate today's field contract; keep its fallback readable and bounded. */
function readableValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "Unsupported saved answer";
    }
  }
  return text.length > MAX_DISPLAY_CHARS
    ? `${text.slice(0, MAX_DISPLAY_CHARS - 1)}…`
    : text;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function formatAnswer(value: unknown, field: AnswerField): FormattedAnswer {
  if (isBlank(value)) return BLANK;

  // A checkbox is the one type where `false` is a real answer, not a blank.
  if (typeof value === "boolean") {
    return { text: value ? "Yes" : "No", empty: false, isUrl: false };
  }

  if (Array.isArray(value)) {
    const labels = value
      .filter((v) => !isBlank(v))
      .map((v) => {
        const text = readableValue(v);
        return typeof v === "string" ? optionLabel(field, text) : text;
      })
      .filter(Boolean);
    if (labels.length === 0) return BLANK;
    return { text: labels.join(", "), empty: false, isUrl: false };
  }

  if ((field.type === "SELECT" || field.type === "MULTI_SELECT") && typeof value === "string") {
    return { text: optionLabel(field, value), empty: false, isUrl: false };
  }

  const text = readableValue(value);
  if (text === "") return BLANK;

  // Only ever linkify http(s); a stored `javascript:` value must stay inert
  // text (INV-HTML-001 in spirit — never hand an untrusted string to an href).
  const isUrl = field.type === "URL" && /^https?:\/\//i.test(text);
  return { text, empty: false, isUrl };
}
