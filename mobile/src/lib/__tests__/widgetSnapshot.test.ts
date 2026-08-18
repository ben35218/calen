// Home-screen widget snapshot (spec: features/calendar.md — Home-screen
// widget). Pins the two halves of lib/widgetSnapshot: buildWidgetSnapshot
// (pure day assembly — window shape, visibility filter, all-day vs timed
// routing, clipping, holidays, struck rows) and refreshWidgetSnapshot /
// clearWidgetData (the bridge wiring — locked-vault skip, bridge-less no-op,
// write + timeline reload). The WidgetKit side (targets/widget) renders this
// JSON verbatim and is covered by device testing.

jest.mock('../calendarData', () => ({ loadCalendarData: jest.fn() }));
jest.mock('../calendarPrefs', () => ({
  getCalendarColorMap: jest.fn(async () => ({})),
  getCalendarVisibility: jest.fn(async () => ({})),
  getHolidayCalendars: jest.fn(async () => []),
  holidayEnabledIds: jest.fn(() => null),
}));
jest.mock('../holidays', () => ({ getHolidays: jest.fn(() => []) }));
jest.mock('../e2ee', () => ({ isUnlocked: jest.fn(() => true) }));
jest.mock('../../../modules/calen-widget', () => ({
  widgetBridgeAvailable: jest.fn(() => true),
  setWidgetSnapshotJson: jest.fn(async () => {}),
  clearWidgetSnapshotFile: jest.fn(async () => {}),
  reloadWidgetTimelines: jest.fn(async () => {}),
}));

import {
  WINDOW_DAYS,
  WidgetSnapshot,
  buildWidgetSnapshot,
  clearWidgetData,
  refreshWidgetSnapshot,
} from '../widgetSnapshot';
import { loadCalendarData } from '../calendarData';
import { isUnlocked } from '../e2ee';
import {
  clearWidgetSnapshotFile,
  reloadWidgetTimelines,
  setWidgetSnapshotJson,
  widgetBridgeAvailable,
} from '../../../modules/calen-widget';

// Local-time instants (no trailing Z → device zone), on a July window with no
// DST boundary in it.
const local = (s: string) => new Date(s).toISOString();
const NOW = new Date('2026-07-06T08:00:00');
const START = '2026-07-06';

const EMPTY_DATA = {
  events: [], tasks: [], chores: [], recipes: [], trips: [], occasions: [], groceryShopping: [],
} as any;

const baseInput = (over: Partial<Parameters<typeof buildWidgetSnapshot>[0]> = {}) => ({
  data: EMPTY_DATA,
  visibility: {},
  calColors: { maintenance: '#1976D2', chores: '#F57C00', recipes: '#00897B', birthdays: '#E91E63' },
  holidaysByDate: {},
  startDate: START,
  now: NOW,
  ...over,
});

describe('buildWidgetSnapshot', () => {
  it('emits exactly WINDOW_DAYS consecutive days with matching start/end', () => {
    const snap = buildWidgetSnapshot(baseInput());
    expect(snap.version).toBe(1);
    expect(snap.days).toHaveLength(WINDOW_DAYS);
    expect(snap.startDate).toBe(START);
    expect(snap.days[0].date).toBe(START);
    expect(snap.endDate).toBe('2026-07-19');
    expect(snap.days[WINDOW_DAYS - 1].date).toBe(snap.endDate);
    // A quiet day is present with empty arrays — the widget reads it as a
    // true "No events today", distinct from "outside coverage".
    expect(snap.days[3]).toEqual({ date: '2026-07-09', allDay: [], timed: [] });
  });

  it('routes timed events with clipped minutes and all-day events to the all-day row', () => {
    const data = {
      ...EMPTY_DATA,
      events: [
        { _id: 'e1', title: 'Dentist', calendarType: 'appointments', allDay: false,
          startDate: local('2026-07-06T09:00:00'), endDate: local('2026-07-06T10:30:00') },
        { _id: 'e2', title: 'Fair day', calendarType: 'activities', allDay: true,
          startDate: '2026-07-07T12:00:00.000Z' },
      ],
    };
    const snap = buildWidgetSnapshot(baseInput({ data }));
    expect(snap.days[0].timed).toEqual([
      expect.objectContaining({ title: 'Dentist', startMin: 9 * 60, endMin: 10 * 60 + 30 }),
    ]);
    expect(snap.days[1].allDay).toEqual([
      expect.objectContaining({ title: 'Fair day', kind: 'event' }),
    ]);
    expect(snap.days[1].timed).toHaveLength(0);
  });

  it('clips a multi-day timed span per day, sorts by start, and marks cancelled rows struck', () => {
    const data = {
      ...EMPTY_DATA,
      events: [
        { _id: 'late', title: 'Late show', calendarType: 'activities', allDay: false,
          startDate: local('2026-07-08T22:00:00'), endDate: local('2026-07-09T10:00:00') },
        { _id: 'early', title: 'Breakfast', calendarType: 'activities', allDay: false,
          startDate: local('2026-07-08T08:00:00'), endDate: local('2026-07-08T09:00:00'),
          cancelled: true },
      ],
    };
    const snap = buildWidgetSnapshot(baseInput({ data }));
    const day8 = snap.days[2];
    expect(day8.date).toBe('2026-07-08');
    // Sorted by startMin; the cancelled row carries struck.
    expect(day8.timed.map((t) => t.title)).toEqual(['Breakfast', 'Late show']);
    expect(day8.timed[0].struck).toBe(true);
    expect(day8.timed[1]).toEqual(
      expect.objectContaining({ startMin: 22 * 60, endMin: 24 * 60 }),
    );
    // The span's tail day is clipped from midnight.
    expect(snap.days[3].timed).toEqual([
      expect.objectContaining({ title: 'Late show', startMin: 0, endMin: 10 * 60 }),
    ]);
  });

  it('drops hidden calendars and includes chores/tasks/holidays as all-day rows', () => {
    const data = {
      ...EMPTY_DATA,
      events: [
        { _id: 'h1', title: 'Hidden thing', calendarType: 'appointments', allDay: false,
          startDate: local('2026-07-06T11:00:00'), endDate: local('2026-07-06T12:00:00') },
      ],
      chores: [{ _id: 'c1', title: 'Take out bins', nextDueDate: '2026-07-06T12:00:00.000Z', icon: 'trash-can' }],
      tasks: [{ _id: 't1', title: 'Furnace filter', nextDueDate: '2026-07-06T12:00:00.000Z' }],
    };
    const snap = buildWidgetSnapshot(baseInput({
      data,
      visibility: { appointments: false },
      holidaysByDate: { '2026-07-06': [{ id: 'ca-1', name: 'Civic Holiday', color: '#D32F2F' }] },
    }));
    const today = snap.days[0];
    expect(today.timed).toHaveLength(0); // hidden calendar's event is gone
    expect(today.allDay).toEqual([
      expect.objectContaining({ title: 'Civic Holiday', kind: 'holiday', color: '#D32F2F' }),
      expect.objectContaining({ title: 'Furnace filter', kind: 'task' }),
      expect.objectContaining({ title: 'Take out bins', kind: 'chore', color: '#F57C00' }),
    ]);
  });
});

describe('refreshWidgetSnapshot / clearWidgetData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (widgetBridgeAvailable as jest.Mock).mockReturnValue(true);
    (isUnlocked as jest.Mock).mockReturnValue(true);
    (loadCalendarData as jest.Mock).mockResolvedValue(EMPTY_DATA);
  });

  it('writes a full-window snapshot and reloads timelines', async () => {
    await refreshWidgetSnapshot();
    expect(setWidgetSnapshotJson).toHaveBeenCalledTimes(1);
    const written: WidgetSnapshot = JSON.parse((setWidgetSnapshotJson as jest.Mock).mock.calls[0][0]);
    expect(written.version).toBe(1);
    expect(written.days).toHaveLength(WINDOW_DAYS);
    expect(reloadWidgetTimelines).toHaveBeenCalledTimes(1);
  });

  it('skips the whole pass without a native bridge', async () => {
    (widgetBridgeAvailable as jest.Mock).mockReturnValue(false);
    await refreshWidgetSnapshot();
    expect(loadCalendarData).not.toHaveBeenCalled();
    expect(setWidgetSnapshotJson).not.toHaveBeenCalled();
  });

  it('leaves the last snapshot standing while the vault is locked', async () => {
    (isUnlocked as jest.Mock).mockReturnValue(false);
    await refreshWidgetSnapshot();
    expect(setWidgetSnapshotJson).not.toHaveBeenCalled();
    expect(clearWidgetSnapshotFile).not.toHaveBeenCalled();
  });

  it('swallows a failed load (offline) without writing', async () => {
    (loadCalendarData as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(refreshWidgetSnapshot()).resolves.toBeUndefined();
    expect(setWidgetSnapshotJson).not.toHaveBeenCalled();
  });

  it('clearWidgetData removes the snapshot and reloads timelines', async () => {
    await clearWidgetData();
    expect(clearWidgetSnapshotFile).toHaveBeenCalledTimes(1);
    expect(reloadWidgetTimelines).toHaveBeenCalledTimes(1);
  });
});
