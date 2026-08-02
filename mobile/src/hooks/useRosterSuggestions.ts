import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { peopleApi, Person } from '../api';
import { openRecord } from '../lib/e2ee';
import { normalizePerson } from '../lib/personFields';
import { normalizePhone } from '../lib/invitees';
import { canonicalizePhoneForStorage } from '../lib/phone';
import type { Recipient } from '../lib/shareInvite';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RosterSuggestion = { p: Person; entry: Recipient };

// The in-app contacts roster matched against what's typed (by name, email, or
// phone digits), each hit resolved to the recipient a tap would use: their
// primary email, else a canonical E.164 phone (the same form the account phone
// stores, so a phone recipient resolves to their account — robust to legacy
// contacts saved in a looser format before import-time canonicalization;
// `normalizePhone` still gates plausibility so a junk value isn't offered).
// Contacts with neither, or whose address is in `taken`, are dropped.
export function matchRoster(people: Person[], query: string, taken: Set<string>): RosterSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qDigits = q.replace(/\D/g, '');
  const recipientFor = (n: ReturnType<typeof normalizePerson>): Recipient | null => {
    const email = n.emails[0]?.value.trim().toLowerCase();
    const raw = n.phones[0]?.value;
    const phone = raw && normalizePhone(raw) ? canonicalizePhoneForStorage(raw) : null;
    if (email && EMAIL_RE.test(email) && !taken.has(email)) return { email };
    if (phone && !taken.has(phone.toLowerCase())) return { phone };
    return null;
  };
  return people
    .map((p) => ({ p, n: normalizePerson(p) }))
    .map((row) => ({ ...row, entry: recipientFor(row.n) }))
    .filter(({ p, n, entry }) => {
      if (!entry) return false;
      if ((p.name ?? '').toLowerCase().includes(q)) return true;
      if (n.emails.some((e) => e.value.toLowerCase().includes(q))) return true;
      if (qDigits && n.phones.some((ph) => ph.value.replace(/\D/g, '').includes(qDigits))) return true;
      return false;
    })
    .slice(0, 5)
    .map(({ p, entry }) => ({ p, entry: entry! }));
}

// Contacts-roster autocomplete backing the share/invite fields (household
// invite, calendar outside-share): the decrypted People records — same query
// key as the event-invitee picker, so the on-device decrypt is shared — run
// through `matchRoster` against the typed text. The source is the in-app
// roster, not the device address book; typing a raw email/phone for someone
// not on file still works in every caller.
export function useRosterSuggestions(query: string, taken: Set<string>, enabled = true): RosterSuggestion[] {
  const peopleQ = useQuery({
    queryKey: ['people', 'decrypted'],
    queryFn: async () => {
      const rows = (await peopleApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Person', p) as Promise<Person>));
    },
    enabled,
  });
  return useMemo(() => matchRoster(peopleQ.data ?? [], query, taken), [peopleQ.data, query, taken]);
}
