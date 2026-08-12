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
  settingsApi: { get: jest.fn(async () => ({ data: {} })), update: jest.fn(async () => ({ data: {} })) },
}));
jest.mock('../homeRegion', () => ({ detectHomeRegion: jest.fn() }));
// Adopting an account's alert config rebuilds the reminder window; the real
// module pulls in expo-notifications, and only the call matters here.
jest.mock('../notifications', () => ({ rescheduleReminders: jest.fn(async () => {}) }));

import { getHolidayCalendars, refreshCustomCalendars } from '../calendarPrefs';
import { REGIONS } from '../holidays';
import { customCalendarsApi, settingsApi } from '../../api';
import { detectHomeRegion } from '../homeRegion';

const listMock = customCalendarsApi.list as jest.Mock;
const createMock = customCalendarsApi.create as jest.Mock;
const updateMock = customCalendarsApi.update as jest.Mock;
const detectMock = detectHomeRegion as jest.Mock;
const settingsGetMock = settingsApi.get as jest.Mock;
const settingsUpdateMock = settingsApi.update as jest.Mock;

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

// ── Calendar-level alert prefs are ACCOUNT state ────────────────────────────
// The Occasions + holiday alert configs are cached in AsyncStorage, and that
// cache is wiped at sign-out with the rest of ACCOUNT_KEYS. Before they were
// carried on /settings, that wipe was the end of them: set holiday alerts, sign
// out, sign back in — and they were off again, with nothing to restore from.
describe('occasion + holiday alert prefs (account-backed)', () => {
  const signOutAndBackIn = async () => {
    const { resetCalendarPrefs } = require('../calendarPrefs') as typeof import('../calendarPrefs');
    await resetCalendarPrefs();
    // The next session's loads: no calendars, and no fresh-install re-seed.
    listMock.mockResolvedValue({ data: [] });
    createMock.mockImplementation(async (p: any) => ({ data: { ...p, mine: true, access: 'full' } }));
    detectMock.mockResolvedValue(null);
    settingsUpdateMock.mockClear();
  };

  it('restores the account config on the next sign-in', async () => {
    const { getHolidayAlertPrefs, getOccasionAlertPrefs } =
      require('../calendarPrefs') as typeof import('../calendarPrefs');
    await signOutAndBackIn();
    settingsGetMock.mockResolvedValue({
      data: {
        holidayAlerts: { offsets: [1], time: '08:00' },
        occasionAlerts: { offsets: [], time: '12:00' }, // explicitly turned OFF
      },
    });

    // The wiped cache reads as the defaults; the account's config lands on top.
    await getHolidayAlertPrefs();
    for (let i = 0; i < 10; i++) await flush();
    expect(await getHolidayAlertPrefs()).toEqual({ offsets: [1], time: '08:00' });
    // An empty offsets list is a real value ("off"), not "never configured" —
    // it must beat the occasions default of noon day-of + 2 weeks before.
    expect(await getOccasionAlertPrefs()).toEqual({ offsets: [], time: '12:00' });
    // Nothing to push back: the device adopted, it didn't seed.
    expect(settingsUpdateMock).not.toHaveBeenCalled();
  });

  it('seeds the account from this device when it has no config yet', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await signOutAndBackIn();
    // A device that configured holiday alerts BEFORE they were server-backed.
    await AsyncStorage.setItem('hc_holiday_alert_prefs', JSON.stringify({ offsets: [7], time: '09:00' }));
    settingsGetMock.mockResolvedValue({ data: {} }); // account: never configured

    const { getHolidayAlertPrefs } = require('../calendarPrefs') as typeof import('../calendarPrefs');
    expect(await getHolidayAlertPrefs()).toEqual({ offsets: [7], time: '09:00' });
    for (let i = 0; i < 10; i++) await flush();
    // Uploaded rather than dropped — the server's null means "never
    // configured", so the device's own choice becomes the account's.
    expect(settingsUpdateMock).toHaveBeenCalledWith({
      holidayAlerts: { offsets: [7], time: '09:00' },
    });
    // The untouched occasions default is not worth a write.
    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('pushes an edit to the account, not just to the device cache', async () => {
    await signOutAndBackIn();
    settingsGetMock.mockResolvedValue({ data: {} });
    const { setHolidayAlertPrefs, getHolidayAlertPrefs } =
      require('../calendarPrefs') as typeof import('../calendarPrefs');
    await getHolidayAlertPrefs(); // load, so hydration can't overwrite the edit
    for (let i = 0; i < 10; i++) await flush();
    settingsUpdateMock.mockClear();

    setHolidayAlertPrefs({ offsets: [3, 0], time: '07:30' });
    await flush();

    expect(settingsUpdateMock).toHaveBeenCalledWith({
      holidayAlerts: { offsets: [0, 3], time: '07:30' }, // deduped + sorted
    });
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    expect(JSON.parse(await AsyncStorage.getItem('hc_holiday_alert_prefs'))).toEqual({
      offsets: [0, 3], time: '07:30',
    });
  });

  it('an edit made while the fetch is in flight wins over the response', async () => {
    await signOutAndBackIn();
    let release: (v: unknown) => void = () => {};
    settingsGetMock.mockImplementation(
      () => new Promise((r) => { release = r; })
    );
    const { setHolidayAlertPrefs, getHolidayAlertPrefs } =
      require('../calendarPrefs') as typeof import('../calendarPrefs');

    const loading = getHolidayAlertPrefs();
    await flush();
    setHolidayAlertPrefs({ offsets: [2], time: '10:00' });
    release({ data: { holidayAlerts: { offsets: [9], time: '06:00' } } });
    await loading;
    for (let i = 0; i < 10; i++) await flush();

    // The stale response must not undo what the user just chose.
    expect(await getHolidayAlertPrefs()).toEqual({ offsets: [2], time: '10:00' });
    settingsGetMock.mockResolvedValue({ data: {} });
  });
});

// ── The calendar arrangement is ACCOUNT state ───────────────────────────────
// Colours, order, visibility, deleted built-ins and muted alerts were written
// only to AsyncStorage, and that cache is wiped at sign-out with the rest of
// ACCOUNT_KEYS. Reported 2026-08-04: recolour the Chores calendar, sign out,
// sign back in — and it was its default orange again, with nothing left to
// restore it from. They ride on /settings (User.calendarPrefs) now.
describe('calendar arrangement (account-backed)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react') as typeof import('react');
  const { Text } = require('react-native') as typeof import('react-native');
  const { render, act } = require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  // renderHook is unusable under this jest-expo/React 19 setup (see
  // useBilling.test) — probe the hooks through a tiny harness component.
  function makeProbe() {
    const prefs = require('../calendarPrefs') as typeof import('../calendarPrefs');
    return function Probe() {
      const { colors } = prefs.useCalendarColors();
      const { order } = prefs.useCalendarOrder();
      const { visibility } = prefs.useCalendarVisibility();
      const { deletedIds } = prefs.useDeletedDefaultCalendars();
      const { mutedIds } = prefs.useDefaultCalendarAlerts();
      return React.createElement(
        Text,
        null,
        [
          `chores:${colors.chores}`,
          `order:${order.join(',')}`,
          `weather:${visibility.weather !== false}`,
          `deleted:${deletedIds.join(',')}`,
          `muted:${mutedIds.join(',')}`,
        ].join(' ')
      );
    };
  }

  const signOutAndBackIn = async () => {
    const { resetCalendarPrefs } = require('../calendarPrefs') as typeof import('../calendarPrefs');
    await resetCalendarPrefs();
    listMock.mockResolvedValue({ data: [] });
    createMock.mockImplementation(async (p: any) => ({ data: { ...p, mine: true, access: 'full' } }));
    detectMock.mockResolvedValue(null);
    settingsUpdateMock.mockClear();
  };

  const settle = async (view: { rerender?: unknown }) =>
    act(async () => {
      for (let i = 0; i < 10; i++) await flush();
    });

  it('restores the account arrangement on the next sign-in', async () => {
    await signOutAndBackIn();
    settingsGetMock.mockResolvedValue({
      data: {
        calendarPrefs: {
          colors: { chores: '#8E24AA' },
          order: ['chores', 'activities'],
          hidden: ['weather'],
          deletedDefaults: ['recipes'],
          alertsOff: ['trips'],
        },
      },
    });

    const view = await render(React.createElement(makeProbe()));
    await settle(view);

    // The wiped cache read as the defaults; the account's arrangement landed on
    // top of every one of them.
    expect(view.getByText(/chores:#8E24AA/)).toBeTruthy();
    expect(view.getByText(/order:chores,activities/)).toBeTruthy();
    expect(view.getByText(/weather:false/)).toBeTruthy();
    expect(view.getByText(/deleted:recipes/)).toBeTruthy();
    expect(view.getByText(/muted:trips/)).toBeTruthy();
    // Nothing to push back: the device adopted, it didn't seed.
    expect(settingsUpdateMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it('an empty value from the account beats the cache (cleared, not unset)', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await signOutAndBackIn();
    await AsyncStorage.setItem('hc_calendar_colors', JSON.stringify({ chores: '#8E24AA' }));
    // The user reset their overrides on another device: an empty map is a real
    // value, and must not be read as "never configured".
    settingsGetMock.mockResolvedValue({ data: { calendarPrefs: { colors: {} } } });

    const view = await render(React.createElement(makeProbe()));
    await settle(view);

    expect(view.getByText(/chores:#F57C00/)).toBeTruthy(); // back to the default
    expect(settingsUpdateMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it('seeds the account from this device when it has no arrangement yet', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await signOutAndBackIn();
    // A device that recoloured Chores BEFORE the arrangement was server-backed.
    await AsyncStorage.setItem('hc_calendar_colors', JSON.stringify({ chores: '#8E24AA' }));
    settingsGetMock.mockResolvedValue({ data: {} }); // account: never configured

    const view = await render(React.createElement(makeProbe()));
    await settle(view);

    // Uploaded rather than dropped, and only the field the device actually has.
    expect(view.getByText(/chores:#8E24AA/)).toBeTruthy();
    expect(settingsUpdateMock).toHaveBeenCalledWith({
      calendarPrefs: { colors: { chores: '#8E24AA' } },
    });
    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('pushes a recolour to the account, not just to the device cache', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await signOutAndBackIn();
    settingsGetMock.mockResolvedValue({ data: {} });

    let setColor: (id: string, color: string) => void = () => {};
    const prefs = require('../calendarPrefs') as typeof import('../calendarPrefs');
    function Probe() {
      const c = prefs.useCalendarColors();
      setColor = c.setColor;
      return React.createElement(Text, null, `chores:${c.colors.chores}`);
    }
    const view = await render(React.createElement(Probe));
    await settle(view); // load first, so hydration can't overwrite the edit
    settingsUpdateMock.mockClear();

    await act(async () => {
      setColor('chores', '#8E24AA');
      await flush();
    });

    expect(view.getByText('chores:#8E24AA')).toBeTruthy();
    // The whole arrangement goes up, absolute rather than a delta, so a dropped
    // push can't leave the account half-applied.
    expect(settingsUpdateMock).toHaveBeenCalledWith({
      calendarPrefs: expect.objectContaining({ colors: { chores: '#8E24AA' } }),
    });
    expect(JSON.parse(await AsyncStorage.getItem('hc_calendar_colors'))).toEqual({
      chores: '#8E24AA',
    });
    view.unmount();
  });
});

// ── First paint carries the user's colours ──────────────────────────────────
// Every calendar surface resolves colours through this module and falls back to
// the app defaults until the prefs load, so painting before they land showed
// the grid/chips/icons in the DEFAULT colours and recoloured them a beat later
// (reported 2026-08-04). The RootNavigator holds its splash on
// useCalendarPrefsReady, which is why what it waits for matters: the cache when
// there is one, the account's first pass when there isn't.
describe('useCalendarPrefsReady (first-paint gate)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react') as typeof import('react');
  const { Text } = require('react-native') as typeof import('react-native');
  const { render, act } = require('@testing-library/react-native') as typeof import('@testing-library/react-native');

  function Probe() {
    const prefs = require('../calendarPrefs') as typeof import('../calendarPrefs');
    const ready = prefs.useCalendarPrefsReady(true);
    const { colors } = prefs.useCalendarColors();
    return React.createElement(Text, null, `ready:${ready} chores:${colors.chores}`);
  }

  const settle = async () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await flush();
    });

  const signOutAndBackIn = async () => {
    const { resetCalendarPrefs } = require('../calendarPrefs') as typeof import('../calendarPrefs');
    await resetCalendarPrefs();
    listMock.mockResolvedValue({ data: [] });
    createMock.mockImplementation(async (p: any) => ({ data: { ...p, mine: true, access: 'full' } }));
    detectMock.mockResolvedValue(null);
    settingsUpdateMock.mockClear();
  };

  it('classifies a device as cached from either the colours or the calendar list', () => {
    const { arrangementCachedOnDevice } =
      require('../calendarPrefs') as typeof import('../calendarPrefs');
    expect(arrangementCachedOnDevice(null, null)).toBe(false); // fresh sign-in
    expect(arrangementCachedOnDevice('{"chores":"#8E24AA"}', null)).toBe(true);
    // An empty cached list still means this account has loaded here before.
    expect(arrangementCachedOnDevice(null, '[]')).toBe(true);
  });

  it('holds until the account answers when nothing is cached', async () => {
    await signOutAndBackIn();
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem('hc_holiday_cals_migrated', '1'); // no fresh-install seed
    let release: (v: unknown) => void = () => {};
    settingsGetMock.mockImplementation(() => new Promise((r) => { release = r; }));

    const view = await render(React.createElement(Probe));
    await settle();
    // The wiped cache holds nothing to paint, so the gate stays shut rather
    // than let the calendar come up orange and turn purple a second later.
    expect(view.getByText(/ready:false/)).toBeTruthy();

    await act(async () => {
      release({ data: { calendarPrefs: { colors: { chores: '#8E24AA' } } } });
      for (let i = 0; i < 10; i++) await flush();
    });

    expect(view.getByText(/ready:true/)).toBeTruthy();
    expect(view.getByText(/chores:#8E24AA/)).toBeTruthy();
    view.unmount();
    settingsGetMock.mockResolvedValue({ data: {} });
  });

  it('re-arms after an in-session wipe: reloadCalendarPrefs reopens the gate', async () => {
    // The household-changed teardown (join / leave / removal / re-key "start
    // fresh") wipes the prefs while the user STAYS signed in, so the hook's
    // enabled-flip re-arm never fires — the splash held forever until the
    // teardown learned to call reloadCalendarPrefs (reported 2026-08-12, after
    // a solo "start fresh"). The mounted gate must go not-ready on the wipe and
    // ready again once the reload's server pass answers.
    await signOutAndBackIn();
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem('hc_holiday_cals_migrated', '1');
    await AsyncStorage.setItem('hc_calendar_colors', JSON.stringify({ chores: '#00897B' }));
    settingsGetMock.mockResolvedValue({ data: {} });

    const view = await render(React.createElement(Probe));
    await settle();
    expect(view.getByText(/ready:true/)).toBeTruthy();

    const prefs = require('../calendarPrefs') as typeof import('../calendarPrefs');
    await act(async () => {
      // The teardown pair, exactly as store/auth runs it mid-session.
      await prefs.resetCalendarPrefs();
      settingsGetMock.mockResolvedValue({ data: { calendarPrefs: { colors: { chores: '#8E24AA' } } } });
      await prefs.reloadCalendarPrefs();
      for (let i = 0; i < 10; i++) await flush();
    });

    expect(view.getByText(/ready:true/)).toBeTruthy();
    expect(view.getByText(/chores:#8E24AA/)).toBeTruthy();
    view.unmount();
    settingsGetMock.mockResolvedValue({ data: {} });
  });

  it('opens on the cache alone — a warm launch never waits on the network', async () => {
    await signOutAndBackIn();
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem('hc_holiday_cals_migrated', '1');
    await AsyncStorage.setItem('hc_calendar_colors', JSON.stringify({ chores: '#00897B' }));
    // Never resolves: a slow (or dead) network must not hold the splash when
    // the device already knows the arrangement.
    settingsGetMock.mockImplementation(() => new Promise(() => {}));

    const view = await render(React.createElement(Probe));
    await settle();

    expect(view.getByText(/ready:true/)).toBeTruthy();
    expect(view.getByText(/chores:#00897B/)).toBeTruthy();
    view.unmount();
    settingsGetMock.mockResolvedValue({ data: {} });
  });
});
