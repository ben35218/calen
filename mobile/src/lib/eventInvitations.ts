import { invitationsApi, type EventInvitation, type InvitationEventSnapshot } from '../api';
import { openInvitationSnapshot } from './e2ee';

// The ONE definition of the `['invitations']` query — event invitations
// addressed to me, with their sealed snapshots opened.
//
// This is deliberately not "a helper the inbox happens to use". React Query
// caches by KEY, and three surfaces read this key (the inbox, the badge count,
// and the event form's "who invited me" line) while only ONE of them ever
// wanted the decrypt. Whichever observer happens to trigger the fetch decides
// which `queryFn` runs, and every reader gets that result — so a badge refetch
// (mounted on the calendar home AND on Profile, i.e. always) would overwrite
// the cache with UNDECRYPTED rows, and the inbox opened seconds later served
// them straight from cache under its own staleTime. A D3 sealed invitation has
// no plaintext `event`, so it rendered as "Unlock to view this invitation" —
// a padlock shown to someone whose vault was open, cleared only by a manual
// pull-to-refresh (which the inbox's own observer performs, so THAT fetch
// decrypted). Reaching the inbox from Profile hit it almost every time: the
// Profile badge refetches on the way in.
//
// A shared key must therefore have a shared queryFn. Import these two together
// and never inline a second reader of `['invitations']`.

export const EVENT_INVITATIONS_KEY = ['invitations'] as const;

// Open the D3 sealed snapshot on each invitation that carries one. Idempotent
// and safe for every reader: a row that already has plaintext `event`, or that
// isn't sealed to us, is returned untouched — so the badge and the event form
// pay for at most a few unseals and can never be handed a row the inbox
// couldn't render.
export async function fetchEventInvitations(): Promise<EventInvitation[]> {
  const { data } = await invitationsApi.list();
  return Promise.all(
    data.map(async (inv) => {
      if (inv.event?.title || !inv.sealedEvent) return inv;
      const snap = await openInvitationSnapshot<InvitationEventSnapshot>(inv.sealedEvent);
      return snap ? { ...inv, event: snap } : inv;
    }),
  );
}
