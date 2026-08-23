// Booking alerts (trips.md → Alerts): the option rows both booking surfaces
// (form + view) share, and the loader the reminder pass reads the itinerary
// through — including its offline fallback cache.

const mockFetchTripDetail = jest.fn();
jest.mock('../tripData', () => ({ fetchTripDetail: (...a: unknown[]) => mockFetchTripDetail(...a) }));

const mockGetOwnedAddonIds = jest.fn();
jest.mock('../addons', () => ({ getOwnedAddonIds: () => mockGetOwnedAddonIds() }));

const mockReplica = {
  getAll: jest.fn(async (_c: string) => [] as any[]),
  upsert: jest.fn(async () => {}),
  remove: jest.fn(async () => {}),
};
jest.mock('../replica', () => ({
  getAll: (...a: unknown[]) => mockReplica.getAll(...(a as [string])),
  upsert: (...a: unknown[]) => mockReplica.upsert(...(a as [])),
  remove: (...a: unknown[]) => mockReplica.remove(...(a as [])),
}));

import { BOOKING_ALERT_ASSIST_OPTIONS, buildBookingAlertItems, loadBookingAlerts } from '../tripAlerts';

afterEach(() => jest.clearAllMocks());

describe('buildBookingAlertItems', () => {
  const values = (type: string) =>
    buildBookingAlertItems({ type, reminderMinutes: null, alert2Minutes: null }).map((i) => i.minutes);

  it('offers the event grid, None first and Custom last', () => {
    const items = buildBookingAlertItems({ type: 'restaurant', reminderMinutes: null, alert2Minutes: null });
    expect(items[0].label).toBe('None');
    expect(items[items.length - 1].label).toBe('Custom…');
    expect(values('restaurant')).toEqual([null, 0, 15, 30, 60, 1440, null]);
  });

  it('adds the airport lead times (2–3 hours) on journeys only', () => {
    expect(values('flight')).toEqual([null, 0, 15, 30, 60, 120, 180, 1440, null]);
    expect(values('transit')).toContain(120);
    expect(values('hotel')).not.toContain(120);
    expect(values('activity')).not.toContain(180);
  });

  it('names the zero row by what the booking type anchors on', () => {
    const zero = (type: string) =>
      buildBookingAlertItems({ type, reminderMinutes: null, alert2Minutes: null }).find((i) => i.minutes === 0)!.label;
    expect(zero('flight')).toBe('At departure');
    expect(zero('transit')).toBe('At departure');
    expect(zero('hotel')).toBe('At check-in');
    expect(zero('car-rental')).toBe('At start time');
  });

  it('feeds the assist schema the same grid, with the -1 None row', () => {
    // The assistant's select options must stay the picker's own offsets — a
    // drifted copy is how a model-set value stops matching any offered row.
    expect(BOOKING_ALERT_ASSIST_OPTIONS.map((o) => o.value)).toEqual([-1, 0, 15, 30, 60, 120, 180, 1440]);
    expect(BOOKING_ALERT_ASSIST_OPTIONS[0].label).toBe('None');
    expect(BOOKING_ALERT_ASSIST_OPTIONS.find((o) => o.value === 120)?.label).toBe('2 hr before');
  });

  it('synthesizes a row for a saved custom value, so the field reads it back', () => {
    const items = buildBookingAlertItems({ type: 'activity', reminderMinutes: 45, alert2Minutes: null });
    const custom = items.find((i) => i.minutes === 45);
    expect(custom?.label).toBe('45 min before');
    // …but never duplicates a canned row.
    const thirty = buildBookingAlertItems({ type: 'activity', reminderMinutes: 30, alert2Minutes: null });
    expect(thirty.filter((i) => i.minutes === 30)).toHaveLength(1);
  });

  // An all-day booking has no clock for minutes to count back from — it gets
  // the calendar's whole-day grid, labelled with the hour it fires at.
  it('swaps the minute grid for the whole-day one on an all-day booking', () => {
    const items = buildBookingAlertItems({
      type: 'activity', allDay: true, dayAlertTime: '09:00', reminderMinutes: null, alert2Minutes: null,
    });
    expect(items.map((i) => i.minutes)).toEqual([null, 0, 1440, 2880, 10080, null]);
    expect(items[0].label).toBe('None');
    expect(items.find((i) => i.minutes === 0)?.label).toBe('On the day (9:00 AM)');
    expect(items.find((i) => i.minutes === 1440)?.label).toBe('1 day before (9:00 AM)');
    expect(items[items.length - 1].label).toBe('Custom…');
  });

  it('synthesizes an off-grid saved value on the all-day list too', () => {
    const items = buildBookingAlertItems({
      type: 'activity', allDay: true, dayAlertTime: '08:30', reminderMinutes: 4320, alert2Minutes: null,
    });
    expect(items.find((i) => i.minutes === 4320)?.label).toBe('3 days before (8:30 AM)');
  });
});

describe('loadBookingAlerts', () => {
  const trip = (over: Record<string, unknown> = {}) => ({ _id: 't1', ...over });
  const item = (over: Record<string, unknown> = {}) => ({
    _id: 'b1', type: 'flight', title: 'AC123', start: '2026-09-01T10:00:00.000Z',
    reminderMinutes: 120, alert2Minutes: null, ...over,
  });

  beforeEach(() => {
    mockGetOwnedAddonIds.mockResolvedValue(new Set(['trips']));
    mockReplica.getAll.mockImplementation(async (c: string) => (c === 'Trip' ? [trip()] : []));
    mockFetchTripDetail.mockResolvedValue({ trip: trip(), items: [item(), item({ _id: 'b2', reminderMinutes: null, alert2Minutes: null })] });
  });

  it('returns slim rows for alert-bearing bookings of active trips, and caches them', async () => {
    const out = await loadBookingAlerts();
    expect(out).toEqual([{
      _id: 'b1', tripId: 't1', type: 'flight', title: 'AC123',
      start: '2026-09-01T10:00:00.000Z', reminderMinutes: 120, alert2Minutes: null,
    }]);
    // b2 has no alert set — not worth a cache row.
    expect(mockReplica.upsert).toHaveBeenCalledWith('TripItemAlert', out);
  });

  it('skips trips whose last day has passed entirely', async () => {
    mockReplica.getAll.mockImplementation(async (c: string) =>
      (c === 'Trip' ? [trip({ startDate: '2020-01-01T00:00:00Z', endDate: '2020-01-05T00:00:00Z' })] : []));
    expect(await loadBookingAlerts()).toEqual([]);
    expect(mockFetchTripDetail).not.toHaveBeenCalled();
  });

  it('a dated trip stays active through its last day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockReplica.getAll.mockImplementation(async (c: string) =>
      (c === 'Trip' ? [trip({ startDate: '2020-01-01T00:00:00Z', endDate: `${today}T00:00:00Z` })] : []));
    expect(await loadBookingAlerts()).toHaveLength(1);
  });

  it('falls back to the cached rows for a trip whose fetch fails (offline pass)', async () => {
    const cached = { _id: 'b1', tripId: 't1', type: 'flight', title: 'AC123', start: '2026-09-01T10:00:00.000Z', reminderMinutes: 120, alert2Minutes: null };
    mockReplica.getAll.mockImplementation(async (c: string) => (c === 'Trip' ? [trip()] : [cached]));
    mockFetchTripDetail.mockRejectedValue(new Error('offline'));
    expect(await loadBookingAlerts()).toEqual([cached]);
  });

  it('evicts cached rows the pass no longer resolves (cleared alert, deleted booking)', async () => {
    const stale = { _id: 'gone', tripId: 't1', type: 'hotel', title: 'Old', start: '2026-09-01T10:00:00.000Z', reminderMinutes: 60, alert2Minutes: null };
    mockReplica.getAll.mockImplementation(async (c: string) => (c === 'Trip' ? [trip()] : [stale]));
    await loadBookingAlerts();
    expect(mockReplica.remove).toHaveBeenCalledWith('TripItemAlert', 'gone');
  });

  it('resolves an all-day booking\'s destination-local date onto the slim row', async () => {
    // Midnight Sept 1 in Toronto is 04:00Z — a UTC (or later-zone) reader
    // slicing the instant would land on the wrong day, so the loader resolves
    // the date while it still holds the trip's sealed timezone.
    mockFetchTripDetail.mockResolvedValue({
      trip: trip({ destinationTz: 'America/Toronto' }),
      items: [item({ start: '2026-09-01T04:00:00.000Z', allDay: true, reminderMinutes: 1440 })],
    });
    const out = await loadBookingAlerts();
    expect(out[0].allDay).toBe(true);
    expect(out[0].startDate).toBe('2026-09-01');
  });

  it('returns nothing while the trips add-on is locked', async () => {
    mockGetOwnedAddonIds.mockResolvedValue(new Set());
    expect(await loadBookingAlerts()).toEqual([]);
    expect(mockFetchTripDetail).not.toHaveBeenCalled();
  });
});
