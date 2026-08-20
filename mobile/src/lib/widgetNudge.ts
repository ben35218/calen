import AsyncStorage from '@react-native-async-storage/async-storage';

// The widget-adoption nudge (spec: features/notifications.md — Widget nudge;
// the widget and promo screen themselves are normative in calendar.md): a
// one-time "add the widget" promo (the WidgetPromo modal, with a preview built
// from the user's own snapshot) presented from the device's SECOND app open,
// with a single quieter re-nudge later if the widget still isn't installed.
// This is the pure, testable half — cadence/eligibility and the per-user
// memory. The install-check/navigation wiring lives in hooks/useWidgetNudge.
//
// The cadence rules, mirroring the security/discovery guardrails:
// - never on the first open (that run belongs to the recovery-code ceremony);
// - iOS can't install a widget for the user, so a user who already added one
//   via the widget gallery gets NOTHING — `installed` vetoes everything;
// - at most TWO showings ever: the promo, and one re-nudge after a 14-day
//   cooldown for users who saw it but never added the widget. After that the
//   Profile widget promo card is the only surface, forever.

export interface WidgetNudgeMemory {
  // Cold starts counted while the full app shell was up for this user.
  opens: number;
  // Times the promo has been presented by the nudge lane.
  shows: number;
  // When it last presented (ms epoch) — drives the re-nudge cooldown.
  lastShownAt: number | null;
}

const KEY_PREFIX = 'hc_widget_nudge:';

export const WIDGET_MIN_OPENS = 2;
export const WIDGET_MAX_SHOWS = 2;
export const WIDGET_RENUDGE_COOLDOWN_MS = 14 * 24 * 3600_000;

export async function loadWidgetNudgeMemory(userId: string): Promise<WidgetNudgeMemory> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as Partial<WidgetNudgeMemory>) : null;
    return {
      opens: typeof parsed?.opens === 'number' ? parsed.opens : 0,
      shows: typeof parsed?.shows === 'number' ? parsed.shows : 0,
      lastShownAt: typeof parsed?.lastShownAt === 'number' ? parsed.lastShownAt : null,
    };
  } catch {
    return { opens: 0, shows: 0, lastShownAt: null };
  }
}

async function saveWidgetNudgeMemory(userId: string, mem: WidgetNudgeMemory): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(mem));
  } catch {
    // Best-effort: a failed write means one re-count/re-show, not a loss.
  }
}

// Count one app open for this user and return the updated memory.
export async function recordWidgetNudgeOpen(userId: string): Promise<WidgetNudgeMemory> {
  const mem = await loadWidgetNudgeMemory(userId);
  const next = { ...mem, opens: mem.opens + 1 };
  await saveWidgetNudgeMemory(userId, next);
  return next;
}

export async function markWidgetNudgeShown(userId: string, nowMs: number): Promise<void> {
  const mem = await loadWidgetNudgeMemory(userId);
  await saveWidgetNudgeMemory(userId, {
    ...mem,
    shows: mem.shows + 1,
    lastShownAt: nowMs,
  });
}

export interface WidgetNudgeInput {
  opens: number;
  shows: number;
  lastShownAt: number | null;
  // The widget is already on the Home/Lock Screen (WidgetKit's
  // getCurrentConfigurations) — nothing to promote.
  installed: boolean;
  nowMs: number;
}

// Whether this open may present the promo. The hook additionally requires the
// native bridge (a build that actually ships the widget) and iOS.
export function pickWidgetNudge(i: WidgetNudgeInput): boolean {
  if (i.installed) return false;
  if (i.opens < WIDGET_MIN_OPENS) return false;
  if (i.shows >= WIDGET_MAX_SHOWS) return false;
  if (
    i.shows > 0 &&
    (i.lastShownAt == null || i.nowMs - i.lastShownAt < WIDGET_RENUDGE_COOLDOWN_MS)
  ) {
    return false;
  }
  return true;
}
