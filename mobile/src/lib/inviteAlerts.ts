import AsyncStorage from '@react-native-async-storage/async-storage';
import { HouseholdEventRequest } from './householdRsvp';

// The app-open invitation pop-up (hooks/useInviteAlerts). Push is best-effort —
// an invite must still reach a user who denied notifications, missed the
// banner, or was offline — so opening the app checks every invitation lane the
// Invitations inbox lists for pending items this device hasn't prompted about
// yet and raises ONE native alert (the app's iOS-style confirm pattern).
// Everything here is the pure, testable half; the hook owns the fetching and
// the Alert + navigation wiring.
//
// Kinds mirror the inbox rows addressed to me (plus the always-actionable
// approver-side join request):
//   householdEvent — a housemate's accept/decline request on a household event
//                    (replica-derived; the only kind answerable INSIDE the
//                    alert, because the answer is one sealed EventRsvp write)
//   event          — a cross-household event invitation
//   calendar       — an outside calendar share
//   trip           — a trip invitation
//   household      — a household membership invitation
//   joinRequest    — someone accepted MY household's invite and waits for
//                    on-device approval
//   guardianRequest — a housemate I'm recovery guardian for is locked out and
//                    asked me to approve (routes to the Guardian recovery
//                    approve screen, not the inbox — it's a security approval,
//                    and its requests expire, so it's presented on its own and
//                    never folded into the "N new invitations" count)
// Every kind except householdEvent routes to the Invitations inbox to act —
// their accept flows are multi-step (key unwraps, join carry-over, calendar
// merge), not one-tap answers.
export type PendingInviteKind =
  | 'householdEvent'
  | 'event'
  | 'calendar'
  | 'trip'
  | 'household'
  | 'joinRequest'
  | 'guardianRequest';

export interface PendingInvite {
  kind: PendingInviteKind;
  // The invitation's own id (event id for householdEvent) — unique within its kind.
  id: string;
  // Sender display name (resolved by the hook; may be missing on sealed rows).
  from?: string | null;
  // What's being joined: event title, calendar name, trip name, household name.
  title?: string | null;
  // householdEvent only: the derived request, for the detailed card + respond.
  request?: HouseholdEventRequest;
  // event only: a record-share (sent after the event ended) — worded "shared",
  // not "invited you … accept or decline" (see isEventRecordShare).
  shared?: boolean;
}

// The prompted-once memory key: kinds have separate id spaces.
export function inviteKey(i: Pick<PendingInvite, 'kind' | 'id'>): string {
  return `${i.kind}:${i.id}`;
}

// Whether the invitation's event has ENDED (an event currently happening is
// still worth answering). A sealed snapshot (vault locked → no readable dates)
// fails open. All-day dates are stored at noon UTC, so the stored instant gets
// a day of grace before the day counts as over.
type EventWhen = { startDate?: string; endDate?: string; allDay?: boolean };

// The event's effective end instant (grace included), or null when unreadable.
function eventEndMs(ev: EventWhen | undefined): number | null {
  const end = ev?.endDate || ev?.startDate;
  if (!end) return null;
  const endMs = new Date(end).getTime();
  if (Number.isNaN(endMs)) return null;
  return endMs + (ev!.allDay !== false ? 24 * 3600_000 : 0);
}

export function eventInvitationExpired(ev: EventWhen | undefined, now: Date = new Date()): boolean {
  const end = eventEndMs(ev);
  return end != null && end < now.getTime();
}

// An unanswered invitation LAPSES — leaves the inbox's New tab and the badge
// for the Replied tab's "Expired" state, and the pop-up skips it (the doctrine
// deriveHouseholdRequests applies to in-household requests) — when the event
// has ended AND the invite predates that end: the sender asked for an answer
// and the moment passed. An invitation SENT AFTER the event ended is the
// Apple/Google record-share ("put this on your calendar"), deliberate by
// construction, and never lapses — the recipient card offers Add to Calendar
// instead of Accept/Decline (isEventRecordShare). Sealed snapshots fail open.
export function invitationLapsed(
  inv: { event?: EventWhen; createdAt?: string },
  now: Date = new Date(),
): boolean {
  if (!eventInvitationExpired(inv.event, now)) return false;
  if (inv.createdAt) {
    const sent = new Date(inv.createdAt).getTime();
    const end = eventEndMs(inv.event)!;
    if (!Number.isNaN(sent) && sent > end) return false;
  }
  return true;
}

// The record-share framing test: the event is over, but this invite was sent
// after it ended — share the record, don't ask for an RSVP.
export function isEventRecordShare(
  inv: { event?: EventWhen; createdAt?: string },
  now: Date = new Date(),
): boolean {
  return eventInvitationExpired(inv.event, now) && !invitationLapsed(inv, now);
}

// Per-user memory of which invitations this device has already popped, so an
// invite prompts once — "Not Now" is a real answer, not a snooze. The
// Invitations inbox remains the durable surface for anything dismissed.
const KEY_PREFIX = 'hc_hh_invite_prompted:';
// Oldest keys fall off past this cap; by then the invitations are long
// answered or expired and the pending-only filter keeps them from re-prompting.
const MAX_REMEMBERED = 300;

export async function loadPromptedInviteKeys(userId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    const keys = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(keys) ? keys : []);
  } catch {
    return new Set();
  }
}

export async function markInvitesPrompted(userId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const seen = await loadPromptedInviteKeys(userId);
    keys.forEach((k) => seen.add(k));
    const trimmed = Array.from(seen).slice(-MAX_REMEMBERED);
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(trimmed));
  } catch {
    // Best-effort: a failed write means one extra prompt next open, not a loss.
  }
}

// The invitations worth interrupting for: never prompted on this device.
// (Callers pass only pending/actionable items.) Input order is preserved.
export function freshInvites(invites: PendingInvite[], promptedKeys: Set<string>): PendingInvite[] {
  return invites.filter((i) => !promptedKeys.has(inviteKey(i)));
}

// The Invitations-inbox when-line, reused verbatim so the pop-up and the card
// describe the event identically.
export function inviteWhenLabel(req: Pick<HouseholdEventRequest, 'startDate' | 'endDate' | 'allDay'>): string | null {
  if (!req.startDate) return null;
  const start = new Date(req.startDate);
  if (req.allDay !== false) {
    // All-day records are stored at noon UTC → read the date in UTC.
    const opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' } as const;
    const s = start.toLocaleDateString(undefined, opts);
    if (req.endDate) {
      const end = new Date(req.endDate).toLocaleDateString(undefined, opts);
      if (end !== s) return `${s} – ${end}`;
    }
    return s;
  }
  const day = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const t1 = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  if (!req.endDate) return `${day}, ${t1}`;
  const t2 = new Date(req.endDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}, ${t1} – ${t2}`;
}

// Title + message for the alert. One fresh invitation gets its kind's full
// sentence (who, what, when for events); several collapse to a count that
// routes to the inbox — a stack of sequential alerts would read as nagging.
export function inviteAlertContent(fresh: PendingInvite[]): { title: string; message: string } {
  if (fresh.length !== 1) {
    // The hook presents guardian requests separately from ordinary invitations,
    // so a plural batch is either all-guardian or guardian-free.
    if (fresh.every((i) => i.kind === 'guardianRequest')) {
      return {
        title: 'Recovery Requests',
        message: `${fresh.length} household members are locked out and asked for your help getting back in.`,
      };
    }
    return { title: 'New Invitations', message: `You have ${fresh.length} new invitations.` };
  }
  const inv = fresh[0];
  const quoted = inv.title ? `“${inv.title}”` : null;
  switch (inv.kind) {
    case 'householdEvent': {
      const who = inv.from || 'A housemate';
      const when = inv.request ? inviteWhenLabel(inv.request) : null;
      return {
        title: 'Event Invitation',
        message: `${who} invited you to ${quoted ?? 'an event'}.${when ? `\n\n${when}` : ''}`,
      };
    }
    case 'event':
      return inv.shared
        ? {
          title: 'Event Shared',
          message: `${inv.from || 'Someone'} shared ${quoted ?? 'an event'} with you.`,
        }
        : {
          title: 'Event Invitation',
          message: `${inv.from || 'Someone'} invited you to ${quoted ?? 'an event'}.`,
        };
    case 'calendar':
      return {
        title: 'Calendar Invitation',
        message: `${inv.from || 'Someone'} shared the calendar ${quoted ?? 'a calendar'} with you.`,
      };
    case 'trip':
      return {
        title: 'Trip Invitation',
        message: `${inv.from || 'Someone'} invited you to ${quoted ? `the trip ${quoted}` : 'a trip'}.`,
      };
    case 'household':
      return {
        title: 'Household Invitation',
        message: `${inv.from || 'Someone'} invited you to join ${quoted ?? 'their household'}.`,
      };
    case 'joinRequest':
      return {
        title: 'Join Request',
        message: `${inv.from || 'Someone'} wants to join your household.`,
      };
    case 'guardianRequest':
      return {
        title: 'Recovery Request',
        message: `${inv.from || 'A household member'} is locked out of their account and asked for your help getting back in.`,
      };
  }
}
