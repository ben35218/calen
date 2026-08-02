jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
jest.mock('../e2ee', () => ({
  currentUserId: jest.fn(() => 'user-1'),
  openRecord: jest.fn(async (_collection: string, row: any) => row),
}));
jest.mock('../records', () => ({ syncRecords: jest.fn(), hasSyncedRecords: jest.fn() }));
jest.mock('../replica', () => ({ getAll: jest.fn(), upsert: jest.fn(), remove: jest.fn() }));
jest.mock('../calendarFeeds', () => ({
  getFeedEvents: jest.fn(async () => []),
  loadFeedSources: jest.fn(async () => []),
  expandFeedSources: jest.fn(() => []),
}));
jest.mock('../addons', () => ({
  applyAddonLocks: jest.fn(),
  getOwnedAddonIds: jest.fn(async () => new Set()),
}));
jest.mock('../calendarPrefs', () => ({
  getAccessibleCustomCalendarIds: jest.fn(async () => new Set()),
}));
jest.mock('@household/calendar', () => ({
  // The shared engine has its own suite; here it just echoes its inputs so the
  // sourcing/sync behavior under test is observable on the returned data.
  assembleCalendarData: jest.fn((args: any) => ({
    events: args.events,
    trips: args.trips,
    groceryShopping: args.groceryShoppingDay != null ? [{ date: '2026-01-05' }] : [],
  })),
}));

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' };

// Module-level state (revalidation dedupe/throttle) must reset per test, so the
// module under test — and the mock instances it captured — are re-required.
let calendarData: typeof import('../calendarData');
let records: { syncRecords: jest.Mock; hasSyncedRecords: jest.Mock };
let replica: { getAll: jest.Mock; upsert: jest.Mock; remove: jest.Mock };
let api: { settingsApi: { get: jest.Mock }; tripsApi: { list: jest.Mock } };
let queryClient: { invalidateQueries: jest.Mock };
let AsyncStorage: any;

const NO_CHANGES = { upserted: 0, removed: 0, skipped: 0 };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  records = require('../records');
  replica = require('../replica');
  api = require('../../api');
  queryClient = require('../queryClient').queryClient;
  const asMock = require('@react-native-async-storage/async-storage');
  AsyncStorage = asMock.default ?? asMock;
  calendarData = require('../calendarData');

  records.hasSyncedRecords.mockResolvedValue(true);
  records.syncRecords.mockResolvedValue(NO_CHANGES);
  replica.getAll.mockResolvedValue([]);
  replica.upsert.mockResolvedValue(undefined);
  replica.remove.mockResolvedValue(undefined);
  api.settingsApi.get = jest.fn().mockResolvedValue({ data: {} });
  api.tripsApi.list = jest.fn().mockResolvedValue({ data: [] });
});

// Flush the fire-and-forget revalidation kicked off by a background-mode load.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('loadCalendarSources — background mode', () => {
  it('assembles from the replica and the grocery cache without awaiting the network', async () => {
    await AsyncStorage.setItem(
      'hc_grocery_settings',
      JSON.stringify({ groceryShoppingDay: 3, groceryFrequency: 'biweekly', groceryAnchor: '2026-01-01' })
    );
    const event = { _id: 'e1', updatedAt: '2026-01-01T00:00:00.000Z' };
    replica.getAll.mockImplementation(async (collection: string) =>
      collection === 'CalendarEvent' ? [event] : []
    );
    // A hung server must not block the paint: network calls never resolve.
    records.syncRecords.mockReturnValue(new Promise(() => {}));
    api.settingsApi.get.mockReturnValue(new Promise(() => {}));
    api.tripsApi.list.mockReturnValue(new Promise(() => {}));

    const s = await calendarData.loadCalendarSources({ ...RANGE, sync: 'background' });

    expect(s.events).toEqual([event]);
    expect(s.groceryShoppingDay).toBe(3);
    expect(s.groceryFrequency).toBe('biweekly');
    expect(s.groceryAnchor).toBe('2026-01-01');
    // Trips came from the replica bucket, not the (hung) trips fetch.
    expect(replica.getAll).toHaveBeenCalledWith('Trip');
  });

  it('falls back to an inline sync when the device has never synced (empty replica)', async () => {
    records.hasSyncedRecords.mockResolvedValue(false);
    await calendarData.loadCalendarSources({ ...RANGE, sync: 'background' });
    // The pull was awaited before assembling — not left to the background.
    expect(records.syncRecords).toHaveBeenCalledTimes(1);
    expect(api.tripsApi.list).toHaveBeenCalledTimes(1);
  });
});

describe('loadCalendarSources — inline mode (default)', () => {
  it('awaits the records pull and caches the fetched grocery settings', async () => {
    api.settingsApi.get.mockResolvedValue({ data: { groceryShoppingDay: 5, groceryFrequency: 'weekly' } });
    const s = await calendarData.loadCalendarSources(RANGE);
    expect(records.syncRecords).toHaveBeenCalledTimes(1);
    expect(s.groceryShoppingDay).toBe(5);
    const cached = JSON.parse(await AsyncStorage.getItem('hc_grocery_settings'));
    expect(cached.groceryShoppingDay).toBe(5);
  });

  it('falls back to the cached grocery settings when the fetch fails', async () => {
    await AsyncStorage.setItem(
      'hc_grocery_settings',
      JSON.stringify({ groceryShoppingDay: 2, groceryFrequency: 'weekly', groceryAnchor: null })
    );
    api.settingsApi.get.mockRejectedValue(new Error('offline'));
    const s = await calendarData.loadCalendarSources(RANGE);
    expect(s.groceryShoppingDay).toBe(2);
  });
});

describe('revalidateCalendar', () => {
  it('invalidates the calendar queries when the records sync pulled changes', async () => {
    records.syncRecords.mockResolvedValue({ upserted: 2, removed: 0, skipped: 0 });
    await calendarData.revalidateCalendar();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['calendar'] });
  });

  it('stays quiet when nothing changed (no invalidate → no refetch loop)', async () => {
    await calendarData.revalidateCalendar();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates when the grocery settings changed server-side', async () => {
    await AsyncStorage.setItem(
      'hc_grocery_settings',
      JSON.stringify({ groceryShoppingDay: 1, groceryFrequency: 'weekly', groceryAnchor: null })
    );
    api.settingsApi.get.mockResolvedValue({ data: { groceryShoppingDay: 4 } });
    await calendarData.revalidateCalendar();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['calendar'] });
  });

  it('reconciles trips into the replica — upserts, removes deleted, flags the change', async () => {
    const kept = { _id: 't1', updatedAt: '2026-01-02T00:00:00.000Z' };
    const gone = { _id: 't2', updatedAt: '2026-01-01T00:00:00.000Z' };
    replica.getAll.mockImplementation(async (collection: string) =>
      collection === 'Trip' ? [kept, gone] : []
    );
    api.tripsApi.list.mockResolvedValue({ data: [kept] });

    await calendarData.revalidateCalendar();

    expect(replica.remove).toHaveBeenCalledWith('Trip', 't2');
    expect(replica.upsert).toHaveBeenCalledWith('Trip', [kept]);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['calendar'] });
  });

  it('throttles back-to-back passes (an invalidation-triggered refetch must not spin)', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await calendarData.revalidateCalendar();
    expect(records.syncRecords).toHaveBeenCalledTimes(1);
    await calendarData.revalidateCalendar();
    expect(records.syncRecords).toHaveBeenCalledTimes(1); // within the floor — skipped
    now.mockReturnValue(1_000_000 + 60_000);
    await calendarData.revalidateCalendar();
    expect(records.syncRecords).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('is deduped by background-mode loads (one pass, shared in-flight)', async () => {
    let release!: (v: { upserted: number; removed: number; skipped: number }) => void;
    records.syncRecords.mockReturnValue(new Promise((r) => (release = r)));
    await Promise.all([
      calendarData.loadCalendarSources({ ...RANGE, sync: 'background' }),
      calendarData.loadCalendarSources({ ...RANGE, sync: 'background' }),
    ]);
    await settle();
    expect(records.syncRecords).toHaveBeenCalledTimes(1);
    release(NO_CHANGES);
    await settle();
  });
});

describe('loadCalendarData', () => {
  it('passes the sync mode through and still applies the chokepoint filters', async () => {
    const { getAccessibleCustomCalendarIds } = require('../calendarPrefs');
    getAccessibleCustomCalendarIds.mockResolvedValue(new Set(['custom-mine']));
    replica.getAll.mockImplementation(async (collection: string) =>
      collection === 'CalendarEvent'
        ? [
            { _id: 'e1', calendarType: 'custom-mine', startDate: '2026-01-02T12:00:00.000Z' },
            { _id: 'e2', calendarType: 'custom-theirs', startDate: '2026-01-03T12:00:00.000Z' },
          ]
        : []
    );
    const data = await calendarData.loadCalendarData({ ...RANGE, sync: 'background' });
    expect(data.events.map((e: any) => e._id)).toEqual(['e1']);
  });
});
