// Multi-value contact fields (Apple-Contacts-style) — the shared vocabulary and
// the legacy⇄array migration used by the person form, detail view, and roster.
//
// A Person used to hold exactly one phone/email/address; it now holds labeled
// ARRAYS (phones/emails/addresses/dates/urls/relatedNames) plus jobTitle +
// company. Because contact records are end-to-end encrypted, the server can't
// migrate old rows — so we upgrade them on READ (`normalizePerson`, folding the
// legacy scalars into single-entry arrays) and, on the next save, write the new
// arrays while clearing the legacy scalars (`denormalizeForSave`). Records that
// are never re-edited still render correctly via the read-time fold.
import type { Person } from '../api';

export interface LabeledValue {
  label: string;
  value: string;
}

// A related contact: a labeled name, optionally linked to another Person in the
// roster (personId) so the detail view can deep-link to their card.
export interface RelatedName extends LabeledValue {
  personId?: string;
}

// Preset labels offered in the label picker per field type. Users can always add
// a custom label; "other" is the catch-all default preset.
export const PHONE_LABELS = ['mobile', 'home', 'work', 'main', 'other'];
export const EMAIL_LABELS = ['home', 'work', 'other'];
export const ADDRESS_LABELS = ['home', 'work', 'other'];
// Date labels double as occasion kinds: 'anniversary', 'marriage', and 'death'
// are recognised kinds that surface on the Occasions calendar with their own
// styling; any other (custom) label surfaces as a custom occasion under that
// label. See shared/calendar occasionKindFromLabel.
export const DATE_LABELS = ['anniversary', 'marriage', 'death', 'other'];
export const URL_LABELS = ['homepage', 'home', 'work', 'other'];
export const RELATED_LABELS = [
  'spouse', 'partner', 'mother', 'father', 'parent', 'brother', 'sister',
  'sibling', 'child', 'friend', 'assistant', 'manager', 'other',
];

// The label a freshly-added entry starts with (the first, most common preset).
export const DEFAULT_PHONE_LABEL = 'mobile';
export const DEFAULT_EMAIL_LABEL = 'home';
export const DEFAULT_ADDRESS_LABEL = 'home';
export const DEFAULT_DATE_LABEL = 'anniversary';
export const DEFAULT_URL_LABEL = 'homepage';
export const DEFAULT_RELATED_LABEL = 'spouse';

// ── Structured names (Apple-Contacts First / Last) ───────────────────────────
// A Person's `name` stays the canonical, composed display name (used by the
// roster, sorting, e-cards, related-name mirrors, initials, …). `firstName` /
// `lastName` are the structured components the form edits; `name` is recomposed
// from them on save. Legacy records hold only `name`, so we split it for the
// form on read — first token → first name, the rest → last name.
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function composeName(firstName: string, lastName: string): string {
  return [firstName, lastName].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
}

// The decrypted Person projected into the multi-value shape the form/detail work
// with. Every array is present (possibly empty); scalars default to ''.
export interface NormalizedPerson {
  // Structured name components — from the stored fields when present, else
  // split from the legacy `name` (see splitName).
  firstName: string;
  lastName: string;
  phones: LabeledValue[];
  emails: LabeledValue[];
  addresses: LabeledValue[];
  dates: LabeledValue[]; // value is YYYY-MM-DD
  urls: LabeledValue[];
  relatedNames: RelatedName[];
  jobTitle: string;
  company: string;
}

function cleanList(list: unknown, fallbackLabel: string): LabeledValue[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => {
      const value = String((e as LabeledValue)?.value ?? '').trim();
      const label = String((e as LabeledValue)?.label ?? '').trim() || fallbackLabel;
      const personId = (e as RelatedName)?.personId;
      return personId ? { label, value, personId } : { label, value };
    })
    .filter((e) => e.value);
}

// Fold a decrypted Person into the multi-value shape, upgrading legacy single
// phone/email/address/businessName fields into their array equivalents so old
// records (never re-saved since the multi-value cutover) still display.
export function normalizePerson(p: Person): NormalizedPerson {
  const legacy = (arr: unknown, single: unknown, label: string): LabeledValue[] => {
    const list = cleanList(arr, label);
    if (list.length) return list;
    const v = String(single ?? '').trim();
    return v ? [{ label, value: v }] : [];
  };
  // Trust the stored structured name when either component is present; else
  // derive both from the legacy composed `name` so old records pre-fill sensibly.
  const storedFirst = String((p as any).firstName ?? '').trim();
  const storedLast = String((p as any).lastName ?? '').trim();
  const derived = storedFirst || storedLast ? { firstName: storedFirst, lastName: storedLast } : splitName(String(p.name ?? ''));
  return {
    firstName: derived.firstName,
    lastName: derived.lastName,
    phones: legacy((p as any).phones, p.phone, DEFAULT_PHONE_LABEL),
    emails: legacy((p as any).emails, p.email, DEFAULT_EMAIL_LABEL),
    addresses: legacy((p as any).addresses, p.address, DEFAULT_ADDRESS_LABEL),
    dates: cleanList((p as any).dates, DEFAULT_DATE_LABEL),
    urls: cleanList((p as any).urls, DEFAULT_URL_LABEL),
    relatedNames: cleanList((p as any).relatedNames, DEFAULT_RELATED_LABEL) as RelatedName[],
    jobTitle: String((p as any).jobTitle ?? '').trim(),
    company: String(p.company ?? p.businessName ?? '').trim(),
  };
}

// Build the persisted payload from the edited multi-value shape: emit trimmed
// arrays (undefined when empty) and clear the legacy scalars so re-saving an old
// record drops the duplicated single values from the sealed blob.
export function denormalizeForSave(n: NormalizedPerson): Record<string, unknown> {
  const list = (arr: LabeledValue[], fallback: string) => {
    const clean = cleanList(arr, fallback);
    return clean.length ? clean : undefined;
  };
  return {
    // Structured name components; `name` itself is composed by the caller (the
    // form knows whether it's a personal vs. single-field/service contact).
    firstName: n.firstName.trim() || undefined,
    lastName: n.lastName.trim() || undefined,
    phones: list(n.phones, DEFAULT_PHONE_LABEL),
    emails: list(n.emails, DEFAULT_EMAIL_LABEL),
    addresses: list(n.addresses, DEFAULT_ADDRESS_LABEL),
    dates: list(n.dates, DEFAULT_DATE_LABEL),
    urls: list(n.urls, DEFAULT_URL_LABEL),
    relatedNames: list(n.relatedNames, DEFAULT_RELATED_LABEL),
    jobTitle: n.jobTitle.trim() || undefined,
    company: n.company.trim() || undefined,
    // Legacy single fields are superseded by the arrays above; clear them so the
    // sealed record carries one source of truth.
    phone: undefined,
    email: undefined,
    address: undefined,
    businessName: undefined,
  };
}

// ── Reciprocal related names ─────────────────────────────────────────────────
// Linking a related name to a roster contact mirrors the connection onto that
// contact with the inverse label (spouse↔spouse, mother→child, child→parent…).
// Contacts are sealed, so this runs client-side at save time — the server never
// sees relationship data. Gendered inverses collapse to the neutral term
// (brother→sibling, mother→child) because the other card's gender is unknown.
const INVERSE_RELATED_LABELS: Record<string, string> = {
  spouse: 'spouse', husband: 'spouse', wife: 'spouse',
  partner: 'partner',
  friend: 'friend',
  mother: 'child', father: 'child', parent: 'child', mom: 'child', dad: 'child',
  child: 'parent', son: 'parent', daughter: 'parent',
  brother: 'sibling', sister: 'sibling', sibling: 'sibling',
  grandmother: 'grandchild', grandfather: 'grandchild', grandparent: 'grandchild',
  grandchild: 'grandparent', grandson: 'grandparent', granddaughter: 'grandparent',
  assistant: 'manager', manager: 'assistant',
};

// The label the mirrored entry gets. Unknown/custom labels (e.g. "uncle") have
// no safe inverse, so they fall back to the 'other' catch-all.
export function inverseRelatedLabel(label: string): string {
  return INVERSE_RELATED_LABELS[label.trim().toLowerCase()] ?? 'other';
}

// The back-link writes needed after saving a person: for each related name
// linked to a roster contact that doesn't already point back at the saved
// person, the contact's new relatedNames array including the mirrored entry.
// Add-only: existing back-links are never relabeled (the user may have
// customized them) and removing a related name never cascades a removal.
export function reciprocalUpdates(
  self: { id: string; name: string },
  entries: RelatedName[],
  people: Person[],
): { person: Person; relatedNames: RelatedName[] }[] {
  const updates: { person: Person; relatedNames: RelatedName[] }[] = [];
  const done = new Set<string>();
  for (const entry of entries) {
    const targetId = entry.personId;
    if (!targetId || targetId === self.id || done.has(targetId) || !entry.value.trim()) continue;
    done.add(targetId);
    const person = people.find((p) => p._id === targetId);
    if (!person) continue;
    const existing = normalizePerson(person).relatedNames;
    if (existing.some((e) => e.personId === self.id)) continue;
    updates.push({
      person,
      relatedNames: [
        ...existing,
        { label: inverseRelatedLabel(entry.label), value: self.name, personId: self.id },
      ],
    });
  }
  return updates;
}

// The first phone/email — used for the roster and the detail quick-action
// buttons, which act on a single "primary" value.
export function primaryPhone(p: Person): string | undefined {
  return normalizePerson(p).phones[0]?.value;
}
export function primaryEmail(p: Person): string | undefined {
  return normalizePerson(p).emails[0]?.value;
}
