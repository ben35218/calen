// Silent-push replica refresh — the background complement to the foreground
// poke socket (lib/recordSocket). When a housemate writes a record, the server
// sends the household a DATA-ONLY push (`type: 'records_changed'`, no banner);
// iOS/Android wake the app briefly in the background and this task pulls the
// sync cursor into the replica, so the calendar is already fresh the next time
// the user opens the app. Best-effort by design — the OS throttles silent
// pushes — the socket + foreground revalidate remain the reliability floor.
//
// Staleness trap this file also solves: a background sync fills the REPLICA,
// but a mounted month grid only repaints off an invalidation, and the next
// foreground revalidate would pull zero new rows ("nothing changed") and skip
// invalidating — leaving fresh data invisible. So the task sets a dirty flag;
// useRecordSync consumes it on foreground and invalidates ['calendar'].
//
// Native module notes: needs `remote-notification` in UIBackgroundModes
// (app.json) and therefore a dev-client/EAS rebuild; silently no-ops in Expo Go.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

const TASK = 'records-changed-sync';
const DIRTY_KEY = 'hc_replica_dirty';

const store = () => require('@react-native-async-storage/async-storage').default;

// Module-scope task definition: TaskManager must know the handler at bundle
// load so the OS can invoke it when the app is woken for a silent push. If the
// session is signed out (401) or the keys are locked (rows skipped, cursor
// parked), syncRecords degrades safely.
TaskManager.defineTask(TASK, async () => {
  try {
    const { syncRecords } = require('./records') as typeof import('./records');
    const res = await syncRecords();
    if (res.upserted + res.removed > 0) {
      await store().setItem(DIRTY_KEY, '1');
      // Same runtime as the app when it's alive in memory: invalidate so any
      // mounted calendar refetches (from the now-fresh replica) immediately.
      require('./queryClient').queryClient.invalidateQueries({ queryKey: ['calendar'] });
      // A housemate's write should reach this device's home-screen widget
      // without the app being opened: rewrite the App Group snapshot from the
      // replica the sync just refreshed (no-op when locked or bridge-less).
      const { refreshWidgetSnapshot } = require('./widgetSnapshot') as typeof import('./widgetSnapshot');
      await refreshWidgetSnapshot();
    }
  } catch {
    // Offline / signed out / locked — the next foreground pass covers it.
  }
});

export async function registerPushSyncTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(TASK);
  } catch {
    // Expo Go / simulator / missing background mode — foreground paths still cover us.
  }
}

export async function unregisterPushSyncTask(): Promise<void> {
  try {
    await Notifications.unregisterTaskAsync(TASK);
  } catch {}
}

// Consume-once dirty flag: true when a background sync changed the replica
// since the last foreground. The caller invalidates ['calendar'] in response.
export async function consumeReplicaDirty(): Promise<boolean> {
  try {
    const dirty = (await store().getItem(DIRTY_KEY)) != null;
    if (dirty) await store().removeItem(DIRTY_KEY);
    return dirty;
  } catch {
    return false;
  }
}
