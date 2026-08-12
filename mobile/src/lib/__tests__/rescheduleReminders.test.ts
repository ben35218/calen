// The scheduling PASS (as opposed to computeReminders, covered in
// notifications.test.ts): what it hands the OS, when it claims the server's
// duplicate guard, and what it records when it fails. Every failure path in
// rescheduleReminders is a silent `return 0`, so these assertions are the only
// place the difference between the outcomes is pinned down.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockNotifications = {
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  cancelAllScheduledNotificationsAsync: jest.fn(async () => {}),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  getAllScheduledNotificationsAsync: jest.fn(async () => [] as any[]),
  setNotificationChannelAsync: jest.fn(async () => {}),
  SchedulableTriggerInputTypes: { DATE: 'date', TIME_INTERVAL: 'timeInterval' },
  AndroidImportance: { DEFAULT: 3 },
};
jest.mock('expo-notifications', () => mockNotifications);

const mockLoadCalendarData = jest.fn();
jest.mock('../calendarData', () => ({ loadCalendarData: mockLoadCalendarData }));

const mockSetLocalReminders = jest.fn(async () => {});
jest.mock('../../api', () => ({
  notificationsApi: { setLocalReminders: mockSetLocalReminders },
  settingsApi: { get: jest.fn(async () => ({ data: { dayAlertTime: null } })) },
}));

jest.mock('../privacyPrefs', () => ({ getPrivacyPrefs: () => ({ remindersEnabled: true }) }));
jest.mock('../calendarPrefs', () => ({
  getAlertMutedCalendarIds: jest.fn(async () => new Set<string>()),
  getOccasionAlertPrefs: jest.fn(async () => ({ offsets: [0], time: '12:00' })),
  // Holiday alerts default to off, so the pass adds nothing here unless a test
  // says otherwise.
  getHolidayAlertPrefs: jest.fn(async () => ({ offsets: [] as number[], time: '09:00' })),
  getHolidayCalendars: jest.fn(async () => [] as any[]),
  holidayEnabledIds: jest.fn(() => [] as string[]),
}));

const emptyData = {
  tasks: [], chores: [], events: [], occasions: [], recipes: [], groceryShopping: [], trips: [],
};

// An event two hours out with a 30-minute alert → exactly one reminder.
function dataWithOneAlert() {
  const start = new Date(Date.now() + 2 * 3600_000);
  return { ...emptyData, events: [{ id: 'e1', title: 'Dentist', startDate: start.toISOString(), reminderMinutes: 30, calendarType: 'personal' }] };
}

// Module state (the server flag, the run log) is per-registry, so each test gets
// a fresh copy of the module under test.
function freshModule() {
  let mod!: typeof import('../notifications');
  jest.isolateModules(() => { mod = require('../notifications'); });
  return mod;
}

// The CJS jest mock has no `default`; the app's ESM import interops to the
// module object itself. Resolve whichever shape this registry hands back.
function storage() {
  const mod = require('@react-native-async-storage/async-storage');
  return mod.default ?? mod;
}

// The persisted run log, the only record a reminder pass leaves behind.
async function readRunLog(): Promise<Record<string, any>> {
  return JSON.parse((await storage().getItem('hc_reminder_run_log')) ?? '{}');
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
  mockNotifications.getAllScheduledNotificationsAsync.mockResolvedValue([]);
  mockLoadCalendarData.mockResolvedValue(emptyData);
  await storage().clear();
});

describe('rescheduleReminders', () => {
  it('schedules the computed batch and only then claims the server duplicate guard', async () => {
    mockLoadCalendarData.mockResolvedValue(dataWithOneAlert());
    const { rescheduleReminders } = freshModule();

    await expect(rescheduleReminders()).resolves.toBe(1);
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(mockSetLocalReminders).toHaveBeenCalledWith(true);

    // Ordering is the point: the flag must not be claimed before the OS holds
    // the batch, or a throw mid-pass leaves the server standing down for a
    // device that scheduled nothing.
    const claimOrder = mockSetLocalReminders.mock.invocationCallOrder[0];
    const scheduleOrder = mockNotifications.scheduleNotificationAsync.mock.invocationCallOrder[0];
    expect(claimOrder).toBeGreaterThan(scheduleOrder);
  });

  it('releases the duplicate guard when the pass fails, instead of claiming it', async () => {
    mockLoadCalendarData.mockRejectedValue(new Error('offline'));
    const { rescheduleReminders } = freshModule();

    await expect(rescheduleReminders()).resolves.toBe(0);
    expect(mockSetLocalReminders).not.toHaveBeenCalledWith(true);
    expect(mockSetLocalReminders).toHaveBeenCalledWith(false);
  });

  it('does not claim the guard, or schedule, without permission', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { rescheduleReminders } = freshModule();

    await expect(rescheduleReminders()).resolves.toBe(0);
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockSetLocalReminders).toHaveBeenCalledWith(false);
  });

  it('is single-flight — concurrent callers join the running pass', async () => {
    mockLoadCalendarData.mockResolvedValue(dataWithOneAlert());
    const { rescheduleReminders } = freshModule();

    const [a, b, c] = await Promise.all([
      rescheduleReminders(), rescheduleReminders(), rescheduleReminders(),
    ]);

    // One cancel + one schedule, not three interleaved cancel/schedule halves
    // (which would leave the same reminder queued more than once).
    expect(mockNotifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('runs again after the in-flight pass settles', async () => {
    const { rescheduleReminders } = freshModule();
    await rescheduleReminders();
    await rescheduleReminders();
    expect(mockNotifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(2);
  });
});

// Nothing in the app renders the run log — it is a console warning plus a
// persisted record. So assert on the record itself: that IS the contract.
describe('the run log', () => {
  it('carries the failed pass’s reason and message', async () => {
    mockLoadCalendarData.mockRejectedValue(new Error('vault locked'));
    const mod = freshModule();

    await mod.rescheduleReminders();
    const log = await readRunLog();
    expect(log).toMatchObject({ reason: 'error', scheduled: 0 });
    expect(log.error).toContain('vault locked');
  });

  it('names the stage that failed', async () => {
    mockLoadCalendarData.mockRejectedValue(new Error('vault locked'));
    await freshModule().rescheduleReminders();
    expect((await readRunLog()).stage).toBe('load');

    // Same visible symptom (nothing scheduled), different stage — which is the
    // whole point of recording it.
    mockLoadCalendarData.mockResolvedValue(emptyData);
    (require('../calendarPrefs').getAlertMutedCalendarIds as jest.Mock)
      .mockRejectedValueOnce(new Error('bad prefs blob'));
    await freshModule().rescheduleReminders();
    expect((await readRunLog()).stage).toBe('prefs');
  });

  it('survives to the next launch, so a background-slot failure is still readable', async () => {
    mockLoadCalendarData.mockRejectedValue(new Error('vault locked'));
    await freshModule().rescheduleReminders();

    // A fresh module registry = a relaunch; the in-memory copy is gone.
    freshModule();
    expect((await readRunLog()).reason).toBe('error');
  });
});

describe('a malformed reminder', () => {
  it('costs only its own notification, not the rest of the batch', async () => {
    const soon = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
    mockLoadCalendarData.mockResolvedValue({
      ...emptyData,
      events: [
        { id: 'a', title: 'Bad', startDate: soon(60), reminderMinutes: 30, calendarType: 'personal' },
        { id: 'b', title: 'Good', startDate: soon(120), reminderMinutes: 30, calendarType: 'personal' },
      ],
    });
    mockNotifications.scheduleNotificationAsync
      .mockRejectedValueOnce(new Error('invalid trigger'))
      .mockResolvedValue('id');

    // The good one still lands, and the pass reports itself as a success.
    await expect(freshModule().rescheduleReminders()).resolves.toBe(1);
    expect((await readRunLog()).reason).toBe('ok');
  });

  it('still reads as a failure when it takes the whole batch down', async () => {
    mockLoadCalendarData.mockResolvedValue(dataWithOneAlert());
    mockNotifications.scheduleNotificationAsync.mockRejectedValue(new Error('invalid trigger'));

    await expect(freshModule().rescheduleReminders()).resolves.toBe(0);
    expect(await readRunLog()).toMatchObject({ reason: 'error', stage: 'schedule' });
  });

  it('distinguishes a successful empty pass from a failed one', async () => {
    await freshModule().rescheduleReminders(); // no alerts in range
    expect(await readRunLog()).toMatchObject({ reason: 'ok', scheduled: 0 });
  });
});

// The reminder window must OPEN AT LOCAL MIDNIGHT, not at the pass's own
// instant. The engine anchors a recurring chore's date-only occurrence at local
// noon, so a window opening at "now" lost today's occurrence on any pass after
// noon — and since every pass starts with a cancel-all, an afternoon foreground
// wiped an already-armed evening day-of alert without replacing it (weekly
// chore alerting due-day 5pm + day-before 5pm: Monday's alert fired, Tuesday's
// never did). Driven through the real engine so the noon anchor is the actual
// one, not a fixture's guess.
describe('a due-today day-of alert', () => {
  it("survives a pass that runs after the occurrence's noon anchor", async () => {
    const { assembleCalendarData } = require('@household/calendar');
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 11, 14, 0)); // Tue Aug 11, 2:00 PM local
    try {
      mockLoadCalendarData.mockImplementation(async ({ from, to }: { from: string; to: string }) =>
        assembleCalendarData({
          events: [], tasks: [], contacts: [], recipeSchedules: [], trips: [],
          chores: [{
            _id: 'c1', title: 'Trash night', active: true,
            nextDueDate: '2026-08-11T12:00:00',
            recurrence: { type: 'interval', intervalUnit: 'weeks', intervalValue: 1, dayOfWeek: 2 },
            reminderDaysBefore: 0, alert2DaysBefore: 1, reminderTime: '17:00',
          }],
          fromDate: new Date(from), toDate: new Date(to),
        }));

      await freshModule().rescheduleReminders();

      const at = mockNotifications.scheduleNotificationAsync.mock.calls
        .map((c) => ((c[0] as any).trigger.date as Date).getTime());
      // Today's 5 PM alert is still ahead of the 2 PM pass and must be armed …
      expect(at).toContain(new Date(2026, 7, 11, 17, 0).getTime());
      // … and the widened window let nothing already past onto the OS.
      expect(Math.min(...at)).toBeGreaterThan(Date.now());
    } finally {
      jest.useRealTimers();
    }
  });
});

// A cook timer left running when the cook leaves the kitchen screen is armed as
// its own scheduled notification (lib/cookTimers). The reminder pass rebuilds
// its batch by cancelling EVERY scheduled notification, so without the restore
// the next app foreground would silently disarm a simmering pot.
describe('armed cook timers', () => {
  it('survive the pass\'s cancel-all', async () => {
    let mod!: typeof import('../notifications');
    let cook!: typeof import('../cookTimers');
    jest.isolateModules(() => {
      mod = require('../notifications');
      cook = require('../cookTimers');
    });
    try {
      // An earlier test leaves this rejecting; the arm needs it to succeed.
      mockNotifications.scheduleNotificationAsync.mockResolvedValue('id');
      cook.startCookTimer('r1', 'Step 2', 10);
      await cook.armCookTimerAlarms('r1');
      jest.clearAllMocks();

      mockLoadCalendarData.mockResolvedValue(dataWithOneAlert());
      await mod.rescheduleReminders();

      expect(mockNotifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalled();
      expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.objectContaining({ body: 'Step 2 is up.' }) }),
      );
      expect(cook.runningCookTimers('r1')[0].notificationId).toBeTruthy();
    } finally {
      cook.resetCookTimers();  // the store's 1s ticker is module state
    }
  });
});
