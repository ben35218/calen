import React from 'react';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react-native';

// The trip day's itinerary blocks (trips.md → Day itinerary): a booking reads
// like a calendar event — title, location and the compact time range, each meta
// line led by its glyph — and answers the calendar's gestures, tap to view and
// hold to edit. The travel between two bookings is drawn as a band on top of the
// one you're travelling TO, tappable to change mode. A leg that takes longer
// than the gap between the bookings turns red.

const mockRouteLeg = jest.fn();
jest.mock('../../api', () => ({ placesApi: { routeLeg: (...a: unknown[]) => mockRouteLeg(...a) } }));

// The ghost listens for the itinerary regaining focus, so the component needs a
// navigation object (it never navigates itself — that's the screen's job).
const mockListeners: Record<string, () => void> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    addListener: (event: string, cb: () => void) => {
      mockListeners[event] = cb;
      return () => { delete mockListeners[event]; };
    },
  }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

// Glyphs render as their name so the rows can be asserted by what leads them.
jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  const ReactLib = require('react');
  const glyph = ({ name }: { name: string }) => ReactLib.createElement(Text, null, `icon:${name}`);
  return { MaterialCommunityIcons: glyph, Ionicons: glyph };
});

import TripTimeline from '../TripTimeline';

const TZ = 'America/Toronto';
const DATE = '2026-08-22';

// Two bookings 90 minutes apart, each with a location, so there is a leg to
// compute between them.
const items = [
  {
    _id: 'a', type: 'activity', title: 'Science Centre', location: '770 Don Mills Rd',
    start: '2026-08-22T14:00:00-04:00', end: '2026-08-22T16:00:00-04:00',
  },
  {
    _id: 'b', type: 'restaurant', title: 'Dinner at Alo', location: '163 Spadina Ave',
    start: '2026-08-22T17:30:00-04:00', end: '2026-08-22T19:00:00-04:00',
  },
] as any;

const timeline = async (over: Record<string, unknown> = {}) =>
  render(
    <TripTimeline
      items={items}
      selectedDate={DATE}
      tz={TZ}
      onOpenItem={jest.fn()}
      onEditItem={jest.fn()}
      {...over}
    />,
  );

// The blocks only render once the container has been measured.
async function layout(view: Awaited<ReturnType<typeof timeline>>, width = 320) {
  await act(async () => {
    fireEvent(view.root!, 'layout', { nativeEvent: { layout: { width, height: 600 } } });
  });
}

beforeEach(() => {
  mockRouteLeg.mockResolvedValue({ data: { minutes: 25 } });
});
afterEach(() => {
  cleanup();
  mockRouteLeg.mockReset();
});

describe('TripTimeline — the booking block', () => {
  it('names the booking, its location and its time range', async () => {
    const view = await timeline();
    await layout(view);
    await waitFor(() => view.getByText('Science Centre'));
    view.getByText('770 Don Mills Rd');
    view.getByText('2 – 4PM');
    view.getByText('Dinner at Alo');
    view.getByText('163 Spadina Ave');
    view.getAllByText('icon:map-marker-outline');
    view.getAllByText('icon:clock-outline');
  });

  it('falls back to the booking type when the title cannot be decrypted', async () => {
    const view = await timeline({ items: [{ ...items[0], title: undefined }] });
    await layout(view);
    await waitFor(() => view.getByText('Activity'));
  });

  // A date-only booking has no hour: a block at midnight would be the grid
  // asserting a time the user never entered. The day view's banner strip
  // carries it instead (TripDetailScreen).
  it('keeps an all-day booking off the hour grid', async () => {
    const allDay = {
      _id: 'ad', type: 'activity', title: 'Museum day', location: '100 Queens Park',
      start: '2026-08-22T00:00:00-04:00', allDay: true,
    };
    const view = await timeline({ items: [...items, allDay] });
    await layout(view);
    await waitFor(() => view.getByText('Science Centre'));
    expect(view.queryByText('Museum day')).toBeNull();
  });

  // The calendar's pair of gestures on an event chip: a tap reads the booking, a
  // hold goes straight to its form.
  it('opens the booking view on a tap, never the form', async () => {
    const onOpenItem = jest.fn();
    const onEditItem = jest.fn();
    const view = await timeline({ onOpenItem, onEditItem });
    await layout(view);
    fireEvent.press(await waitFor(() => view.getByText('Science Centre')));
    expect(onOpenItem).toHaveBeenCalledWith('a');
    expect(onEditItem).not.toHaveBeenCalled();
  });

  it('opens the booking form on a press-and-hold', async () => {
    const onOpenItem = jest.fn();
    const onEditItem = jest.fn();
    const view = await timeline({ onOpenItem, onEditItem });
    await layout(view);
    fireEvent(await waitFor(() => view.getByText('Dinner at Alo')), 'longPress');
    expect(onEditItem).toHaveBeenCalledWith('b');
    expect(onOpenItem).not.toHaveBeenCalled();
  });
});

describe('TripTimeline — the 24-hour canvas', () => {
  it('draws the whole day, not just the booked hours', async () => {
    const view = await timeline();
    await layout(view);
    // Midnight to midnight, in the day view's own gutter labels.
    view.getByText('12 AM');
    view.getByText('Noon');
    view.getByText('11 PM');
  });

  it('reports where the day should open: just above its first booking', async () => {
    const onInitialScroll = jest.fn();
    const view = await timeline({ onInitialScroll });
    await layout(view);
    // First booking at 2 PM (840), half an hour of lead-in, 8px of top padding.
    expect(onInitialScroll).toHaveBeenCalledWith(8 + 840 - 30);
  });

  it('opens an empty day at 8 AM rather than at midnight', async () => {
    const onInitialScroll = jest.fn();
    // A past date, so the anchor can never be the live now-line no matter when
    // the suite runs (a fixture date "today" in the trip's tz anchors at now).
    const view = await timeline({ items: [], selectedDate: '2026-03-05', onInitialScroll });
    await layout(view);
    expect(onInitialScroll).toHaveBeenCalledWith(8 + 8 * 60 - 30);
  });
});

describe('TripTimeline — long-press to create', () => {
  const pressAt = async (view: Awaited<ReturnType<typeof timeline>>, locationY: number) => {
    await act(async () => {
      fireEvent(view.getByTestId('trip-timeline-canvas'), 'longPress', { nativeEvent: { locationY } });
    });
  };

  it('springs a ghost booking into the pressed slot, then opens the form on it', async () => {
    const onCreateAt = jest.fn();
    const view = await timeline({ onCreateAt });
    await layout(view);
    // The ghost holds for 250ms before the push. That ordering is the point of
    // this test, so drive it on fake timers — on a real clock a loaded suite can
    // spend the whole hold between the press and the assertion below.
    jest.useFakeTimers();
    try {
      // A 7:22 AM press (1 px/min, minus the canvas's top padding) lands in 7:15.
      await pressAt(view, 7 * 60 + 22);
      // The ghost is there immediately — placement feedback before the push.
      view.getByText('New Booking');
      view.getByText('7:15 – 8:15AM');
      expect(onCreateAt).not.toHaveBeenCalled();
      // Only once the hold is up does the form open on the drafted slot.
      await act(async () => { jest.advanceTimersByTime(250); });
      expect(onCreateAt).toHaveBeenCalledWith({ startTime: '07:15', endTime: '08:15' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rolls a last-hour draft onto the next day', async () => {
    const onCreateAt = jest.fn();
    const view = await timeline({ onCreateAt });
    await layout(view);
    await pressAt(view, 23 * 60 + 40);
    await waitFor(() =>
      expect(onCreateAt).toHaveBeenCalledWith({ startTime: '23:30', endTime: '00:30', endDate: '2026-08-23' }),
    );
  });

  it('fades the ghost away when the itinerary regains focus', async () => {
    const view = await timeline({ onCreateAt: jest.fn() });
    await layout(view);
    await pressAt(view, 7 * 60 + 22);
    view.getByText('New Booking');
    await act(async () => { mockListeners.focus?.(); });
    await waitFor(() => expect(view.queryByText('New Booking')).toBeNull());
  });

  it('stays read-only when the screen offers no way to create', async () => {
    const view = await timeline(); // no onCreateAt
    await layout(view);
    await pressAt(view, 7 * 60 + 22);
    expect(view.queryByText('New Booking')).toBeNull();
  });
});

describe('TripTimeline — travel between bookings', () => {
  it('draws the leg as a labelled band on the booking it leads into', async () => {
    const view = await timeline();
    await layout(view);
    await waitFor(() => view.getByText('25 min travel'));
    view.getByText('icon:car'); // the mode it was computed for
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '770 Don Mills Rd', destAddress: '163 Spadina Ave', mode: 'DRIVE' }),
    );
  });

  it('draws a short hop at a legible minimum, still naming its true length', async () => {
    // Two places in the same small town: four minutes apart. At 1px = 1min that
    // band is a sliver with nowhere to print, which is what "I can't see the
    // travel time" looks like.
    mockRouteLeg.mockResolvedValue({ data: { minutes: 4 } });
    const view = await timeline();
    await layout(view);
    await waitFor(() => view.getByText('4 min travel'));
    // The band is drawn at its minimum; the booking's body still starts at 5:30.
    const band = view.getByText('4 min travel');
    const bandBox = band.parent?.parent?.parent?.props?.style;
    const bandHeight = (Array.isArray(bandBox) ? Object.assign({}, ...bandBox.filter(Boolean)) : bandBox)?.height;
    expect(bandHeight).toBeGreaterThanOrEqual(18);
  });

  it('cycles the mode when the band is tapped, and recomputes for it', async () => {
    const view = await timeline();
    await layout(view);
    const band = await waitFor(() => view.getByText('25 min travel'));
    mockRouteLeg.mockResolvedValue({ data: { minutes: 55 } });
    await act(async () => { fireEvent.press(band); });
    await waitFor(() => view.getByText('icon:walk'));
    expect(mockRouteLeg).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'WALK' }));
  });

  it('flags a leg that outruns the gap between the two bookings', async () => {
    // 25 minutes of gap, 40 minutes of driving — the plan does not fit.
    mockRouteLeg.mockResolvedValue({ data: { minutes: 40 } });
    const view = await timeline({
      items: [items[0], { ...items[1], start: '2026-08-22T16:25:00-04:00', end: '2026-08-22T18:00:00-04:00' }],
    });
    await layout(view);
    await waitFor(() => view.getByText('40 min travel'));
    view.getByText('icon:alert');
  });

  it('keeps a tappable chip when the chosen mode has no route, so the mode is not stuck', async () => {
    mockRouteLeg.mockResolvedValue({ data: { minutes: null, error: 'no_route' } });
    const view = await timeline();
    await layout(view);
    await waitFor(() => view.getByText('—'));
    await act(async () => { fireEvent.press(view.getByText('—')); });
    await waitFor(() => view.getByText('icon:walk'));
  });
});

describe('TripTimeline — the morning leg from the lodging', () => {
  // Checked in the evening of the 21st, out the morning of the 24th — so the
  // 22nd and 23rd start at the hotel, and the 24th still does.
  const hotel = {
    _id: 'h', type: 'hotel', title: 'Fairmont Royal York', location: '100 Front St W',
    start: '2026-08-21T15:00:00-04:00', end: '2026-08-24T11:00:00-04:00',
  } as any;

  it("gives the day's first booking a leg out of the hotel", async () => {
    const view = await timeline({ items: [...items, hotel] });
    await layout(view);
    // Two bands: hotel → first booking, then first → second.
    await waitFor(() => expect(view.getAllByText('25 min travel')).toHaveLength(2));
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        originAddress: '100 Front St W',
        destAddress: '770 Don Mills Rd',
        mode: 'DRIVE',
        departureTime: '2026-08-22T14:00:00-04:00',
      }),
    );
  });

  it('says where the leg starts to a screen reader', async () => {
    const view = await timeline({ items: [items[0], hotel] });
    await layout(view);
    await waitFor(() => view.getByText('25 min travel'));
    view.getByLabelText(/from your hotel/);
  });

  it('never uses the hotel as origin for a booking that starts before check-in', async () => {
    // Museum at 2, check-in at 3 — the museum wasn't reached from the hotel;
    // its only leg is the one TO the check-in block.
    const beforeCheckIn = { ...items[0], start: '2026-08-21T14:00:00-04:00', end: '2026-08-21T16:00:00-04:00' };
    const view = await timeline({ items: [beforeCheckIn, hotel], selectedDate: '2026-08-21' });
    await layout(view);
    await waitFor(() => view.getByText('25 min travel'));
    expect(mockRouteLeg).toHaveBeenCalledTimes(1);
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '770 Don Mills Rd', destAddress: '100 Front St W' }),
    );
  });

  it('starts from the hotel on the check-in day once check-in has passed', async () => {
    // Check-in at 3, dinner at 7:30 — the evening leaves from the hotel, via
    // the check-in block.
    const dinner = { ...items[1], start: '2026-08-21T19:30:00-04:00', end: '2026-08-21T21:00:00-04:00' };
    const view = await timeline({ items: [dinner, hotel], selectedDate: '2026-08-21' });
    await layout(view);
    await waitFor(() => view.getByText('25 min travel'));
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '100 Front St W', destAddress: '163 Spadina Ave' }),
    );
  });

  it('puts the check-in on the grid as its own block, tappable like a booking', async () => {
    const onOpenItem = jest.fn();
    const view = await timeline({ items: [hotel], selectedDate: '2026-08-21', onOpenItem });
    await layout(view);
    await waitFor(() => view.getByText('Fairmont Royal York'));
    view.getByText('Check in');
    // The line names an action, not a place: the doorway glyph, never the pin.
    view.getByText('icon:login-variant');
    expect(view.queryByText('icon:map-marker-outline')).toBeNull();
    fireEvent.press(view.getByText('Fairmont Royal York'));
    expect(onOpenItem).toHaveBeenCalledWith('h');
    expect(mockRouteLeg).not.toHaveBeenCalled();
  });

  it('still starts the check-out day at the hotel when the first booking is before check-out', async () => {
    const brunch = { ...items[0], start: '2026-08-24T09:00:00-04:00', end: '2026-08-24T10:00:00-04:00' };
    const view = await timeline({ items: [brunch, hotel], selectedDate: '2026-08-24' });
    await layout(view);
    // Two legs: hotel → brunch (the morning), then brunch → the check-out block.
    await waitFor(() => expect(view.getAllByText('25 min travel')).toHaveLength(2));
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '100 Front St W', destAddress: '770 Don Mills Rd' }),
    );
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '770 Don Mills Rd', destAddress: '100 Front St W' }),
    );
  });

  it('puts the check-out on the grid as its own block, tappable like a booking', async () => {
    const onOpenItem = jest.fn();
    const view = await timeline({ items: [hotel], selectedDate: '2026-08-24', onOpenItem });
    await layout(view);
    await waitFor(() => view.getByText('Fairmont Royal York'));
    view.getByText('Check out');
    // The line names an action, not a place: the doorway glyph, never the pin.
    view.getByText('icon:logout-variant');
    expect(view.queryByText('icon:map-marker-outline')).toBeNull();
    fireEvent.press(view.getByText('Fairmont Royal York'));
    expect(onOpenItem).toHaveBeenCalledWith('h');
    // Hotel → hotel is a same-place hop: no leg to itself.
    expect(mockRouteLeg).not.toHaveBeenCalled();
  });

  it('hands a booking after check-out its leg out of the hotel, via the check-out block', async () => {
    // Check out at 11, museum at 2 — the afternoon still leaves from the hotel.
    const afterCheckout = { ...items[0], start: '2026-08-24T14:00:00-04:00', end: '2026-08-24T16:00:00-04:00' };
    const view = await timeline({ items: [afterCheckout, hotel], selectedDate: '2026-08-24' });
    await layout(view);
    await waitFor(() => view.getByText('25 min travel'));
    expect(mockRouteLeg).toHaveBeenCalledTimes(1);
    expect(mockRouteLeg).toHaveBeenCalledWith(
      expect.objectContaining({ originAddress: '100 Front St W', destAddress: '770 Don Mills Rd' }),
    );
  });

  it('has no leg when the hotel has no address', async () => {
    const view = await timeline({ items: [items[0], { ...hotel, location: '' }] });
    await layout(view);
    await waitFor(() => view.getByText('Science Centre'));
    expect(mockRouteLeg).not.toHaveBeenCalled();
  });

  it('has no leg when the first booking is at the hotel itself', async () => {
    const atHotel = { ...items[0], location: '100 front st w' }; // matching is case-insensitive
    const view = await timeline({ items: [atHotel, hotel] });
    await layout(view);
    await waitFor(() => view.getByText('Science Centre'));
    expect(mockRouteLeg).not.toHaveBeenCalled();
  });

  it('is never flagged tight — no earlier booking constrains it', async () => {
    mockRouteLeg.mockResolvedValue({ data: { minutes: 300 } });
    const view = await timeline({ items: [items[0], hotel] });
    await layout(view);
    await waitFor(() => view.getByText(/travel/));
    expect(view.queryByText('icon:alert')).toBeNull();
  });

  it('cycles its mode independently of the between-booking legs', async () => {
    const view = await timeline({ items: [...items, hotel] });
    await layout(view);
    const bands = await waitFor(() => {
      const b = view.getAllByText('25 min travel');
      expect(b).toHaveLength(2);
      return b;
    });
    await act(async () => { fireEvent.press(bands[0]); });
    // Only the morning leg switched to Walk; the other leg still drives.
    await waitFor(() =>
      expect(mockRouteLeg).toHaveBeenLastCalledWith(
        expect.objectContaining({ originAddress: '100 Front St W', mode: 'WALK' }),
      ),
    );
    view.getByText('icon:car');
  });

  it('runs hotel → airport when the day opens on a departure', async () => {
    const flight = {
      _id: 'f', type: 'flight', title: 'AC 123',
      start: '2026-08-22T09:00:00-04:00', end: '2026-08-22T11:30:00-04:00',
      details: { departureName: 'Toronto Pearson (YYZ)', departureTz: TZ, arrivalName: 'LaGuardia (LGA)', arrivalTz: 'America/New_York' },
    } as any;
    const view = await timeline({ items: [flight, hotel] });
    await layout(view);
    await waitFor(() =>
      expect(mockRouteLeg).toHaveBeenCalledWith(
        expect.objectContaining({ originAddress: '100 Front St W', destAddress: 'Toronto Pearson (YYZ)' }),
      ),
    );
  });

  it("skips a day that opens on an arrival — the night was spent in transit", async () => {
    const redEye = {
      _id: 'f', type: 'flight', title: 'AC 456',
      start: '2026-08-21T23:00:00-04:00', end: '2026-08-22T07:00:00-04:00',
      details: { departureName: 'Vancouver (YVR)', departureTz: 'America/Vancouver', arrivalName: 'Toronto Pearson (YYZ)', arrivalTz: TZ },
    } as any;
    const view = await timeline({ items: [redEye, hotel] });
    await layout(view);
    await waitFor(() => view.getByText('AC 456'));
    expect(mockRouteLeg).not.toHaveBeenCalled();
  });
});
