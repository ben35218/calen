// The discovery nudge (spec: features/notifications.md — Discovery nudge;
// billing-plans.md — Discovery). These pin the pure half of lib/discoverNudge:
// the third-open floor, the 14-day cooldown, the 3-show cap, the all-owned
// brainstorm-only-once rule, and the per-user memory. The fetch/navigation
// wiring lives in hooks/useDiscoverNudge and is not under test.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DISCOVER_COOLDOWN_MS,
  DISCOVER_MAX_SHOWS,
  DISCOVER_MIN_OPENS,
  DiscoverNudgeInput,
  loadDiscoverMemory,
  markDiscoverShown,
  pickDiscoverNudge,
  recordDiscoverOpen,
} from '../discoverNudge';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

// A third-open user with unowned add-ons and no showing yet — eligible for
// the add-ons version unless a field says otherwise.
const input = (over: Partial<DiscoverNudgeInput> = {}): DiscoverNudgeInput => ({
  opens: 3,
  shows: 0,
  lastShownAt: null,
  brainstormShown: false,
  allAddonsOwned: false,
  nowMs: NOW,
  ...over,
});

describe('pickDiscoverNudge', () => {
  it('never fires before the third app open', () => {
    expect(pickDiscoverNudge(input({ opens: 1 }))).toBeNull();
    expect(pickDiscoverNudge(input({ opens: 2 }))).toBeNull();
    expect(pickDiscoverNudge(input({ opens: DISCOVER_MIN_OPENS }))).toBe('addons');
  });

  it('honors the 14-day cooldown between showings', () => {
    const justShown = input({ lastShownAt: NOW - 1000 });
    expect(pickDiscoverNudge(justShown)).toBeNull();
    const dayThirteen = input({ lastShownAt: NOW - DISCOVER_COOLDOWN_MS + 60_000 });
    expect(pickDiscoverNudge(dayThirteen)).toBeNull();
    const dayFourteen = input({ lastShownAt: NOW - DISCOVER_COOLDOWN_MS });
    expect(pickDiscoverNudge(dayFourteen)).toBe('addons');
  });

  it('caps the add-ons version at three showings', () => {
    expect(pickDiscoverNudge(input({ shows: DISCOVER_MAX_SHOWS - 1 }))).toBe('addons');
    expect(pickDiscoverNudge(input({ shows: DISCOVER_MAX_SHOWS }))).toBeNull();
    expect(pickDiscoverNudge(input({ shows: 10 }))).toBeNull();
  });

  it('all add-ons owned → brainstorm version, at most once, cooldown still applies', () => {
    expect(pickDiscoverNudge(input({ allAddonsOwned: true }))).toBe('brainstorm');
    // Someone who bought the last add-on right after an add-ons showing isn't
    // re-interrupted the next morning with the brainstorm pitch.
    expect(
      pickDiscoverNudge(input({ allAddonsOwned: true, lastShownAt: NOW - 1000 })),
    ).toBeNull();
    // Once shown in the all-owned state, never again — even past the cap logic.
    expect(pickDiscoverNudge(input({ allAddonsOwned: true, brainstormShown: true }))).toBeNull();
    // The 3-show cap does NOT block the brainstorm version (the cap is about
    // repeated selling; this is a one-time capability pitch).
    expect(pickDiscoverNudge(input({ allAddonsOwned: true, shows: DISCOVER_MAX_SHOWS }))).toBe('brainstorm');
  });
});

describe('discover memory', () => {
  beforeEach(() => AsyncStorage.clear());

  it('counts opens per user', async () => {
    expect((await recordDiscoverOpen('u1')).opens).toBe(1);
    expect((await recordDiscoverOpen('u1')).opens).toBe(2);
    expect((await recordDiscoverOpen('u2')).opens).toBe(1);
  });

  it('a showing bumps the count, stamps the time, and latches brainstorm', async () => {
    await recordDiscoverOpen('u1');
    await markDiscoverShown('u1', 'addons', NOW);
    let mem = await loadDiscoverMemory('u1');
    expect(mem).toEqual({ opens: 1, shows: 1, lastShownAt: NOW, brainstormShown: false });
    await markDiscoverShown('u1', 'brainstorm', NOW + 1);
    mem = await loadDiscoverMemory('u1');
    expect(mem.shows).toBe(2);
    expect(mem.lastShownAt).toBe(NOW + 1);
    expect(mem.brainstormShown).toBe(true);
    // The latch never releases.
    await markDiscoverShown('u1', 'addons', NOW + 2);
    expect((await loadDiscoverMemory('u1')).brainstormShown).toBe(true);
  });

  it('unreadable stored state falls back to a fresh memory', async () => {
    await AsyncStorage.setItem('hc_discover_nudge:u1', 'not json');
    expect(await loadDiscoverMemory('u1')).toEqual({
      opens: 0,
      shows: 0,
      lastShownAt: null,
      brainstormShown: false,
    });
    expect((await recordDiscoverOpen('u1')).opens).toBe(1);
  });
});
