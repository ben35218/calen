// Cook timers that outlive the cooking screen.
//
// A step timer is a wall-clock deadline (`endsAt`), never a decrementing count:
// that keeps it honest across a backgrounded app and — the reason this module
// exists — across leaving the cooking screen. Closing the view unmounts the
// component, so a countdown living in component state died with it and the pot
// simmered on untimed. The timers therefore live here, in a module-level store
// keyed by recipe, and the screen only renders them.
//
// Two alerting paths, deliberately exclusive per timer:
//   - screen open  → the in-app chip flips to "Done!" and the phone buzzes.
//   - screen left  → the timer is ARMED: a local notification is scheduled for
//     its deadline, because a buzz from a screen nobody is looking at is not an
//     alert. Coming back disarms it again.

import { Vibration } from 'react-native';
import * as Notifications from 'expo-notifications';

export interface CookTimer {
  id: string;
  recipeId: string;
  label: string;      // "Step 3"
  endsAt: number;     // epoch ms
  done: boolean;
  notificationId: string | null;  // set while armed (screen not open)
}

// Whole seconds left, floored at 0 — what the chip renders.
export const remainingSecs = (t: CookTimer, now = Date.now()) =>
  Math.max(0, Math.ceil((t.endsAt - now) / 1000));

let timers: CookTimer[] = [];
let seq = 0;
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

const emit = () => listeners.forEach((l) => l());

// One shared ticker for every live timer, running only while one exists. It
// both flips timers done and drives the once-a-second chip re-render, so it
// emits on every pass rather than only on a state change.
function tick() {
  const now = Date.now();
  for (const t of timers) {
    if (t.done || t.endsAt > now) continue;
    t.done = true;
    // An armed timer alerts through its notification; buzzing here too would
    // double-alert the cook who is elsewhere in the app.
    if (!t.notificationId) Vibration.vibrate(800);
  }
  if (!timers.some((t) => !t.done)) stopTicker();
  emit();
}

function startTicker() {
  if (!ticker) ticker = setInterval(tick, 1000);
}
function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

export function subscribeCookTimers(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getCookTimers = (recipeId: string) => timers.filter((t) => t.recipeId === recipeId);
export const runningCookTimers = (recipeId: string) =>
  timers.filter((t) => t.recipeId === recipeId && !t.done);

// Start a step's timer. Re-starting a step that already has one on screen is a
// no-op — advancing back and forth through a step must not stack countdowns.
export function startCookTimer(recipeId: string, label: string, minutes: number): void {
  if (!(minutes > 0)) return;
  if (timers.some((t) => t.recipeId === recipeId && t.label === label)) return;
  timers = [...timers, {
    id: `${recipeId}-${label}-${++seq}`,
    recipeId,
    label,
    endsAt: Date.now() + Math.round(minutes * 60) * 1000,
    done: false,
    notificationId: null,
  }];
  startTicker();
  emit();
}

function drop(pred: (t: CookTimer) => boolean) {
  const going = timers.filter(pred);
  if (!going.length) return;
  timers = timers.filter((t) => !pred(t));
  going.forEach((t) => { if (t.notificationId) cancelAlarm(t.notificationId); });
  if (!timers.some((t) => !t.done)) stopTicker();
  emit();
}

export const dismissCookTimer = (id: string) => drop((t) => t.id === id);
// "Stop the timer" on the way out — the cook is done with this recipe.
export const stopCookTimers = (recipeId: string) => drop((t) => t.recipeId === recipeId);
// Finished timers have nothing left to count; clearing them on the way out
// keeps a stale "Done!" chip from greeting the next cook of this recipe.
export const clearFinishedCookTimers = (recipeId: string) =>
  drop((t) => t.recipeId === recipeId && t.done);

// ── Alarms ──────────────────────────────────────────────────────────────────

const cancelAlarm = (nid: string) =>
  Notifications.cancelScheduledNotificationAsync(nid).catch(() => {});

// Permission, prompting once if undetermined. Deliberately not imported from
// lib/notifications: that module imports this one (to survive its own
// cancel-everything pass), and the cycle is not worth three lines.
async function canNotify(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  return (await Notifications.requestPermissionsAsync()).status === 'granted';
}

// Hand this recipe's running timers to the OS — called when the cook leaves the
// screen but keeps the timers going. Permission may be refused; the timer still
// runs and is still correct when they come back, it just can't shout.
export async function armCookTimerAlarms(recipeId: string): Promise<void> {
  const live = runningCookTimers(recipeId);
  if (!live.length) return;
  if (!(await canNotify())) return;
  for (const t of live) {
    if (t.notificationId) continue;
    try {
      t.notificationId = await Notifications.scheduleNotificationAsync({
        content: { title: 'Timer done', body: `${t.label} is up.` },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(t.endsAt) },
      });
    } catch { /* no alarm; the on-screen countdown is unaffected */ }
  }
}

// Back on the screen: the chip and the buzz take over again.
export async function disarmCookTimerAlarms(recipeId: string): Promise<void> {
  for (const t of timers) {
    if (t.recipeId !== recipeId || !t.notificationId) continue;
    const nid = t.notificationId;
    t.notificationId = null;
    await cancelAlarm(nid);
  }
}

// The reminder scheduler rebuilds its whole batch by cancelling every scheduled
// notification (lib/notifications), which would silently take armed cook timers
// with it — the alarm would vanish on the next app foreground. It calls this
// afterwards to put them back.
export async function restoreCookTimerAlarms(): Promise<void> {
  const armed = timers.filter((t) => !t.done && t.notificationId);
  for (const t of armed) {
    t.notificationId = null;
    try {
      t.notificationId = await Notifications.scheduleNotificationAsync({
        content: { title: 'Timer done', body: `${t.label} is up.` },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(t.endsAt) },
      });
    } catch { /* leave it disarmed rather than half-tracked */ }
  }
}

// Test seam: the store is module state, so a suite that starts a timer leaks it
// (and its ticker) into the next one.
export function resetCookTimers(): void {
  timers = [];
  stopTicker();
  listeners.clear();
}
