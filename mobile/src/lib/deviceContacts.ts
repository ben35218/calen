// Write a Calen contact into the device's (Apple/Android) address book.
//
// Calen contacts are end-to-end encrypted, but the E2EE boundary is the network
// — writing decrypted contact data to the user's OWN device, on their explicit
// request, is outside it by design (see specs/features/contacts-contacts.md's
// Encryption boundary section). This is the WRITE counterpart to
// ContactImportScreen's read-only import; both use expo-contacts' /legacy API
// (v56 deprecated the same functions on the package root).
import * as Contacts from 'expo-contacts/legacy';
import type { LabeledValue } from './contactFields';

// Thrown when the user hasn't granted (write) contacts permission, so callers
// can show a Settings nudge instead of a generic failure.
export class ContactsPermissionError extends Error {
  constructor() {
    super('Contacts permission not granted');
    this.name = 'ContactsPermissionError';
  }
}

export interface DeviceContactInput {
  name: string;
  firstName?: string;
  lastName?: string;
  // 'service' → a Company card; everything else → a Contact card.
  type?: string;
  company?: string;
  jobTitle?: string;
  birthday?: string; // YYYY-MM-DD
  phones?: LabeledValue[];
  emails?: LabeledValue[];
  addresses?: LabeledValue[];
  urls?: LabeledValue[];
}

// Build an expo-contacts Contact from a Calen contact and add it to the device
// address book, returning the new device contact id. Requests write permission
// first (throws ContactsPermissionError if denied).
export async function addContactToDeviceContacts(input: DeviceContactInput): Promise<string> {
  const perm = await Contacts.requestPermissionsAsync();
  if (perm.status !== 'granted') throw new ContactsPermissionError();

  const nonEmpty = (list?: LabeledValue[]) => (list ?? []).filter((e) => e.value.trim());
  const [y, m, d] = String(input.birthday ?? '')
    .split('-')
    .map((s) => parseInt(s, 10));
  // expo-contacts wants a Gregorian { day, month(0-based), year }; the typings
  // say Date, but the native module accepts the object form (same shape the read
  // path returns).
  const birthday = input.birthday && y && m && d ? { day: d, month: m - 1, year: y } : undefined;

  const contact: Contacts.Contact = {
    contactType: input.type === 'service' ? Contacts.ContactTypes.Company : Contacts.ContactTypes.Person,
    name: input.name,
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    company: input.company?.trim() || undefined,
    jobTitle: input.jobTitle?.trim() || undefined,
    phoneNumbers: nonEmpty(input.phones).map((p) => ({ label: p.label, number: p.value })),
    emails: nonEmpty(input.emails).map((e) => ({ label: e.label, email: e.value })),
    addresses: nonEmpty(input.addresses).map((a) => ({ label: a.label, street: a.value })),
    urlAddresses: nonEmpty(input.urls).map((u) => ({ label: u.label, url: u.value })),
    ...(birthday ? { birthday: birthday as any } : {}),
  };
  return Contacts.addContactAsync(contact);
}
