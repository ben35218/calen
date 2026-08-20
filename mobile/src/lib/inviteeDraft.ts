import { useSyncExternalStore } from 'react';
import { InviteeEntry } from './invitees';

// The staging area for one event-form session's invitee edits. The Invitees
// screen never sends anything itself when it was opened FROM THE EVENT FORM
// (new or existing event): its ✓ commits the staged list here, and
// EventFormScreen performs the sends/revokes/notifies after a successful save.
// Nothing an event form can still discard is allowed to have gone out already —
// a new event couldn't send anyway (no event id yet), and an edit that the user
// backs out of must leave the invitee list exactly as it was. The one entry
// point that still acts immediately is the event DETAIL screen's Invitees row:
// there is no pending save behind it, so its ✓ is the commit.
//
// Module-level (not route params) so the form and the pushed Invitees screen
// share one live list without non-serializable params.

let queued: InviteeEntry[] = [];
// Already-sent invitations (ids) the user removed this session. They are
// revoked by the form's save, alongside the sends above.
let queuedRevokes: string[] = [];
// Household members (userIds) picked in the Invitees screen's "Your household"
// section. Same doctrine as `queued`: a draft commits them here, and
// EventFormScreen seals them into the create payload (householdInvitees) and
// notifies them after the save. On EDIT the form seeds this from the fetched
// event, so a whole-payload re-save preserves the list.
let queuedHouseholdInvitees: string[] = [];
// The guest-list visibility flag rides the same store: the Invitees screen owns
// the switch (for drafts AND saved events — the form seeds it from the fetched
// event), and EventFormScreen reads it into the sealed save payload. Only the
// detail-screen entry re-seals it on its own (calendarApi.setGuestListVisible).
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

// Empty the whole staging area — every form session starts and ends with this,
// so an abandoned draft or a discarded edit leaves nothing behind for the next
// one to send.
export function clearQueuedInvitees() {
  if (queued.length || queuedRevokes.length || queuedHouseholdInvitees.length || !guestListVisible) {
    queued = [];
    queuedRevokes = [];
    queuedHouseholdInvitees = [];
    guestListVisible = true;
    emit();
  }
}

export function getQueuedRevokes(): string[] {
  return queuedRevokes;
}

export function setQueuedRevokes(next: string[]) {
  queuedRevokes = next;
  emit();
}

export function useQueuedRevokes(): string[] {
  return useSyncExternalStore(subscribe, () => queuedRevokes);
}

export function getQueuedHouseholdInvitees(): string[] {
  return queuedHouseholdInvitees;
}

export function setQueuedHouseholdInvitees(next: string[]) {
  queuedHouseholdInvitees = next;
  emit();
}

export function useQueuedHouseholdInvitees(): string[] {
  return useSyncExternalStore(subscribe, () => queuedHouseholdInvitees);
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
