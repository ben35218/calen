import { useSyncExternalStore } from 'react';
import { InviteeEntry } from './invitees';

// Invitee entries (email or phone) queued on a NEW (not-yet-saved) event form.
// A draft has no event id, so invitations can't be sent until the event is
// created — the Invitees screen commits its staged list here on ✓ and
// EventFormScreen sends everything after a successful save. Module-level (not
// route params) so the form and the pushed Invitees screen share one live list
// without non-serializable params.

let queued: InviteeEntry[] = [];
// The "Guests can see guest list" flag rides the same store: the Invitees
// screen owns the switch (for drafts AND saved events — the form seeds it from
// the fetched event), and EventFormScreen reads it into the sealed save
// payload. Saved events re-seal the flag straight from the Invitees screen
// (calendarApi.setGuestListVisible) instead.
let guestListVisible = true;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function getQueuedInvitees(): InviteeEntry[] {
  return queued;
}

export function setQueuedInvitees(next: InviteeEntry[]) {
  queued = next;
  emit();
}

export function clearQueuedInvitees() {
  if (queued.length || !guestListVisible) {
    queued = [];
    guestListVisible = true;
    emit();
  }
}

export function getDraftGuestListVisible(): boolean {
  return guestListVisible;
}

export function setDraftGuestListVisible(v: boolean) {
  if (v !== guestListVisible) {
    guestListVisible = v;
    emit();
  }
}

export function useDraftGuestListVisible(): boolean {
  return useSyncExternalStore(subscribe, () => guestListVisible);
}

export function useQueuedInvitees(): InviteeEntry[] {
  return useSyncExternalStore(subscribe, () => queued);
}
