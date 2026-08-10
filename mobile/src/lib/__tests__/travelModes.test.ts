// Every pre-mode record (and any manual duration) must keep reading as a drive
// time — normalizeTravelMode is the single place that rule lives, and every
// reader (form seed, detail row) goes through it. See specs/features/calendar.md.
import { TRAVEL_MODES, normalizeTravelMode, travelModeLabel } from '../travelModes';

describe('travel modes', () => {
  it('offers exactly the four supported methods, drive first (the default)', () => {
    expect(TRAVEL_MODES.map((m) => m.value)).toEqual(['DRIVE', 'WALK', 'TRANSIT', 'BICYCLE']);
  });

  it('reads a record without a mode as a drive time', () => {
    expect(normalizeTravelMode(undefined)).toBe('DRIVE');
    expect(normalizeTravelMode(null)).toBe('DRIVE');
  });

  it('rejects values the server would refuse rather than passing them through', () => {
    expect(normalizeTravelMode('TWO_WHEELER')).toBe('DRIVE');
    expect(normalizeTravelMode('walk')).toBe('DRIVE');
  });

  it('keeps a stored mode as chosen', () => {
    expect(normalizeTravelMode('TRANSIT')).toBe('TRANSIT');
    expect(travelModeLabel('TRANSIT')).toBe('Transit');
    expect(travelModeLabel('BICYCLE')).toBe('Bike');
  });
});
