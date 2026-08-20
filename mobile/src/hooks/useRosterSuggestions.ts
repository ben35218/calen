import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contactsApi, Contact } from '../api';
import { openRecord } from '../lib/e2ee';
import { normalizeContact, NormalizedContact } from '../lib/contactFields';
import { normalizePhone } from '../lib/invitees';
import { canonicalizePhoneForStorage, formatDisplay } from '../lib/phone';
import type { Recipient } from '../lib/shareInvite';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A matched contact is offered once per reachable address, not once per contact —
// a contact with a work and a home email, or an email and two phones, gets a row
// for each, so the sender picks the address instead of accepting whichever one
// happened to be first on the card.
export type RosterSuggestion = {
  // Stable per row: the same contact appears on several rows.
  key: string;
  p: Contact;
  entry: Recipient;
  // The contact-card label for this address ('work', 'mobile', …); '' when the
  // record carries none (legacy single-value fields).
  label: string;
  // The address as it should be shown — the email verbatim, a phone prettified.
  display: string;
};

// At most this many matched contacts, and this many rows, per query. A contact
// is included whole or not at all (a half-listed set of addresses reads as if
// the rest don't exist), so the first match always lists every address even when
// it alone exceeds the row cap.
const MAX_PEOPLE = 5;
const MAX_ROWS = 6;

type Address = { entry: Recipient; label: string; display: string; key: string };

// Every address on a contact card that could actually receive an invite, in card
// order: emails first, then phones. Phones are canonicalized to the SAME E.164
// the account phone stores (so a phone invite resolves to the recipient's
// account) with `normalizePhone` gating plausibility first; duplicates across
// the card collapse to one row.
function addressesOf(n: NormalizedContact): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const e of n.emails) {
    const email = e.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ entry: { email }, label: e.label ?? '', display: email, key: email });
  }
  for (const ph of n.phones) {
    if (!normalizePhone(ph.value)) continue;
    const phone = canonicalizePhoneForStorage(ph.value);
    const key = phone.toLowerCase();
    if (!phone || seen.has(key)) continue;
    seen.add(key);
    out.push({ entry: { phone }, label: ph.label ?? '', display: formatDisplay(phone) || phone, key });
  }
  return out;
}

// The in-app contacts roster matched against what's typed (by name, email, or
// phone digits), expanded to one suggestion per reachable address.
//
// `taken` holds the addresses that are already spoken for — current members,
// outstanding invites, the signed-in user. A collision drops the WHOLE contact,
// never just the colliding address: if someone is already in the household, the
// other numbers and emails on their card reach the same contact, so offering them
// would send an invite the server rejects ("already in your household"), or —
// when the address isn't on their account — file one that can never resolve.
// That fallthrough is what made an existing member show up under their phone
// number while a stranger showed up under their email.
export function matchRoster(contacts: Contact[], query: string, taken: Set<string>): RosterSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qDigits = q.replace(/\D/g, '');
  const rows: RosterSuggestion[] = [];
  let matched = 0;
  for (const p of contacts) {
    if (matched >= MAX_PEOPLE || rows.length >= MAX_ROWS) break;
    const n = normalizeContact(p);
    const hit = (p.name ?? '').toLowerCase().includes(q)
      || n.emails.some((e) => e.value.toLowerCase().includes(q))
      || (!!qDigits && n.phones.some((ph) => ph.value.replace(/\D/g, '').includes(qDigits)));
    if (!hit) continue;
    const addresses = addressesOf(n);
    if (!addresses.length || addresses.some((a) => taken.has(a.key))) continue;
    // Never split a contact across the row cap — stop before one that wouldn't
    // fit whole (unless it's the first, which always lists in full).
    if (rows.length && rows.length + addresses.length > MAX_ROWS) break;
    matched += 1;
    for (const a of addresses) {
      rows.push({ key: `${p._id}:${a.key}`, p, entry: a.entry, label: a.label, display: a.display });
    }
  }
  return rows;
}

// Contacts-roster autocomplete backing every share/invite field (household
// invite, calendar outside-share, event invitees): the decrypted Contacts
// records — one query key across all of them, so the on-device decrypt is
// shared — run through `matchRoster` against the typed text. Every invite field
// resolves addresses the same way; a screen that re-rolls the match drifts (the
// event-invitee picker did, and silently offered only each contact's primary
// email). The source is the in-app
// roster, not the device address book; typing a raw email/phone for someone
// not on file still works in every caller.
export function useRosterSuggestions(query: string, taken: Set<string>, enabled = true): RosterSuggestion[] {
  const contactsQ = useQuery({
    queryKey: ['contacts', 'decrypted'],
    queryFn: async () => {
      const rows = (await contactsApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Contact', p) as Promise<Contact>));
    },
    enabled,
  });
  return useMemo(() => matchRoster(contactsQ.data ?? [], query, taken), [contactsQ.data, query, taken]);
}
