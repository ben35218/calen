jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockInvalidate = jest.fn();
jest.mock('../queryClient', () => ({ queryClient: { invalidateQueries: (...a: unknown[]) => mockInvalidate(...a) } }));

// Importing the module at all guards against module-scope evaluation errors
// (calendarPrefs computes ALL_HOLIDAY_IDS from lib/holidays at load time).
import {
  migrateLegacyEnabledList,
  holidayCalendarId,
  holidayEnabledIds,
  CALENDARS,
  DEFAULT_CALENDAR_COLORS,
  COLOR_PRESETS,
} from '../calendarPrefs';
import { CALENDAR_COLORS } from '../calendar';
import { getAllHolidayIds } from '../holidays';

describe('built-in default colours', () => {
  it('appointments defaults to blue (was purple pre-2026-07-29)', () => {
    expect(DEFAULT_CALENDAR_COLORS.appointments).toBe('#1976D2');
  });

  it('every default is a COLOR_PRESETS swatch, and the two defaults maps agree', () => {
    for (const c of CALENDARS) {
      expect(COLOR_PRESETS).toContain(c.color);
      // lib/calendar's map covers the event-bearing built-ins under other ids
      // (birthdays/weather live only in CALENDARS), so compare where both exist.
      if (CALENDAR_COLORS[c.id]) expect(CALENDAR_COLORS[c.id]).toBe(c.color);
    }
  });
});

describe('migrateLegacyEnabledList', () => {
  it('returns null when there is no legacy data', () => {
    expect(migrateLegacyEnabledList(null)).toBeNull();
    expect(migrateLegacyEnabledList(undefined)).toBeNull();
    expect(migrateLegacyEnabledList('garbage')).toBeNull();
  });

  it('disables exactly the legacy ids missing from the enabled list', () => {
    const disabled = migrateLegacyEnabledList(['christmas-day', 'halloween'])!;
    expect(disabled).toContain('canada-day');
    expect(disabled).toContain('thanksgiving');
    expect(disabled).not.toContain('christmas-day');
    expect(disabled).not.toContain('halloween');
  });

  it('never disables ids added after the legacy era', () => {
    // A legacy user who turned everything off still gets the new countries'
    // holidays enabled by default.
    const disabled = new Set(migrateLegacyEnabledList([])!);
    for (const id of ['independence-day', 'mlk-day', 'australia-day', 'summer-bank-holiday']) {
      expect(disabled.has(id)).toBe(false);
    }
  });

  it('an untouched legacy user (everything enabled) migrates to nothing disabled', () => {
    const allLegacyEnabled = migrateLegacyEnabledList(getAllHolidayIds());
    expect(allLegacyEnabled).toEqual([]);
  });
});

describe('holiday calendar helpers', () => {
  const caCal = (over: Partial<{ selectedRegions: string[]; disabledIds: string[] }> = {}) => ({
    id: 'holiday-CA' as const,
    country: 'CA' as const,
    name: 'Canadian Holidays',
    color: '#D32F2F',
    selectedRegions: over.selectedRegions ?? [],
    disabledIds: over.disabledIds ?? [],
  });

  it('derives a stable calendar id per country', () => {
    expect(holidayCalendarId('CA')).toBe('holiday-CA');
    expect(holidayCalendarId('US')).toBe('holiday-US');
  });

  it('always includes national holidays and never bare regional ones', () => {
    const enabled = holidayEnabledIds(caCal());
    expect(enabled).toContain('canada-day'); // national — always on
    expect(enabled).toContain('christmas-day');
    expect(enabled).toContain('valentines-day'); // cultural — on by default
    expect(enabled).not.toContain('family-day-on'); // regional — needs its region
  });

  it('national holidays stay on even if listed as disabled', () => {
    const enabled = holidayEnabledIds(caCal({ disabledIds: ['canada-day'] }));
    expect(enabled).toContain('canada-day');
  });

  it('includes a region\'s holidays once the region is selected', () => {
    const enabled = holidayEnabledIds(caCal({ selectedRegions: ['Ontario'] }));
    expect(enabled).toContain('family-day-on');
    expect(enabled).not.toContain('louis-riel-day'); // Manitoba, not selected
  });

  it('opts cultural/religious holidays out via disabledIds', () => {
    const enabled = holidayEnabledIds(caCal({ disabledIds: ['valentines-day'] }));
    expect(enabled).not.toContain('valentines-day');
    expect(enabled).toContain('halloween');
  });
});

// ── Fresh-install holiday seed + home-region autoselect ─────────────────────
// The api + homeRegion modules are mocked for the whole file (hoisted), but
// only the tests below touch them; the pure helpers above never do.
jest.mock('../../api', () => ({
  customCalendarsApi: { list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() },
}));
jest.mock('../homeRegion', () => ({ detectHomeRegion: jest.fn() }));

import { getHolidayCalendars, refreshCustomCalendars } from '../calendarPrefs';
import { REGIONS } from '../holidays';
import { customCalendarsApi } from '../../api';
import { detectHomeRegion } from '../homeRegion';

const listMock = customCalendarsApi.list as jest.Mock;
const createMock = customCalendarsApi.create as jest.Mock;
const updateMock = customCalendarsApi.update as jest.Mock;
const detectMock = detectHomeRegion as jest.Mock;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('fresh-install holiday seed', () => {
  it('mints the locale-country calendar and preselects the detected home region', async () => {
    listMock.mockResolvedValue({ data: [] });
    createMock.mockImplementation(async (p: any) => ({ data: { ...p, mine: true, access: 'full' } }));
    updateMock.mockResolvedValue({ data: {} });
    // Echo whatever country the seed picked (locale-dependent in CI), with
    // that country's first REGIONS entry as the detected home subdivision.
    detectMock.mockImplementation(async () => {
      const country = createMock.mock.calls[0][0].holiday.country;
      return { country, region: REGIONS[country as keyof typeof REGIONS][0].name };
    });

    // First load: mints the fresh-install seed and (via the load's own
    // background refresh) uploads it server-backed. Flush that async chain.
    await getHolidayCalendars();
    for (let i = 0; i < 10; i++) await flush();

    expect(createMock).toHaveBeenCalledTimes(1);
    const created = createMock.mock.calls[0][0];
    expect(created.holiday.selectedRegions).toEqual([]); // uploaded bare…
    const region = REGIONS[created.holiday.country as keyof typeof REGIONS][0].name;
    expect(updateMock).toHaveBeenCalledWith(created.key, {
      holiday: expect.objectContaining({ selectedRegions: [region] }),
    }); // …then patched with the detected home region

    // A later refresh must not re-seed or re-patch (one-shot).
    createMock.mockClear();
    updateMock.mockClear();
    detectMock.mockClear();
    listMock.mockResolvedValue({ data: [{ ...created, mine: true, access: 'full' }] });
    await refreshCustomCalendars();
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(detectMock).not.toHaveBeenCalled();

    // And the seeded calendar surfaces as a holiday calendar with the region.
    const cals = await getHolidayCalendars();
    expect(cals).toHaveLength(1);
    expect(cals[0].country).toBe(created.holiday.country);
  });
});

// Signing out must drop the cached calendar list. These keys are ACCOUNT state
// in unscoped AsyncStorage, so leaving them behind made the next sign-in paint
// the previous account's calendars: a free-viewer signing in was told "No
// shared calendars yet" (the stale rows were the other account's own
// `mine: true` calendars, and the shell shows only `mine: false`), and an owner
// signing back in saw their built-ins missing. It also leaked calendar names
// and outside-share addresses between accounts on a shared device.
describe('resetCalendarPrefs (sign-out teardown)', () => {
  it('drops the cached calendar list and re-arms the loader for the next account', async () => {
    const { refreshCustomCalendars, resetCalendarPrefs, getAccessibleCustomCalendarIds } =
      require('../calendarPrefs') as typeof import('../calendarPrefs');
    const AsyncStorage = require('@react-native-async-storage/async-storage');

    listMock.mockResolvedValue({
      data: [{
        key: 'custom-a', name: "Darwin's Calendar", color: '#123456', mine: true, access: 'full',
        sharedWithOutside: [{ email: 'someone@example.com', access: 'view' }],
      }],
    });
    await refreshCustomCalendars();
    expect((await getAccessibleCustomCalendarIds()).has('custom-a')).toBe(true);
    expect(await AsyncStorage.getItem('hc_custom_calendars')).toBeTruthy();

    await resetCalendarPrefs();

    expect((await getAccessibleCustomCalendarIds()).has('custom-a')).toBe(false);
    // Nothing left on disk for the next account to inherit — names and the
    // outside-share address included.
    expect(await AsyncStorage.getItem('hc_custom_calendars')).toBeNull();
    expect(await AsyncStorage.getItem('hc_calendar_visibility')).toBeNull();
    expect(await AsyncStorage.getItem('hc_calendar_colors')).toBeNull();
  });
});


// The ['calendar','sources'] / ['viewer','sources'] queries snapshot
// `accessibleCustomIds` from this list, so a commit that actually changes it
// must refetch them — a sources fetch that raced ahead of the session's server
// refresh dropped every custom calendar's events and nothing repainted until
// an unrelated invalidation (observed: until an event save).
describe('commitCustom → calendar query invalidation', () => {
  it('invalidates on a real list change and stays quiet on the steady-state echo', async () => {
    const { refreshCustomCalendars } = require('../calendarPrefs') as typeof import('../calendarPrefs');
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    // Skip the one-time local-upload migrations — steady-state device.
    await AsyncStorage.setItem('hc_custom_calendars_synced', '1');
    await AsyncStorage.setItem('hc_holiday_cals_migrated', '1');

    const row = {
      key: 'custom-x', name: 'X', color: '#123456', alertsEnabled: true,
      sharedWithHousehold: false, householdAccess: 'full',
      sharedWith: [], sharedWithOutside: [], mine: true, access: 'full',
    };
    listMock.mockResolvedValue({ data: [row] });
    mockInvalidate.mockClear();
    await refreshCustomCalendars();
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['viewer'] });

    // The same list again — no churn, no invalidate → no refetch cycle.
    mockInvalidate.mockClear();
    await refreshCustomCalendars();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
