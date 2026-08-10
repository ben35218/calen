import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { createRecordSocket, RecordSocketManager } from '../lib/recordSocket';
import { registerPushSyncTask, unregisterPushSyncTask, consumeReplicaDirty } from '../lib/pushSync';
import { scheduleRevalidate } from '../lib/calendarData';
import { queryClient } from '../lib/queryClient';

// Real-time calendar sync wiring (mounted once in RootNavigator). Three lanes,
// all converging on the same cursor pull:
//   1. Foreground: the poke WebSocket (lib/recordSocket) — a housemate's write
//      pokes this device within moments; connected while the app is active,
//      torn down in the background (iOS would kill it anyway).
//   2. Background: the silent-push task (lib/pushSync) refreshes the replica
//      while the app is backgrounded; on return to foreground its dirty flag
//      invalidates ['calendar'] so the fresh replica actually paints.
//   3. Every foreground transition schedules a revalidate regardless — the
//      floor that covers whatever the other two lanes missed.
export function useRecordSync(enabled: boolean) {
  const managerRef = useRef<RecordSocketManager | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const manager = createRecordSocket();
    managerRef.current = manager;
    manager.start();
    void registerPushSyncTask();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        manager.start();
        void consumeReplicaDirty().then((dirty) => {
          if (dirty) queryClient.invalidateQueries({ queryKey: ['calendar'] });
        });
        scheduleRevalidate();
      } else if (state === 'background') {
        manager.stop();
      }
    });

    return () => {
      sub.remove();
      manager.stop();
      managerRef.current = null;
      void unregisterPushSyncTask();
    };
  }, [enabled]);
}
