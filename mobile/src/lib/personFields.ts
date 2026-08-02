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
import { canonicalizePhoneForStorage } from './phone';

export interface LabeledValue {
  label: string;
  value: string;
}

// A related contact: a labeled name, optionally linked to another Person in the
// roster (personId) so the detail view can deep-link to their card.
// `reciprocalLabel` is the label to mirror onto the LINKED contact's card for a
// **custom** relationship whose inverse can't be derived automatically — e.g. a
// "daughter-in-law" link whose reciprocal the user sets to "father-in-law".
// Ignored for preset labels (their inverse is derived); see reciprocalLabelFor.
export interface RelatedName extends LabeledValue {
  personId?: string;
  reciprocalLabel?: string;
}

// Preset labels offered in the label picker per field type. Users can always add
// a custom label; "other" is the catch-all default preset.
export const PHONE_LABELS = ['mobile', 'home', 'work', 'main', 'other'];
export const EMAIL_LABELS = ['home', 'work', 'other'];
export const ADDRESS_LABELS = ['home', 'work', 'other'];
// Date labels double as occasion kinds. `birthday` is the first, default label
// (a new contact starts with a Birthday date row); 'anniversary' and 'death' are
// the other recognised kinds that surface on the Occasions calendar with their
// own styling. `anniversary` is the wedding label (there is no separate
// 'marriage' preset — the two were redundant; the engine still recognises a
// legacy 'marriage' label for pre-existing contacts). There is no 'other'
// catch-all preset — a date that isn't one of these kinds takes a **custom
// label** (the picker's "Add Custom Label"), which surfaces as a custom occasion
// under that label. The `birthday` row persists to the dedicated
// `Person.birthday` field (split out in the person form's save), not `dates[]`.
// See shared/calendar occasionKindFromLabel.
export const DATE_LABELS = ['birthday', 'anniversary', 'death'];
export const URL_LABELS = ['homepage', 'home', 'work', 'other'];
export const RELATED_LABELS = [
  'spouse', 'partner', 'mother', 'father', 'parent', 'brother', 'sister',
  'sibling', 'child', 'friend', 'assistant', 'manager', 'other',
];

// The label a freshly-added entry starts with (the first, most common preset).
export const DEFAULT_PHONE_LABEL = 'mobile';
export const DEFAULT_EMAIL_LABEL = 'home';
export const DEFAULT_ADDRESS_LABEL = 'home';
export const DEFAULT_DATE_LABEL = 'birthday';
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
      const reciprocalLabel = String((e as RelatedName)?.reciprocalLabel ?? '').trim();
      const out: RelatedName = { label, value };
      if (personId) out.personId = personId;
      if (reciprocalLabel) out.reciprocalLabel = reciprocalLabel;
      return out;
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

// Canonicalize every phone in a labeled list to the E.164 storage form the
// account phone uses, so a contact's number matches an account across formats
// (household/trip/calendar invites resolve by an exact match on the saved
// number). Implausible values pass through untouched. Exported so import paths
// that bypass denormalizeForSave (bulk import) can share the one rule.
export function canonicalizePhones(entries: LabeledValue[]): LabeledValue[] {
  return entries.map((e) => ({ ...e, value: canonicalizePhoneForStorage(e.value) }));
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
    // Phones are stored canonical E.164 (same format as the account phone).
    phones: list(canonicalizePhones(n.phones), DEFAULT_PHONE_LABEL),
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

// The label to put on the LINKED contact's mirror for a related name. A preset
// label has a derived inverse (`inverseRelatedLabel`); a **custom** label has no
// safe inverse, so the user's chosen `reciprocalLabel` is used when set (e.g.
// "daughter-in-law" → "father-in-law"), else it falls back to 'other'. Only the
// custom branch honours `reciprocalLabel`, so a stale value left over from a
// since-changed-to-preset label is ignored.
export function reciprocalLabelFor(entry: RelatedName): string {
  const known = INVERSE_RELATED_LABELS[entry.label.trim().toLowerCase()];
  if (known) return known;
  return entry.reciprocalLabel?.trim() || 'other';
}

// The back-link writes needed after saving a person: for each related name
// linked to a roster contact, the contact's new relatedNames array with the
// mirrored entry created/kept in sync. Behaviour:
//   • No back-link yet → add `{ inverse label, saver name, saver id }`.
//   • Back-link exists → keep it, but sync the mirror to the saver's edit:
//       - the mirrored NAME follows a rename of the saver (stale value → new);
//       - the mirrored LABEL follows a **relabel** — but only when the saver
//         actually changed their own label (detected against `prevEntries`, the
//         saver's previously-saved related names), so an independently-customized
//         label on the other card isn't clobbered on an unrelated save.
//   • Back-link's source entry was REMOVED (or unlinked to free text) since the
//     last save — a personId in `prevEntries` with no surviving entry — → strip
//     the mirror entries pointing back at the saver from that contact, so the
//     other card doesn't keep a one-sided relationship. (Whole-contact deletion
//     is still the separate relatedNameRemovalsOnDelete path.)
// Unlinked/free-text names, self-links, unknown ids, and empty values are
// skipped; one write per target (dedup).
export function reciprocalUpdates(
  self: { id: string; name: string },
  entries: RelatedName[],
  people: Person[],
  prevEntries: RelatedName[] = [],
): { person: Person; relatedNames: RelatedName[] }[] {
  const updates: { person: Person; relatedNames: RelatedName[] }[] = [];
  const done = new Set<string>();
  const norm = (s: string) => s.trim().toLowerCase();
  for (const entry of entries) {
    const targetId = entry.personId;
    if (!targetId || targetId === self.id || done.has(targetId) || !entry.value.trim()) continue;
    done.add(targetId);
    const person = people.find((p) => p._id === targetId);
    if (!person) continue;
    const existing = normalizePerson(person).relatedNames;
    const backIdx = existing.findIndex((e) => e.personId === self.id);
    // The mirror's label: a preset's derived inverse, or the user-chosen
    // reciprocal label for a custom relationship (father-in-law ↔ daughter-in-law).
    const desiredLabel = reciprocalLabelFor(entry);
    // When the relationship is custom, carry the saver's own label back as the
    // mirror's `reciprocalLabel` so the OTHER card is self-consistent (its own
    // reciprocal control shows this contact's real label, not a bare 'other').
    const entryIsCustom = !INVERSE_RELATED_LABELS[norm(entry.label)];
    const mirrorReciprocal = entryIsCustom && entry.reciprocalLabel?.trim() ? entry.label.trim() : undefined;
    if (backIdx >= 0) {
      const cur = existing[backIdx];
      // The saver changed the mirror label they want for this link (their own
      // preset label, or the custom reciprocal label) → propagate it. Otherwise
      // leave the (possibly independently-customized) mirror label alone.
      const prev = prevEntries.find((e) => e.personId === targetId);
      const labelChangedBySaver = !!prev && norm(reciprocalLabelFor(prev)) !== norm(desiredLabel);
      const nextLabel = labelChangedBySaver ? desiredLabel : cur.label;
      const nextReciprocal = labelChangedBySaver ? mirrorReciprocal : cur.reciprocalLabel;
      if (cur.value !== self.name || nextLabel !== cur.label || (nextReciprocal ?? '') !== (cur.reciprocalLabel ?? '')) {
        const updated: RelatedName = { label: nextLabel, value: self.name, personId: self.id };
        if (nextReciprocal) updated.reciprocalLabel = nextReciprocal;
        updates.push({ person, relatedNames: existing.map((e, i) => (i === backIdx ? updated : e)) });
      }
      continue;
    }
    const mirror: RelatedName = { label: desiredLabel, value: self.name, personId: self.id };
    if (mirrorReciprocal) mirror.reciprocalLabel = mirrorReciprocal;
    updates.push({ person, relatedNames: [...existing, mirror] });
  }
  // Links present at the last save but gone now (row deleted, or unlinked by
  // typing over it) → strip the back-link from the formerly-linked contact.
  const keptIds = new Set(entries.map((e) => e.personId).filter(Boolean));
  for (const prev of prevEntries) {
    const targetId = prev.personId;
    if (!targetId || targetId === self.id || keptIds.has(targetId) || done.has(targetId)) continue;
    done.add(targetId);
    const person = people.find((p) => p._id === targetId);
    if (!person) continue;
    const existing = normalizePerson(person).relatedNames;
    const filtered = existing.filter((e) => e.personId !== self.id);
    if (filtered.length !== existing.length) updates.push({ person, relatedNames: filtered });
  }
  return updates;
}

// When a contact is deleted, every OTHER contact that linked a related name to
// it (`personId === deletedId`) is left pointing at a ghost — so clear those
// entries. Returns the back-link writes needed: for each affected contact, its
// related-names array with the dangling entries removed. Client-side (contacts
// are sealed), best-effort, and only touches contacts that actually referenced
// the deleted id.
export function relatedNameRemovalsOnDelete(
  deletedId: string,
  people: Person[],
): { person: Person; relatedNames: RelatedName[] }[] {
  const updates: { person: Person; relatedNames: RelatedName[] }[] = [];
  for (const person of people) {
    if (person._id === deletedId) continue;
    const existing = normalizePerson(person).relatedNames;
    const filtered = existing.filter((e) => e.personId !== deletedId);
    if (filtered.length !== existing.length) updates.push({ person, relatedNames: filtered });
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

// ── "Already imported" matching for the device-contact picker ────────────────

// The identity of a device address-book contact as ContactImportScreen maps it.
export interface DeviceContactIdentity {
  key: string; // device contact id
  name: string;
  phones?: LabeledValue[];
  emails?: LabeledValue[];
}

const nameKey = (s: string | undefined | null) =>
  String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// Match device contacts against the roster to flag re-imports. The stored
// `deviceContactId` link is the primary signal, but many people in the roster
// have none — contacts imported before the link existed, imported on another
// device, or added by hand — so fall back to identity: a shared phone (both
// sides canonicalized to E.164; stored numbers predating canonicalization are
// free-form), a shared email (case-insensitive), or the exact full name. A
// name-only match can in principle flag a same-named stranger, but for this
// picker that trade is right: the flag only badges the row / gates the
// duplicate-confirm dialog, never blocks an import.
export function buildImportedMatcher(people: Person[]): (c: DeviceContactIdentity) => boolean {
  const ids = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  const names = new Set<string>();
  for (const p of people) {
    if (p.deviceContactId) ids.add(p.deviceContactId);
    const n = normalizePerson(p);
    for (const { value } of canonicalizePhones(n.phones)) if (value) phones.add(value);
    for (const { value } of n.emails) if (value.trim()) emails.add(value.trim().toLowerCase());
    const nm = nameKey(p.name);
    if (nm) names.add(nm);
  }
  return (c) =>
    ids.has(c.key) ||
    (c.phones ?? []).some((e) => phones.has(canonicalizePhoneForStorage(e.value))) ||
    (c.emails ?? []).some((e) => emails.has(e.value.trim().toLowerCase())) ||
    names.has(nameKey(c.name));
}
