import { useSyncExternalStore } from 'react';
import type { TravelMode } from '../api';

// Travel-time settings edited on the pushed EventTravelTime screen. The event
// form and the pushed screen share this module-level draft (mirrors
// inviteeDraft.ts) so edits flow back to the form live without
// non-serializable route params.

export interface TravelDraft {
  enabled: boolean;
  fromAddress: string;
  // How the user is travelling — the mode the automatic time is computed for.
  mode: TravelMode;
  // A manually chosen duration in minutes; null = automatic (computed from the
  // starting location to the event location).
  manualMinutes: number | null;
}

let draft: TravelDraft | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setTravelDraft(next: TravelDraft) {
  draft = next;
  emit();
}

export function clearTravelDraft() {
  if (draft) {
    draft = null;
    emit();
  }
}

export function useTravelDraft(): TravelDraft | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => draft,
  );
}
