import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CalendarData } from '../api';

// Feature-calendar add-ons, in two classes sharing one household ledger
// (Household.addons) and one gating model:
//   • PAID  — Meals / Maintenance / Trips: one-time purchases through the store
//     (RevenueCat), granted by the billing webhook.
//   • FREE  — Birthdays / Chores: included with the app but OPT-IN — the user
//     "gets" them from the Add-ons screen (POST /billing/addons/claim), so they
//     are not default-added for a new household.
// The server is the entitlement source of truth — GET /billing/status returns
// the owned set — and this module is the device-side mirror: useBilling caches
// every fetched set here so gating works offline. Unknown + uncached reads as
// LOCKED (the safe default matches the no-defaults policy). Same module-level
// state + subscriber-store pattern as calendarPrefs.

const OWNED_KEY = 'hc_owned_addons';

// Store-purchasable feature calendars, keyed by their CALENDARS registry ids
// (also the Household.addons keys). Order = store display order.
export const PAID_ADDON_CALENDAR_IDS = ['recipes', 'maintenance', 'trips'] as const;
// Free opt-in feature calendars (claimed, never bought).
export const FREE_ADDON_CALENDAR_IDS = ['birthdays', 'chores'] as const;
export const ADDON_CALENDAR_IDS = [...PAID_ADDON_CALENDAR_IDS, ...FREE_ADDON_CALENDAR_IDS] as const;
export type PaidAddonId = (typeof PAID_ADDON_CALENDAR_IDS)[number];
export type AddonId = (typeof ADDON_CALENDAR_IDS)[number];

export function isAddonCalendar(id: string): id is AddonId {
  return (ADDON_CALENDAR_IDS as readonly string[]).includes(id);
}

export function isFreeAddon(id: string): boolean {
  return (FREE_ADDON_CALENDAR_IDS as readonly string[]).includes(id);
}

// ── In-memory state + subscribers ───────────────────────────────────────────
let ownedState: Set<string> | null = null; // null = not yet loaded from cache
const subs = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(OWNED_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        // A cacheOwnedAddons() racing ahead of this read wins.
        if (ownedState === null) {
          ownedState = new Set(
            (Array.isArray(parsed) ? parsed : []).filter((id: unknown) => isAddonCalendar(id as string))
          );
        }
      } catch {
        if (ownedState === null) ownedState = new Set();
      }
      subs.forEach((fn) => fn());
    })();
  }
  return loadPromise;
}

// Record the server-reported owned set (called from useBilling's queryFn and the
// post-purchase activation poll — the two places /billing/status lands).
export function cacheOwnedAddons(addons: string[]): void {
  ownedState = new Set((addons ?? []).filter((id) => isAddonCalendar(id)));
  AsyncStorage.setItem(OWNED_KEY, JSON.stringify([...ownedState])).catch(() => {});
  subs.forEach((fn) => fn());
}

// True when the calendar id is usable: non-add-on calendars are always
// unlocked; add-on calendars require ownership. `owned` may be null (cache not
// yet read) — locked, per the safe default.
function unlocked(owned: Set<string> | null, calId: string): boolean {
  if (!isAddonCalendar(calId)) return true;
  return owned?.has(calId) ?? false;
}

// Owned add-on ids for non-React callers (calendarData's assembly chokepoint,
// mirrors getAccessibleCustomCalendarIds).
export async function getOwnedAddonIds(): Promise<Set<string>> {
  await ensureLoaded();
  return new Set(ownedState ?? []);
}

// ── Hook ────────────────────────────────────────────────────────────────────
export function useOwnedAddons() {
  const [owned, setOwned] = useState<Set<string>>(ownedState ?? new Set());
  const [loaded, setLoaded] = useState(ownedState !== null);

  useEffect(() => {
    const sub = () => {
      setOwned(new Set(ownedState ?? []));
      setLoaded(ownedState !== null);
    };
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  return {
    owned,
    loaded,
    isUnlocked: (calId: string) => unlocked(loaded ? owned : null, calId),
  };
}

// Zero out the feature arrays of locked add-ons in assembled CalendarData.
// Pure (mutates and returns the passed object) — applied at the loadCalendarData
// chokepoint so the grid, day/agenda/list, search, print, reminder scheduler,
// and AI reads all exclude locked features together. Grocery-shopping markers
// belong to the Meals feature, so they lock with `recipes`. Free add-ons lock
// exactly like paid ones until claimed.
export function applyAddonLocks(data: CalendarData, owned: Set<string>): CalendarData {
  if (!owned.has('recipes')) {
    data.recipes = [];
    data.groceryShopping = [];
  }
  if (!owned.has('maintenance')) data.tasks = [];
  if (!owned.has('trips')) data.trips = [];
  if (!owned.has('birthdays')) data.occasions = [];
  if (!owned.has('chores')) data.chores = [];
  return data;
}
