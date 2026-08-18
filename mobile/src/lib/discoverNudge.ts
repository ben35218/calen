import AsyncStorage from '@react-native-async-storage/async-storage';

// The discovery nudge (spec: features/notifications.md — Discovery nudge;
// billing-plans.md owns the Discover screen): a full-screen "Discover" modal
// promoting unowned add-ons and Calen's brainstorming, presented from the
// device's THIRD app open on a spaced, capped cadence. This is the pure,
// testable half — cadence/eligibility and the per-user memory. The
// fetch/navigation wiring lives in hooks/useDiscoverNudge.
//
// The cadence rules are deliberate anti-nag guardrails (approved 2026-08-13):
// - never before the third open (the first two belong to onboarding + the
//   security nudges);
// - a 14-day cooldown between showings, capped at 3 total while add-ons
//   remain unowned;
// - once every add-on is owned there is nothing left to sell — the modal
//   drops to the brainstorm pitch alone and shows AT MOST ONCE in that state.

export type DiscoverNudgeKind = 'addons' | 'brainstorm';

export interface DiscoverNudgeMemory {
  // Cold starts counted while the full app shell was up for this user.
  opens: number;
  // Times the modal has been presented (either kind).
  shows: number;
  // When it last presented (ms epoch) — drives the cooldown.
  lastShownAt: number | null;
  // The all-owned brainstorm-only version presents at most once, ever.
  brainstormShown: boolean;
}

const KEY_PREFIX = 'hc_discover_nudge:';

export const DISCOVER_MIN_OPENS = 3;
export const DISCOVER_MAX_SHOWS = 3;
export const DISCOVER_COOLDOWN_MS = 14 * 24 * 3600_000;

export async function loadDiscoverMemory(userId: string): Promise<DiscoverNudgeMemory> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as Partial<DiscoverNudgeMemory>) : null;
    return {
      opens: typeof parsed?.opens === 'number' ? parsed.opens : 0,
      shows: typeof parsed?.shows === 'number' ? parsed.shows : 0,
      lastShownAt: typeof parsed?.lastShownAt === 'number' ? parsed.lastShownAt : null,
      brainstormShown: parsed?.brainstormShown === true,
    };
  } catch {
    return { opens: 0, shows: 0, lastShownAt: null, brainstormShown: false };
  }
}

async function saveDiscoverMemory(userId: string, mem: DiscoverNudgeMemory): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(mem));
  } catch {
    // Best-effort: a failed write means one re-count/re-show, not a loss.
  }
}

// Count one app open for this user and return the updated memory.
export async function recordDiscoverOpen(userId: string): Promise<DiscoverNudgeMemory> {
  const mem = await loadDiscoverMemory(userId);
  const next = { ...mem, opens: mem.opens + 1 };
  await saveDiscoverMemory(userId, next);
  return next;
}

export async function markDiscoverShown(
  userId: string,
  kind: DiscoverNudgeKind,
  nowMs: number,
): Promise<void> {
  const mem = await loadDiscoverMemory(userId);
  await saveDiscoverMemory(userId, {
    ...mem,
    shows: mem.shows + 1,
    lastShownAt: nowMs,
    brainstormShown: mem.brainstormShown || kind === 'brainstorm',
  });
}

export interface DiscoverNudgeInput {
  opens: number;
  shows: number;
  lastShownAt: number | null;
  brainstormShown: boolean;
  // Every add-on (paid + free) owned/claimed → nothing left to promote there.
  allAddonsOwned: boolean;
  nowMs: number;
}

// Which version (if any) this open may present. The cooldown spans both kinds
// — a user who bought the last add-on right after an add-ons showing isn't
// re-interrupted with the brainstorm pitch the next morning.
export function pickDiscoverNudge(i: DiscoverNudgeInput): DiscoverNudgeKind | null {
  if (i.opens < DISCOVER_MIN_OPENS) return null;
  if (i.lastShownAt != null && i.nowMs - i.lastShownAt < DISCOVER_COOLDOWN_MS) return null;
  if (i.allAddonsOwned) return i.brainstormShown ? null : 'brainstorm';
  return i.shows >= DISCOVER_MAX_SHOWS ? null : 'addons';
}
