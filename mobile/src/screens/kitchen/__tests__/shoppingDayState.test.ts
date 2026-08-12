// Where a period's shopping day stands relative to today
// (specs/features/kitchen.md, "Meal planner & grocery"). Both Kitchen panes
// read this one helper — the Planner to mark its day card, the Grocery list to
// name the trip its list is for — because two copies would eventually disagree
// about what day it is, including about the UTC rollover pinned below.

import { periodLabel, relativeDay, shoppingDayState } from '../constants';

const at = (offsetDays: number, hour = 12) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
};

describe('shoppingDayState', () => {
  it('calls this period the next trip when its shopping day is still ahead', () => {
    // The period before it opened a week ago, so this is the earliest shopping
    // day that hasn't passed.
    expect(shoppingDayState(at(1), 7)).toBe('next');
  });

  it('distinguishes the shopping day being today', () => {
    expect(shoppingDayState(at(0), 7)).toBe('today');
  });

  it('calls a shopping day that has been and gone past', () => {
    // The period you are standing in on most days: it opened two days ago.
    expect(shoppingDayState(at(-2), 7)).toBe('past');
  });

  it('does not call a later period the next one', () => {
    // Two periods out — its shopping day is ahead, but it is not the next trip.
    expect(shoppingDayState(at(15), 7)).toBe('later');
  });

  it('measures "next" against the period length, so biweekly reaches further', () => {
    // 10 days out: a weekly shopper has a trip in between, a biweekly one
    // doesn't — the same date is 'later' for one and 'next' for the other.
    expect(shoppingDayState(at(10), 7)).toBe('later');
    expect(shoppingDayState(at(10), 14)).toBe('next');
  });

  it('reads the local day, not the UTC one, late in the evening', () => {
    // `iso` reads the UTC date, so at 23:30 Eastern the UTC day is already
    // tomorrow. Today's shopping day must still read as today, not past.
    const lateTonight = new Date();
    lateTonight.setHours(23, 30, 0, 0);
    expect(shoppingDayState(at(0), 7, lateTonight)).toBe('today');
    expect(shoppingDayState(at(1), 7, lateTonight)).toBe('next');
  });
});

describe('relativeDay', () => {
  it('names the days either side of today', () => {
    expect(relativeDay(at(0))).toBe('today');
    expect(relativeDay(at(1))).toBe('tomorrow');
    expect(relativeDay(at(-1))).toBe('yesterday');
  });

  it('counts further dates in days, in the right direction', () => {
    expect(relativeDay(at(4))).toBe('in 4 days');
    expect(relativeDay(at(-4))).toBe('4 days ago');
    expect(relativeDay(at(32))).toBe('in 32 days');
  });

  it('counts calendar days, not elapsed hours', () => {
    // 23:30 tonight to 00:30 tomorrow is barely an hour, but it is "tomorrow";
    // both ends normalise to local midnight before the subtraction.
    const lateTonight = new Date();
    lateTonight.setHours(23, 30, 0, 0);
    expect(relativeDay(at(1, 0), lateTonight)).toBe('tomorrow');
    expect(relativeDay(at(0, 23), lateTonight)).toBe('today');
  });
});


describe('periodLabel', () => {
  const current = at(0);
  const weeksOut = (n: number) => at(n * 7);

  it('names the three periods either side of now', () => {
    expect(periodLabel(current, current)).toBe('This Week');
    expect(periodLabel(weeksOut(1), current)).toBe('Next Week');
    expect(periodLabel(weeksOut(-1), current)).toBe('Last Week');
  });

  it('counts further periods in words, forwards and back', () => {
    expect(periodLabel(weeksOut(2), current)).toBe('Two Weeks');
    expect(periodLabel(weeksOut(4), current)).toBe('Four Weeks');
    expect(periodLabel(weeksOut(-3), current)).toBe('Three Weeks Ago');
  });

  it('falls back to a numeral past the words it has', () => {
    expect(periodLabel(weeksOut(20), current)).toBe('20 Weeks');
    expect(periodLabel(weeksOut(-20), current)).toBe('20 Weeks Ago');
  });

  it('counts weeks, not periods, so a biweekly next trip reads Two Weeks', () => {
    // A biweekly period is 14 days long, and its next trip really is two weeks
    // out — calling that "Next Week" would be a fortnight wrong.
    expect(periodLabel(weeksOut(2), current)).toBe('Two Weeks');
  });
});
