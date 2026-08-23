// COLOR_PRESETS lives in calendarPrefs, which touches AsyncStorage at import.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { tintedChip, withAlpha, parseHex, contrastRatio, vividOnDark, luminance } from '../color';
import { COLOR_PRESETS } from '../calendarPrefs';

const BLACK = { r: 0, g: 0, b: 0 };

// The opaque color a translucent fill resolves to over the calendar's black
// canvas — what the chip's text is actually read against.
const fillOverBlack = (hex: string, alpha = 0.22) => {
  const c = parseHex(hex)!;
  return { r: c.r * alpha, g: c.g * alpha, b: c.b * alpha };
};

describe('withAlpha', () => {
  it('expands a hex to rgba', () => {
    expect(withAlpha('#1976D2', 0.22)).toBe('rgba(25, 118, 210, 0.22)');
  });

  it('accepts shorthand hex and clamps alpha', () => {
    expect(withAlpha('#abc', 2)).toBe('rgba(170, 187, 204, 1)');
  });

  it('returns a non-hex color untouched', () => {
    expect(withAlpha('rgba(1,2,3,0.5)', 0.2)).toBe('rgba(1,2,3,0.5)');
  });
});

describe('vividOnDark', () => {
  // Rough hue from RGB — enough to assert the lift doesn't rotate the color.
  const hue = (hex: string) => {
    const { r, g, b } = parseHex(hex)!;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60) % 360;
  };

  it.each(COLOR_PRESETS)('brightens the stored hue %s without rotating it', (hex) => {
    const lifted = vividOnDark(hex);
    expect(luminance(parseHex(lifted)!)).toBeGreaterThan(luminance(parseHex(hex)!));
    expect(Math.abs(hue(lifted) - hue(hex))).toBeLessThan(8);
  });

  it('leaves an already-bright color alone', () => {
    expect(vividOnDark('#F8BBD0')).toBe('#F8BBD0');
  });

  it('returns non-hex input unchanged', () => {
    expect(vividOnDark('rgba(1,2,3,0.5)')).toBe('rgba(1,2,3,0.5)');
  });
});

describe('tintedChip', () => {
  it('fills with the calendar color at low alpha', () => {
    expect(tintedChip('#1976D2').fill).toBe('rgba(25, 118, 210, 0.22)');
  });

  // The whole point of the lightening pass: the stored Material-700 hues are
  // too dark to read as text on their own tint.
  it('lightens a dark calendar color that would fail unaided', () => {
    const raw = parseHex('#1976D2')!;
    const bg = fillOverBlack('#1976D2');
    expect(contrastRatio(raw, bg)).toBeLessThan(4.5);
    expect(contrastRatio(parseHex(tintedChip('#1976D2').label)!, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(COLOR_PRESETS)('clears WCAG AA for title and time on %s', (hex) => {
    const bg = fillOverBlack(hex);
    const { label, time } = tintedChip(hex);
    expect(contrastRatio(parseHex(label)!, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(parseHex(time)!, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the time quieter than the title', () => {
    const { label, time } = tintedChip('#1976D2');
    const bg = fillOverBlack('#1976D2');
    expect(contrastRatio(parseHex(time)!, bg)).toBeLessThan(contrastRatio(parseHex(label)!, bg));
  });

  it('leaves an already-bright color alone', () => {
    expect(tintedChip('#FFFFFF').label.toUpperCase()).toBe('#FFFFFF');
  });

  it('is stable across calls (memoized)', () => {
    expect(tintedChip('#43A047')).toEqual(tintedChip('#43A047'));
  });

  it('falls back to white text on a color it cannot parse', () => {
    const t = tintedChip('not-a-color');
    expect(t).toEqual({ fill: 'not-a-color', label: '#FFFFFF', time: 'rgba(255,255,255,0.85)' });
  });

  it('never returns a fill that reads as opaque against the canvas', () => {
    const bg = fillOverBlack('#F9A825');
    expect(contrastRatio(bg, BLACK)).toBeLessThan(2);
  });
});
