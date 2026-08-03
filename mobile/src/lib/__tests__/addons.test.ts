jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockInvalidate = jest.fn();
jest.mock('../queryClient', () => ({ queryClient: { invalidateQueries: (...a: unknown[]) => mockInvalidate(...a) } }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CalendarData } from '../../api';
import {
  ADDON_CALENDAR_IDS,
  isAddonCalendar,
  cacheOwnedAddons,
  getOwnedAddonIds,
  resetOwnedAddons,
  applyAddonLocks,
} from '../addons';

function sampleData(): CalendarData {
  return {
    events: [{ id: 'e1' } as any],
    chores: [{ id: 'c1' } as any],
    tasks: [{ id: 't1' } as any],
    occasions: [{ id: 'b1' } as any],
    recipes: [{ id: 'r1' } as any],
    groceryShopping: [{ id: 'g1', date: '2026-07-24' }],
    trips: [{ id: 'tr1' } as any],
  };
}

describe('isAddonCalendar', () => {
  it('recognizes the paid (Meals/Maintenance/Trips) and free (Birthdays/Chores) add-ons', () => {
    for (const id of ADDON_CALENDAR_IDS) expect(isAddonCalendar(id)).toBe(true);
    expect(ADDON_CALENDAR_IDS).toEqual(['recipes', 'maintenance', 'trips', 'birthdays', 'chores']);
    // Always-on calendars are never add-ons.
    for (const id of ['activities', 'appointments', 'weather', 'custom-abc', '']) {
      expect(isAddonCalendar(id)).toBe(false);
    }
  });
});

describe('owned-addon cache', () => {
  it('round-trips the owned set through AsyncStorage and drops unknown keys', async () => {
    cacheOwnedAddons(['recipes', 'trips', 'birthdays', 'not-a-key']);
    const owned = await getOwnedAddonIds();
    expect([...owned].sort()).toEqual(['birthdays', 'recipes', 'trips']);
    // Persisted for the next cold start.
    const raw = await AsyncStorage.getItem('hc_owned_addons');
    expect(JSON.parse(raw!).sort()).toEqual(['birthdays', 'recipes', 'trips']);
  });

  it('an empty server set locks everything (no grandfathering)', async () => {
    cacheOwnedAddons([]);
    const owned = await getOwnedAddonIds();
    expect(owned.size).toBe(0);
  });

  // The assembled calendar embeds the owned set (applyAddonLocks runs from the
  // ['calendar','sources'] snapshot), so a change must refetch those queries —
  // without it, an account whose lanes were locked by a stale cache stayed
  // locked until an unrelated invalidation (observed: until an event save).
  it('a CHANGED owned set invalidates the calendar/viewer queries; an identical one does not', () => {
    cacheOwnedAddons(['recipes']);
    mockInvalidate.mockClear();

    cacheOwnedAddons(['recipes']); // steady-state echo — same set
    expect(mockInvalidate).not.toHaveBeenCalled();

    cacheOwnedAddons(['recipes', 'chores']); // entitlements actually changed
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['viewer'] });
  });

  // Sign-out teardown: the owned set is the ACCOUNT's entitlement mirror in an
  // unscoped device key. Surviving logout, a viewer session's empty set became
  // the owner's boot state — Occasions/Chores/Meals data locked to empty on
  // their next sign-in until billing refetched AND something repainted.
  it('resetOwnedAddons clears the cache and storage so the next account starts locked-by-default', async () => {
    cacheOwnedAddons(['recipes', 'birthdays', 'chores']);

    await resetOwnedAddons();

    expect(await AsyncStorage.getItem('hc_owned_addons')).toBeNull();
    const owned = await getOwnedAddonIds();
    expect(owned.size).toBe(0); // safe default: locked until the session's own status lands
  });
});

describe('applyAddonLocks', () => {
  it('locks everything when nothing is owned/claimed, leaving always-on features intact', () => {
    const data = applyAddonLocks(sampleData(), new Set());
    expect(data.recipes).toEqual([]);
    expect(data.groceryShopping).toEqual([]); // grocery markers belong to Meals
    expect(data.tasks).toEqual([]);
    expect(data.trips).toEqual([]);
    // Free add-ons are opt-in: unclaimed Occasions/Chores lock like paid ones.
    expect(data.occasions).toEqual([]);
    expect(data.chores).toEqual([]);
    // Events (Activities/Appointments) are always-on.
    expect(data.events).toHaveLength(1);
  });

  it('each add-on unlocks exactly its own arrays', () => {
    const meals = applyAddonLocks(sampleData(), new Set(['recipes']));
    expect(meals.recipes).toHaveLength(1);
    expect(meals.groceryShopping).toHaveLength(1);
    expect(meals.tasks).toEqual([]);
    expect(meals.trips).toEqual([]);

    const maint = applyAddonLocks(sampleData(), new Set(['maintenance']));
    expect(maint.tasks).toHaveLength(1);
    expect(maint.recipes).toEqual([]);

    const trips = applyAddonLocks(sampleData(), new Set(['trips']));
    expect(trips.trips).toHaveLength(1);
    expect(trips.tasks).toEqual([]);

    // Claimed free add-ons unlock the same way.
    const bdays = applyAddonLocks(sampleData(), new Set(['birthdays']));
    expect(bdays.occasions).toHaveLength(1);
    expect(bdays.chores).toEqual([]);

    const chores = applyAddonLocks(sampleData(), new Set(['chores']));
    expect(chores.chores).toHaveLength(1);
    expect(chores.occasions).toEqual([]);
  });

  it('owning everything leaves the data untouched', () => {
    const data = applyAddonLocks(sampleData(), new Set(ADDON_CALENDAR_IDS));
    for (const key of ['events', 'chores', 'tasks', 'occasions', 'recipes', 'groceryShopping', 'trips'] as const) {
      expect(data[key]).toHaveLength(1);
    }
  });
});
