import { currencyForCountry, currencySymbol } from '../currency';

describe('currencyForCountry', () => {
  it('maps major destinations to their local currency', () => {
    expect(currencyForCountry('CA')).toBe('CAD');
    expect(currencyForCountry('US')).toBe('USD');
    expect(currencyForCountry('JP')).toBe('JPY');
    expect(currencyForCountry('GB')).toBe('GBP');
  });

  it('maps every eurozone country to EUR', () => {
    for (const c of ['FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'IE', 'GR', 'HR']) {
      expect(currencyForCountry(c)).toBe('EUR');
    }
  });

  it('is case-insensitive and null-safe', () => {
    expect(currencyForCountry('fr')).toBe('EUR');
    expect(currencyForCountry(null)).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
    expect(currencyForCountry('')).toBeNull();
  });

  it('returns null for an unmapped country rather than guessing', () => {
    expect(currencyForCountry('ZZ')).toBeNull();
  });
});

describe('currencySymbol', () => {
  it('returns the display glyph for common currencies', () => {
    expect(currencySymbol('CAD')).toBe('$');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('JPY')).toBe('¥');
    expect(currencySymbol('INR')).toBe('₹');
  });

  it('falls back to the ISO code when no glyph is mapped', () => {
    expect(currencySymbol('CHF')).toBe('CHF');
    expect(currencySymbol('aed')).toBe('AED');
  });

  it('returns empty for no currency', () => {
    expect(currencySymbol('')).toBe('');
    expect(currencySymbol(null)).toBe('');
    expect(currencySymbol(undefined)).toBe('');
  });
});
