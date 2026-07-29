import { formatMm } from '../weatherSummary';

describe('formatMm', () => {
  it('hides trace amounts under 0.1 mm', () => {
    expect(formatMm(0)).toBeNull();
    expect(formatMm(0.05)).toBeNull();
    expect(formatMm(null)).toBeNull();
    expect(formatMm(undefined)).toBeNull();
  });

  it('keeps one decimal under 1 mm, rounds whole above', () => {
    expect(formatMm(0.4)).toBe('0.4');
    expect(formatMm(0.30000000004)).toBe('0.3'); // float noise trimmed
    expect(formatMm(1)).toBe('1');
    expect(formatMm(2.6)).toBe('3');
    expect(formatMm(12.4)).toBe('12');
  });
});
