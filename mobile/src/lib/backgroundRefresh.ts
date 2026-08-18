// Background reminder refresh (Phase 5 follow-through). The OS periodically
// grants a background slot; each run re-fetches the calendar window and
// re-schedules the rolling local-notification batch, so reminders stay accurate
// even when the app isn't foregrounded for days. Best-effort by design — iOS
// decides when (if ever) to run it — so the app-foreground reschedule in
// useReminderScheduler remains the reliability floor. Native module: needs a
// dev-client/EAS rebuild, and silently no-ops in Expo Go.
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { rescheduleReminders } from './notifications';
import { refreshWidgetSnapshot } from './widgetSnapshot';

const TASK = 'reminder-refresh';

// Defined at module scope: TaskManager must know the handler at bundle load so
// the OS can invoke it when the app is woken in the background. If the session
// is signed out or the HDK is locked, rescheduleReminders safely returns 0.
TaskManager.defineTask(TASK, async () => {
  try {
    const scheduled = await rescheduleReminders();
    // Same slot keeps the home-screen widget's snapshot window rolling
    // forward between foregrounds (no-op when locked or bridge-less).
    await refreshWidgetSnapshot();
    return scheduled > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundRefresh(): Promise<void> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status !== BackgroundFetch.BackgroundFetchStatus.Available) return;
    if (await TaskManager.isTaskRegisteredAsync(TASK)) return;
    await BackgroundFetch.registerTaskAsync(TASK, {
      minimumInterval: 6 * 60 * 60, // seconds — a floor; the OS picks the cadence
      stopOnTerminate: false,       // Android: keep running after the app is swiped away
      startOnBoot: true,            // Android: re-arm after reboot
    });
  } catch {
    // Expo Go / simulator / restricted device — foreground refresh still covers us.
  }
}

export async function unregisterBackgroundRefresh(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(TASK)) {
      await BackgroundFetch.unregisterTaskAsync(TASK);
    }
  } catch {}
}
