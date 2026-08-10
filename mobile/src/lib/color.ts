// Colour maths for the Apple-style *tinted* item styling: a calendar's stored
// hex becomes a translucent fill plus label colours that stay legible on it.
//
// The stored calendar colours are Material 700-weight hues (#1976D2, #388E3C,
// #455A64 …). Painted straight onto the app's black canvas as text they land
// around 3.5:1 — under the WCAG AA floor for body text — so the label is
// lightened (hue and saturation held) until it clears the target contrast
// against the fill it actually sits on. Everything is computed against the real
// composited background, never against an assumed one, so the numbers the tests
// assert are the numbers the screen renders.

type Rgb = { r: number; g: number; b: number };

// The canvas the tinted fill is composited over (CalendarScreen's screen bg).
const CANVAS: Rgb = { r: 0, g: 0, b: 0 };

// WCAG AA for normal-size text (4.5:1) is the floor both lines must clear. The
// title aims above it so the dimmed secondary line below it still reads as the
// quieter of the two.
const TITLE_CONTRAST = 5.5;
const TIME_CONTRAST = 4.5;
const TIME_ALPHA = 0.85;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const toHex = ({ r, g, b }: Rgb) =>
  '#' + [r, g, b].map((n) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, '0')).join('');

/** `#1976D2` at 22% → `rgba(25,118,210,0.22)`. Returns the input unchanged if it isn't hex. */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clamp01(alpha)})`;
}

/** Source-over composite of `fg` at `alpha` onto opaque `bg`. */
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const a = clamp01(alpha);
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

const toLinear = (channel: number) => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio between two opaque colours (1–21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl({ r, g, b }: Rgb) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
}

/**
 * Lighten `c` (hue + saturation held) just far enough to clear `target`
 * contrast against `bg`. Already-bright colours come back untouched; a colour
 * that can't reach the target even at full lightness comes back as white.
 */
function lightenToContrast(c: Rgb, bg: Rgb, target: number): Rgb {
  if (contrastRatio(c, bg) >= target) return c;
  const { h, s } = rgbToHsl(c);
  for (let l = rgbToHsl(c).l; l <= 0.98; l += 0.02) {
    const candidate = hslToRgb({ h, s, l });
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  return { r: 255, g: 255, b: 255 };
}

export type TintedChip = {
  /** Translucent calendar-colour fill. */
  fill: string;
  /** Title colour — the calendar hue, lightened to stay legible on `fill`. */
  label: string;
  /** Secondary line (start time) — the same hue, one step quieter. */
  time: string;
};

const cache = new Map<string, TintedChip>();

/**
 * The three colours an Apple-style tinted event chip needs, derived from a
 * calendar's colour. Memoized: a busy month asks for the same handful of
 * calendar colours on every row.
 */
export function tintedChip(hex: string, alpha = 0.22, canvas: Rgb = CANVAS): TintedChip {
  const key = `${hex}|${alpha}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const base = parseHex(hex);
  // Non-hex (a theme token, say): fall back to the flat colour with plain white
  // text — the pre-tint styling, which is safe on any fill.
  const value: TintedChip = base
    ? (() => {
        const fillSolid = blend(base, canvas, alpha);
        const label = lightenToContrast(base, fillSolid, TITLE_CONTRAST);
        return {
          fill: withAlpha(hex, alpha),
          label: toHex(label),
          // Dimmed a step for hierarchy, then pulled back up if that dip took
          // it under the floor (the darkest hues need it). Composited to an
          // opaque hex rather than left translucent, so the rendered colour is
          // exactly the one the contrast check measured.
          time: toHex(lightenToContrast(blend(label, fillSolid, TIME_ALPHA), fillSolid, TIME_CONTRAST)),
        };
      })()
    : { fill: hex, label: '#FFFFFF', time: 'rgba(255,255,255,0.85)' };

  cache.set(key, value);
  return value;
}
