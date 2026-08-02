import {
  collectOccasions, whenLabel, PAST_WINDOW_DAYS, COMING_UP_DAYS,
} from '../occasions';
import type { Person } from '../../api';

const person = (p: Partial<Person> & { _id: string; name: string }) => p as Person;

// A fixed "today" so the windowing is deterministic: Fri Jul 31, 2026 (local).
const NOW = new Date(2026, 6, 31);

// Convenience: run collectOccasions for a single-birthday contact and read its offset.
function offsetOf(birthday: string): number {
  const [o] = collectOccasions([person({ _id: '1', name: 'A', birthday })], NOW);
  return o.offset;
}

describe('collectOccasions windowing', () => {
  it("anchors an occasion happening today at offset 0", () => {
    expect(offsetOf('2000-07-31')).toBe(0);
  });

  it('reports yesterday as offset -1 (recently observed)', () => {
    expect(offsetOf('1990-07-30')).toBe(-1);
  });

  it(`keeps an occasion ${PAST_WINDOW_DAYS} days old in the past window`, () => {
    // 2026-07-24 is exactly PAST_WINDOW_DAYS (7) before today → still shown as past.
    expect(offsetOf('1990-07-24')).toBe(-PAST_WINDOW_DAYS);
  });

  it('rolls an occasion just past the window forward to next year (positive offset)', () => {
    // 2026-07-23 is 8 days ago (> window) → next occurrence is 2027-07-23.
    const off = offsetOf('1990-07-23');
    expect(off).toBeGreaterThan(COMING_UP_DAYS);
    expect(off).toBe(357);
  });

  it('reports tomorrow as offset +1', () => {
    expect(offsetOf('1990-08-01')).toBe(1);
  });

  it(`treats an occasion exactly ${COMING_UP_DAYS} days out as still "coming up"`, () => {
    // 2026-09-29 is 60 days after 2026-07-31.
    expect(offsetOf('1985-09-29')).toBe(COMING_UP_DAYS);
  });
});

describe('collectOccasions years-since', () => {
  it("computes the age turned at a recently-passed birthday from last occurrence", () => {
    const [o] = collectOccasions([person({ _id: '1', name: 'A', birthday: '1990-07-30' })], NOW);
    expect(o.years).toBe(36); // turned 36 yesterday
  });

  it('computes the age about to be turned at an upcoming birthday', () => {
    const [o] = collectOccasions([person({ _id: '1', name: 'A', birthday: '1990-08-01' })], NOW);
    expect(o.years).toBe(36); // turns 36 tomorrow
  });

  it('leaves years null when no real origin year is on file', () => {
    // A far-future stored year (a date with no meaningful birth year) yields no age.
    const [o] = collectOccasions([person({ _id: '1', name: 'A', birthday: '1900-06-15' })], NOW);
    expect(o.years).toBeNull();
  });
});

describe('collectOccasions ordering & sources', () => {
  it('sorts chronologically: recently-passed before today before upcoming', () => {
    const people = [
      person({ _id: '1', name: 'Upcoming', birthday: '1990-08-01' }),   // +1
      person({ _id: '2', name: 'Past', birthday: '1990-07-29' }),       // -2
      person({ _id: '3', name: 'Today', birthday: '2000-07-31' }),      // 0
    ];
    expect(collectOccasions(people, NOW).map((o) => o.person.name)).toEqual(['Past', 'Today', 'Upcoming']);
  });

  it('derives occasions from both the birthday field and labeled dates, tagging kind from the label', () => {
    const people = [person({
      _id: '1', name: 'A',
      birthday: '1990-07-31',
      dates: [{ label: 'anniversary', value: '2010-08-05' }],
    })];
    const kinds = collectOccasions(people, NOW).map((o) => o.kind).sort();
    expect(kinds).toEqual(['anniversary', 'birthday']);
  });

  it('flags an occasionsHidden contact so the screen can omit it (does not drop it here)', () => {
    const [o] = collectOccasions([person({ _id: '1', name: 'A', birthday: '2000-07-31', occasionsHidden: true })], NOW);
    expect(o.hidden).toBe(true);
  });
});

describe('whenLabel', () => {
  it('phrases past, present, and future offsets', () => {
    expect(whenLabel(0)).toBe('Today');
    expect(whenLabel(-1)).toBe('Yesterday');
    expect(whenLabel(-5)).toBe('5 days ago');
    expect(whenLabel(1)).toBe('Tomorrow');
    expect(whenLabel(45)).toBe('in 45 days');
  });
});
