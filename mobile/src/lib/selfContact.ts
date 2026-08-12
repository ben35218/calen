// One-time client-side seed of the signed-in user's "You" Contact.
//
// Under mandatory E2EE the server can no longer create readable content, so
// Contact.ensureSelf no-ops once the household is e2eeActive and hands the job to
// the client (the P1 ensureSelf pattern — same as ensureDefaultCategories). The
// self-record's `type` + `accountId` are E2EE content in the opaque store (the
// Record model keeps no content columns), so they MUST be sealed via the shared
// CONTACT_ENC subset — otherwise the roster can't recognise the card as "You".
//
// Seeding runs at app boot (see hooks/useSelfContactSeed) so every contact-
// assignment UI (chores, events, …) has at least "You" to pick — NOT only after
// the user happens to open the Contacts screen.

import { contactsApi, householdApi, Contact } from '../api';
import { getHDK, openRecord, sealNew } from './e2ee';
import { CONTACT_ENC } from './encSubsets';

type SelfUser = { _id?: string; firstName?: string; lastName?: string } | null | undefined;

let seededThisSession = false;

// Create the "You" Contact when the household is E2EE-active, the key is held, and
// no self-record exists yet. Returns true when it created one (so the caller can
// invalidate the contacts cache). No-ops after the first successful run in a
// session and whenever a self-record already exists; safe to call from anywhere.
export async function ensureSelfContact(user: SelfUser): Promise<boolean> {
  if (seededThisSession || !getHDK() || !user?._id) return false;
  const selfId = String(user._id);
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.firstName || '';
  if (!name) return false;
  try {
    const { data: hh } = await householdApi.get();
    if (!hh?.e2eeActive) return false;
    const rows = (await contactsApi.list()).data;
    const contacts = await Promise.all(rows.map((p) => openRecord('Contact', p)));
    if (contacts.some((p: Contact) => p.accountId && String(p.accountId) === selfId)) {
      seededThisSession = true;
      return false;
    }
    seededThisSession = true; // guard against concurrent double-seeds
    const payload = { type: 'family', name, accountId: selfId, address: hh.homeAddress || undefined };
    await contactsApi.createSelf(await sealNew('Contact', payload, CONTACT_ENC(payload)));
    return true;
  } catch {
    return false; // offline/locked — retried next session
  }
}
