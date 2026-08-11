/**
 * WCAG contrast helpers for operator-chosen colours.
 *
 * Track colours live in the database and are picked by event staff, so the UI
 * cannot assume a curated palette: white text on the seeded amber (`#f59e0b`)
 * measured 2.14:1, well under the 4.5:1 required for small text. Rather than
 * hardcode a "safe" palette that the next operator can break, the slot chip
 * derives a legible text colour from the background, and nudges the background
 * only when neither text colour clears the bar.
 *
 * Reference: WCAG 2.1 SC 1.4.3 (contrast minimum) and the relative-luminance
 * definition in WCAG 2.x, https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */

/** Matches `--ink` in `app/globals.css`. */
export const DARK_TEXT = "#1d2528";
export const LIGHT_TEXT = "#ffffff";
/** Used when a stored colour is missing or unparseable; 4.9:1 against white. */
export const FALLBACK_BACKGROUND = "#687276";

const MIN_RATIO = 4.5;
/** Each nudge moves 4% toward the text colour's opposite; 24 caps it at ~62%. */
const NUDGE_STEP = 0.04;
const MAX_NUDGES = 24;

type Rgb = { r: number; g: number; b: number };

/** Accepts `#rgb`, `#rrggbb`, and the same without the leading `#`. */
export function parseHex(value: string | null | undefined): Rgb | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Expand any stored track colour to the `#rrggbb` form an `<input type="color">`
 * will actually display. The column accepts `#rgb` and the bare forms too, and
 * a colour input silently shows black for anything else — so the settings
 * editor would misreport a perfectly valid stored colour as black without this.
 */
export function normalizeHex(value: string | null | undefined, fallback: string): string {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : fallback;
}

/** WCAG relative luminance of an sRGB channel triple, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const rgbA = parseHex(a);
  const rgbB = parseHex(b);
  if (!rgbA || !rgbB) return 1;
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const [hi, lo] = lA >= lB ? [lA, lB] : [lB, lA];
  return (hi + 0.05) / (lo + 0.05);
}

const cache = new Map<string, { background: string; color: string; ratio: number }>();

/**
 * Pick a legible foreground for `background`, darkening or lightening the
 * background if required to reach 4.5:1.
 *
 * The hue is preserved: the seeded amber and sky tracks simply switch to dark
 * text and are not recoloured at all; only a genuinely mid-luminance colour
 * (the seeded indigo sits at 4.47:1, a hair under) gets a single small nudge.
 */
export function readableChip(background: string | null | undefined): {
  background: string;
  color: string;
  ratio: number;
} {
  const key = background ?? "";
  const hit = cache.get(key);
  if (hit) return hit;

  const parsed = parseHex(background);
  const startHex = parsed ? toHex(parsed) : FALLBACK_BACKGROUND;
  let rgb = parsed ?? parseHex(FALLBACK_BACKGROUND)!;

  // Whichever text colour starts out more legible is the one worth keeping.
  const color =
    contrastRatio(startHex, LIGHT_TEXT) >= contrastRatio(startHex, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
  // White text wants a darker chip; dark text wants a lighter one.
  const towardWhite = color === DARK_TEXT;

  let hex = startHex;
  let ratio = contrastRatio(hex, color);
  for (let i = 0; i < MAX_NUDGES && ratio < MIN_RATIO; i++) {
    rgb = towardWhite
      ? {
          r: rgb.r + (255 - rgb.r) * NUDGE_STEP,
          g: rgb.g + (255 - rgb.g) * NUDGE_STEP,
          b: rgb.b + (255 - rgb.b) * NUDGE_STEP,
        }
      : { r: rgb.r * (1 - NUDGE_STEP), g: rgb.g * (1 - NUDGE_STEP), b: rgb.b * (1 - NUDGE_STEP) };
    hex = toHex(rgb);
    ratio = contrastRatio(hex, color);
  }

  const result = { background: hex, color, ratio };
  cache.set(key, result);
  return result;
}
