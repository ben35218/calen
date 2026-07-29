import {
  formatAsYouType,
  formatAsTyped,
  toE164,
  toE164FromTyped,
  seedTyped,
  parseStored,
  formatDisplay,
  flagEmoji,
  COUNTRIES,
} from '../phone';

describe('toE164', () => {
  it('assembles E.164 from a US national number', () => {
    expect(toE164('(555) 123-4567', 'US')).toBe('+15551234567');
  });

  it('assembles E.164 for a non-US country', () => {
    // UK national 20 7946 0018 → +44 20 7946 0018.
    expect(toE164('020 7946 0018', 'GB')).toBe('+442079460018');
  });

  it('best-effort assembles partial input rather than dropping it', () => {
    // Too short to be a valid number, but we still keep the digits under +1.
    expect(toE164('555', 'US')).toBe('+1555');
  });

  it('returns empty for empty input', () => {
    expect(toE164('', 'US')).toBe('');
  });
});

describe('parseStored', () => {
  it('recovers country + national display from E.164 (fallback calling code matches)', () => {
    const { country, national } = parseStored('+15551234567', 'US');
    expect(country).toBe('US');
    expect(national).toBe('(555) 123-4567');
  });

  it('keeps a valid country-specific E.164 regardless of fallback', () => {
    // A GB national number resolves unambiguously to GB even with a US fallback.
    const { country } = parseStored('+442079460018', 'US');
    expect(country).toBe('GB');
  });

  it('parses a legacy bare-digit value using the fallback country', () => {
    const { country, national } = parseStored('5551234567', 'US');
    expect(country).toBe('US');
    expect(national).toBe('(555) 123-4567');
  });

  it('returns the fallback country and empty national for a blank value', () => {
    expect(parseStored('', 'US')).toEqual({ country: 'US', national: '' });
    expect(parseStored(null, 'GB')).toEqual({ country: 'GB', national: '' });
  });
});

describe('formatAsYouType', () => {
  it('formats a US number progressively', () => {
    expect(formatAsYouType('5551234567', 'US')).toBe('(555) 123-4567');
  });

  it('ignores existing formatting characters (idempotent on the display string)', () => {
    expect(formatAsYouType('(555) 123-4567', 'US')).toBe('(555) 123-4567');
  });
});

describe('formatAsTyped (picker-free entry)', () => {
  it('formats a "+"-prefixed value as international, inferring the country', () => {
    const out = formatAsTyped('+442079460018');
    expect(out.startsWith('+44')).toBe(true);
    expect(out.replace(/\D/g, '')).toBe('442079460018');
  });

  it('formats a local (no "+") number for the device region, preserving digits', () => {
    // Exact grouping depends on the device region; the digits always survive.
    expect(formatAsTyped('5551234567').replace(/\D/g, '')).toBe('5551234567');
  });

  it('returns empty for empty input', () => {
    expect(formatAsTyped('')).toBe('');
  });
});

describe('toE164FromTyped (picker-free entry)', () => {
  it('parses a "+"-prefixed international number to E.164', () => {
    expect(toE164FromTyped('+44 20 7946 0018')).toBe('+442079460018');
  });

  it('best-effort keeps a "+"-prefixed partial rather than dropping it', () => {
    expect(toE164FromTyped('+44 20')).toBe('+4420');
  });

  it('returns empty for empty/whitespace input', () => {
    expect(toE164FromTyped('')).toBe('');
    expect(toE164FromTyped('   ')).toBe('');
  });
});

describe('seedTyped (picker-free editor seed)', () => {
  it('mirrors formatDisplay for a stored value', () => {
    expect(seedTyped('+15551234567')).toBe(formatDisplay('+15551234567'));
  });

  it('returns empty for a blank value', () => {
    expect(seedTyped('')).toBe('');
    expect(seedTyped(null)).toBe('');
  });
});

describe('formatDisplay', () => {
  it('returns the raw value unchanged when it cannot be parsed', () => {
    expect(formatDisplay('not a number')).toBe('not a number');
  });

  it('returns empty for a blank value', () => {
    expect(formatDisplay('')).toBe('');
    expect(formatDisplay(undefined)).toBe('');
  });

  it('formats a parseable E.164 value', () => {
    // Exact national vs international form depends on the device region; either
    // way the digits survive and it is no longer raw E.164.
    expect(formatDisplay('+15551234567')).toContain('555');
  });
});

describe('flagEmoji + COUNTRIES', () => {
  it('derives a flag emoji from an ISO code', () => {
    expect(flagEmoji('US')).toBe('🇺🇸');
    expect(flagEmoji('gb')).toBe('🇬🇧');
  });

  it('exposes a sorted, non-empty country list with calling codes', () => {
    expect(COUNTRIES.length).toBeGreaterThan(100);
    const us = COUNTRIES.find((c) => c.code === 'US');
    expect(us?.callingCode).toBe('1');
  });
});
