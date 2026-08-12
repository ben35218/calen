import { invitationsApi, EventInvitation, InvitationEventSnapshot } from '../api';
import { sealInvitationSnapshot, ensureHouseholdKey, sealNew } from './e2ee';
import { eventInvitationExpired } from './inviteAlerts';
import { API_URL, WEB_URL } from '../config';
// Type-only: shareInvite imports normalizePhone from this module, so a value
// import here would be a require cycle.
import type { EmailContent } from './shareInvite';

// Cross-household event invitees, addressed by email or by phone (SMS). Email
// and phone entries stage identically (EventInviteesScreen) and send together:
// on the Invitees screen's ✓ for a saved event, or right after save for a new
// one (EventFormScreen). ALL outreach is device-composed, matching the other
// sharing flows (households-sharing.md): the server records the invitation and
// sends nothing. An email that belongs to an account gets a server push + the
// in-app Invitations inbox instead of any email; a non-account email is
// composed from the organizer's own mail app (via the mail-app chooser) with
// the event and its public .ics link; a phone opens the Messages composer with
// the same link.

export type InviteeEntry = { email?: string; phone?: string };

export const inviteeKey = (e: InviteeEntry) => e.email ?? e.phone ?? '';

// Mirrors the server's normalization so dedupe checks agree with what it stores.
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (s.startsWith('+') ? '+' : '') + digits;
}

export function formatWhen(s: InvitationEventSnapshot): string {
  const d = new Date(s.startDate);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (s.allDay !== false) return date;
  return `${date} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

// Prefilled Messages composer: the user sends the text themselves, from their
// own number. The link is the invitation's public .ics download. Resolves when
// the composer closes, so texts can be sequenced one per invitee.
export async function composeSmsInvite(
  phone: string,
  inv: EventInvitation,
  snapshot: InvitationEventSnapshot,
) {
  // expo-sms is a native module — require it lazily so JS bundles still boot
  // on dev clients built before it was added (those fail here, when a text is
  // actually attempted, instead of at app launch).
  let SMS: typeof import('expo-sms');
  try {
    SMS = require('expo-sms');
  } catch {
    throw new Error('This app build has no text-message support — rebuild the app');
  }
  if (!(await SMS.isAvailableAsync())) {
    throw new Error('Text messaging is not available on this device');
  }
  const link = `${API_URL}/invitations/public/${inv._id}/ics?k=${inv.shareToken}`;
  // A past event reads as sharing a record, not a "join me" ask.
  const body = eventInvitationExpired(snapshot)
    ? `Sharing “${snapshot.title}” from ${formatWhen(snapshot)}. Tap to add it to your calendar: ${link}`
    : `Join me for “${snapshot.title}” on ${formatWhen(snapshot)}. Tap to add it to your calendar: ${link}`;
  await SMS.sendSMSAsync([phone], body);
}

// Accepting a cross-household invitation (Signal-parity C3b): the server can't
// read the sealed source event, so the recipient's device seals its OWN copy.
// Fold `invitationId` into the decrypted snapshot (which flips this copy's delete
// action to "Leave event" and marks it read-only), seal it under this session's
// HDK, and return the client-minted `_id` + opaque `enc` that
// `POST /invitations/:id/accept` stores as a Record it can't read. Throws when
// the vault is locked (no HDK to seal with) so the caller can prompt to unlock,
// rather than posting a bare snapshot the server rejects with "A sealed event
// copy (_id + enc) is required".
export async function sealAcceptedCopy(
  snapshot: InvitationEventSnapshot,
  invitationId: string,
): Promise<{ _id: string; enc: unknown; keyVersion?: number }> {
  await ensureHouseholdKey();
  const sealed = await sealNew('CalendarEvent', { ...snapshot, invitationId });
  if (!sealed.enc || typeof sealed._id !== 'string') {
    throw new Error('Unlock your vault before accepting this invitation.');
  }
  return { _id: sealed._id, enc: sealed.enc, keyVersion: sealed.keyVersion as number | undefined };
}

// The composed invite email for one invitation — mirrors the SMS text. A
// plaintext-lane invitation carries the public .ics link (import into any
// calendar, no account needed); a sealed invitation's content only exists
// in-app (its public .ics route 404s), so that email is a notice pointing at
// the app instead. Used for the initial non-account outreach and for Remind.
export function eventInviteEmailContent(snapshot: InvitationEventSnapshot, inv: EventInvitation): EmailContent {
  // A past event reads as sharing a record, not a "join me" ask (the in-app
  // card mirrors this: Add to Calendar instead of Accept/Decline).
  const past = eventInvitationExpired(snapshot);
  const subject = past ? `Sharing “${snapshot.title}”` : `Join me for “${snapshot.title}”`;
  if (inv.sealedEvent) {
    return {
      subject,
      body:
        (past
          ? `I’m sharing “${snapshot.title}” from ${formatWhen(snapshot)} with you. `
          : `I invited you to “${snapshot.title}” on ${formatWhen(snapshot)}. `) +
        `The invitation is end-to-end encrypted — open your invitations in the Calen app to ${past ? 'view it' : 'respond'}: ${WEB_URL}`,
    };
  }
  const link = `${API_URL}/invitations/public/${inv._id}/ics?k=${inv.shareToken}`;
  return {
    subject,
    body: past
      ? `Sharing “${snapshot.title}” from ${formatWhen(snapshot)}. Tap to add it to your calendar: ${link}`
      : `Join me for “${snapshot.title}” on ${formatWhen(snapshot)}. Tap to add it to your calendar: ${link}`,
  };
}

// Send a batch of staged entries for a saved event. API sends go out in
// parallel; composers (mail for non-account emails, Messages for texts) run
// one at a time — each opens on top and the next waits. Returns the entries
// that failed (with why) so callers can keep them staged.
export async function sendInvitations(
  eventId: string,
  entries: InviteeEntry[],
  snapshot: InvitationEventSnapshot,
  // Whether cross-household invitees may see who else is invited. Sealed event
  // content the server can't read off the source event, so it rides each send
  // and is snapshotted onto the invitation (the guest-list gate reads it there).
  guestListVisible: boolean,
  // The screen's mail composer (useEmailComposer). Opens the organizer's own
  // mail app for each invitee WITHOUT an account — an account holder gets the
  // server push + in-app inbox instead, so no composer opens for them.
  composeEmail: (email: string, content: EmailContent) => Promise<void>,
): Promise<{ entry: InviteeEntry; error: string }[]> {
  const failures: { entry: InviteeEntry; error: string }[] = [];
  const reason = (e: any) => e?.response?.data?.error || e?.message || 'could not send the invitation';

  // Composers must open one at a time; collect each non-account invitee's
  // composed email here while the API sends run in parallel.
  const outreach: { entry: InviteeEntry; email: string; content: EmailContent }[] = [];

  await Promise.all(
    entries
      .filter((e) => e.email)
      .map(async (entry) => {
        try {
          // D3: if the invitee is a known account with enrolled keys, seal the
          // snapshot to their identity key on-device — the server never sees the
          // plaintext. Otherwise (no account / no keys) fall back to the
          // plaintext lane, which the .ics link still needs. The same lookup
          // decides outreach: an account holder is nudged by server push + the
          // in-app inbox; only a non-account email gets a composed email.
          let pub: string | null = null;
          let hasAccount = false;
          try {
            const res = (await invitationsApi.lookup({ email: entry.email })).data;
            pub = res.identityPublicKey;
            hasAccount = res.userExists;
          } catch { /* lookup failed → plaintext lane, compose (fail open) */ }
          let inv: EventInvitation;
          if (pub) {
            const sealedEvent = await sealInvitationSnapshot(snapshot, pub);
            inv = (await invitationsApi.send({ eventId, email: entry.email, sealedEvent, guestListVisible })).data.invitation;
          } else {
            inv = (await invitationsApi.send({ eventId, email: entry.email, event: snapshot, guestListVisible })).data.invitation;
          }
          if (!hasAccount) {
            outreach.push({ entry, email: inv.toEmail ?? entry.email!, content: eventInviteEmailContent(snapshot, inv) });
          }
        } catch (e: any) {
          failures.push({ entry, error: reason(e) });
        }
      }),
  );

  for (const o of outreach) {
    try {
      await composeEmail(o.email, o.content);
    } catch (e: any) {
      failures.push({ entry: o.entry, error: reason(e) });
    }
  }

  for (const entry of entries.filter((e) => e.phone)) {
    try {
      const inv = (await invitationsApi.send({ eventId, phone: entry.phone, event: snapshot, guestListVisible })).data
        .invitation;
      await composeSmsInvite(inv.toPhone ?? entry.phone!, inv, snapshot);
    } catch (e: any) {
      failures.push({ entry, error: reason(e) });
    }
  }

  return failures;
}
