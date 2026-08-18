// The widget-adoption nudge (spec: features/notifications.md — Widget nudge).
// These pin the pure half of lib/widgetNudge: the installed veto, the
// second-open floor, the two-show cap, the 14-day re-nudge cooldown, and the
// per-user memory. The install-check/navigation wiring lives in
// hooks/useWidgetNudge and is not under test.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  WIDGET_MAX_SHOWS,
  WIDGET_MIN_OPENS,
  WIDGET_RENUDGE_COOLDOWN_MS,
  WidgetNudgeInput,
  loadWidgetNudgeMemory,
  markWidgetNudgeShown,
  pickWidgetNudge,
  recordWidgetNudgeOpen,
} from '../widgetNudge';

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

// A second-open user without the widget and no showing yet — eligible unless
// a field says otherwise.
const input = (over: Partial<WidgetNudgeInput> = {}): WidgetNudgeInput => ({
  opens: 2,
  shows: 0,
  lastShownAt: null,
  installed: false,
  nowMs: NOW,
  ...over,
});

describe('pickWidgetNudge', () => {
  it('an installed widget vetoes everything', () => {
    expect(pickWidgetNudge(input({ installed: true }))).toBe(false);
    expect(pickWidgetNudge(input({ installed: true, opens: 50 }))).toBe(false);
  });

  it('never fires on the first app open', () => {
    expect(pickWidgetNudge(input({ opens: 1 }))).toBe(false);
    expect(pickWidgetNudge(input({ opens: WIDGET_MIN_OPENS }))).toBe(true);
  });

  it('re-nudges once, only after the 14-day cooldown', () => {
    const justShown = input({ shows: 1, lastShownAt: NOW - 1000 });
    expect(pickWidgetNudge(justShown)).toBe(false);
    const dayThirteen = input({ shows: 1, lastShownAt: NOW - WIDGET_RENUDGE_COOLDOWN_MS + 60_000 });
    expect(pickWidgetNudge(dayThirteen)).toBe(false);
    const dayFourteen = input({ shows: 1, lastShownAt: NOW - WIDGET_RENUDGE_COOLDOWN_MS });
    expect(pickWidgetNudge(dayFourteen)).toBe(true);
  });

  it('caps at two showings, ever', () => {
    const capped = input({
      shows: WIDGET_MAX_SHOWS,
      lastShownAt: NOW - WIDGET_RENUDGE_COOLDOWN_MS * 10,
    });
    expect(pickWidgetNudge(capped)).toBe(false);
    expect(pickWidgetNudge(input({ shows: 10, lastShownAt: null }))).toBe(false);
  });

  it('a show count without a timestamp (corrupt memory) fails closed', () => {
    expect(pickWidgetNudge(input({ shows: 1, lastShownAt: null }))).toBe(false);
  });
});

describe('widget nudge memory', () => {
  beforeEach(() => AsyncStorage.clear());

  it('counts opens per user', async () => {
    expect((await recordWidgetNudgeOpen('u1')).opens).toBe(1);
    expect((await recordWidgetNudgeOpen('u1')).opens).toBe(2);
    expect((await recordWidgetNudgeOpen('u2')).opens).toBe(1);
  });

  it('a showing bumps the count and stamps the time', async () => {
    await recordWidgetNudgeOpen('u1');
    await markWidgetNudgeShown('u1', NOW);
    let mem = await loadWidgetNudgeMemory('u1');
    expect(mem).toEqual({ opens: 1, shows: 1, lastShownAt: NOW });
    await markWidgetNudgeShown('u1', NOW + 1);
    mem = await loadWidgetNudgeMemory('u1');
    expect(mem.shows).toBe(2);
    expect(mem.lastShownAt).toBe(NOW + 1);
  });

  it('unreadable stored state falls back to a fresh memory', async () => {
    await AsyncStorage.setItem('hc_widget_nudge:u1', 'not json');
    expect(await loadWidgetNudgeMemory('u1')).toEqual({ opens: 0, shows: 0, lastShownAt: null });
    expect((await recordWidgetNudgeOpen('u1')).opens).toBe(1);
  });
});
