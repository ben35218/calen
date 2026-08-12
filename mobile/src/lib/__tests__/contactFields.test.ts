import {
  inverseRelatedLabel, reciprocalLabelFor, reciprocalUpdates, relatedNameRemovalsOnDelete, RelatedName,
  splitName, composeName, normalizeContact, denormalizeForSave, canonicalizePhones, NormalizedContact,
  DATE_LABELS, DEFAULT_DATE_LABEL, buildImportedMatcher,
} from '../contactFields';
import type { Contact } from '../../api';

const contact = (p: Partial<Contact> & { _id: string; name: string }) => p as Contact;

describe('date labels', () => {
  it('leads with birthday (the default) then the recognised kinds — no "other" catch-all', () => {
    // Birthday is first + default (a new contact starts with a Birthday date row);
    // a non-kind date uses a custom label (picker "Add Custom Label").
    expect(DATE_LABELS).toEqual(['birthday', 'anniversary', 'death']);
    expect(DATE_LABELS[0]).toBe('birthday');
    expect(DATE_LABELS).not.toContain('other');
    // `anniversary` is the sole wedding label; `marriage` was dropped as a
    // redundant preset (still recognised by the engine for legacy contacts).
    expect(DATE_LABELS).not.toContain('marriage');
    expect(DEFAULT_DATE_LABEL).toBe('birthday');
  });
});

describe('splitName / composeName', () => {
  it('splits a composed name into first token + remaining surname', () => {
    expect(splitName('Sarah Smith')).toEqual({ firstName: 'Sarah', lastName: 'Smith' });
    expect(splitName('Mary Anne Van Der Berg')).toEqual({ firstName: 'Mary', lastName: 'Anne Van Der Berg' });
    expect(splitName('Dad')).toEqual({ firstName: 'Dad', lastName: '' });
    expect(splitName('  Cher  ')).toEqual({ firstName: 'Cher', lastName: '' });
    expect(splitName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('composes a display name, trimming and dropping empty parts', () => {
    expect(composeName('Sarah', 'Smith')).toBe('Sarah Smith');
    expect(composeName('Dad', '')).toBe('Dad');
    expect(composeName('', 'Smith')).toBe('Smith');
    expect(composeName('  Sarah ', ' Smith ')).toBe('Sarah Smith');
    expect(composeName('', '')).toBe('');
  });

  it('round-trips a stored first/last through compose', () => {
    expect(composeName('Sarah', 'Smith')).toBe('Sarah Smith');
    expect(splitName(composeName('Sarah', 'Smith'))).toEqual({ firstName: 'Sarah', lastName: 'Smith' });
  });
});

describe('normalizeContact structured names', () => {
  it('trusts stored firstName/lastName when present', () => {
    const n = normalizeContact(contact({ _id: 'x', name: 'Robert Smith', firstName: 'Bob', lastName: 'Smith' } as any));
    expect([n.firstName, n.lastName]).toEqual(['Bob', 'Smith']);
  });

  it('splits the legacy name when structured fields are absent', () => {
    const n = normalizeContact(contact({ _id: 'x', name: 'Mary Anne Smith' }));
    expect([n.firstName, n.lastName]).toEqual(['Mary', 'Anne Smith']);
  });

  it('keeps a first-name-only stored value without re-splitting the display name', () => {
    const n = normalizeContact(contact({ _id: 'x', name: 'Cher', firstName: 'Cher', lastName: '' } as any));
    expect([n.firstName, n.lastName]).toEqual(['Cher', '']);
  });
});

describe('denormalizeForSave structured names', () => {
  const base: NormalizedContact = {
    firstName: '', lastName: '', phones: [], emails: [], addresses: [],
    dates: [], urls: [], relatedNames: [], jobTitle: '', company: '',
  };

  it('emits trimmed first/last, undefined when blank', () => {
    expect(denormalizeForSave({ ...base, firstName: ' Sarah ', lastName: ' Smith ' }))
      .toMatchObject({ firstName: 'Sarah', lastName: 'Smith' });
    const out = denormalizeForSave(base);
    expect(out.firstName).toBeUndefined();
    expect(out.lastName).toBeUndefined();
  });

  it('stores phones in canonical E.164 (same format as the account phone)', () => {
    // Device country is US under jest, so a national number gains +1 — matching
    // what the account PhoneField persists.
    const out = denormalizeForSave({
      ...base,
      phones: [
        { label: 'mobile', value: '(604) 555-1212' },
        { label: 'work', value: '+1 604-555-3434' },
      ],
    });
    expect(out.phones).toEqual([
      { label: 'mobile', value: '+16045551212' },
      { label: 'work', value: '+16045553434' },
    ]);
  });
});

describe('canonicalizePhones', () => {
  it('canonicalizes plausible numbers and leaves junk untouched', () => {
    expect(canonicalizePhones([
      { label: 'mobile', value: '604-555-1212' },
      { label: 'other', value: 'ext. 12' },
    ])).toEqual([
      { label: 'mobile', value: '+16045551212' },
      { label: 'other', value: 'ext. 12' },
    ]);
  });
});

describe('inverseRelatedLabel', () => {
  it('mirrors symmetric labels onto themselves', () => {
    expect(inverseRelatedLabel('spouse')).toBe('spouse');
    expect(inverseRelatedLabel('partner')).toBe('partner');
    expect(inverseRelatedLabel('friend')).toBe('friend');
    expect(inverseRelatedLabel('sibling')).toBe('sibling');
  });

  it('collapses gendered labels to the neutral inverse', () => {
    expect(inverseRelatedLabel('mother')).toBe('child');
    expect(inverseRelatedLabel('father')).toBe('child');
    expect(inverseRelatedLabel('parent')).toBe('child');
    expect(inverseRelatedLabel('child')).toBe('parent');
    expect(inverseRelatedLabel('son')).toBe('parent');
    expect(inverseRelatedLabel('daughter')).toBe('parent');
    expect(inverseRelatedLabel('brother')).toBe('sibling');
    expect(inverseRelatedLabel('sister')).toBe('sibling');
    expect(inverseRelatedLabel('grandmother')).toBe('grandchild');
    expect(inverseRelatedLabel('grandchild')).toBe('grandparent');
  });

  it('pairs assistant and manager', () => {
    expect(inverseRelatedLabel('assistant')).toBe('manager');
    expect(inverseRelatedLabel('manager')).toBe('assistant');
  });

  it('is case/whitespace-insensitive and falls back to other for custom labels', () => {
    expect(inverseRelatedLabel(' Mother ')).toBe('child');
    expect(inverseRelatedLabel('uncle')).toBe('other');
    expect(inverseRelatedLabel('other')).toBe('other');
    expect(inverseRelatedLabel('')).toBe('other');
  });
});

describe('relatedNames reciprocalLabel round-trip', () => {
  it('preserves contactId + reciprocalLabel through normalize and save', () => {
    const p = contact({
      _id: 'x',
      name: 'X',
      relatedNames: [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }],
    } as any);
    const n = normalizeContact(p);
    expect(n.relatedNames).toEqual([{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }]);
    const saved = denormalizeForSave({
      firstName: '', lastName: '', phones: [], emails: [], addresses: [],
      dates: [], urls: [], relatedNames: n.relatedNames, jobTitle: '', company: '',
    });
    expect(saved.relatedNames).toEqual([{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }]);
  });

  // Pre-rename records seal the link as `personId`. It lives inside the E2EE
  // blob, so the server can't rewrite it — without the read-time alias every
  // existing related-name link would silently unlink itself.
  it('reads a legacy personId link and re-saves it as contactId', () => {
    const p = contact({
      _id: 'x',
      name: 'X',
      relatedNames: [{ label: 'spouse', value: 'Bob', personId: 'b' }],
    } as any);
    const n = normalizeContact(p);
    expect(n.relatedNames).toEqual([{ label: 'spouse', value: 'Bob', contactId: 'b' }]);

    const saved = denormalizeForSave({
      firstName: '', lastName: '', phones: [], emails: [], addresses: [],
      dates: [], urls: [], relatedNames: n.relatedNames, jobTitle: '', company: '',
    });
    expect(saved.relatedNames).toEqual([{ label: 'spouse', value: 'Bob', contactId: 'b' }]);
  });

  // A row that somehow carries both keys must prefer the current one.
  it('prefers contactId when both keys are present', () => {
    const p = contact({
      _id: 'x',
      name: 'X',
      relatedNames: [{ label: 'spouse', value: 'Bob', contactId: 'new', personId: 'old' }],
    } as any);
    expect(normalizeContact(p).relatedNames[0].contactId).toBe('new');
  });
});

describe('reciprocalLabelFor', () => {
  it('derives a preset label inverse and ignores any stale reciprocalLabel on it', () => {
    expect(reciprocalLabelFor({ label: 'mother', value: 'x', reciprocalLabel: 'father-in-law' })).toBe('child');
    expect(reciprocalLabelFor({ label: 'spouse', value: 'x' })).toBe('spouse');
  });

  it('uses the chosen reciprocal label for a custom relationship, else other', () => {
    expect(reciprocalLabelFor({ label: 'daughter-in-law', value: 'x', reciprocalLabel: 'father-in-law' })).toBe('father-in-law');
    expect(reciprocalLabelFor({ label: 'daughter-in-law', value: 'x' })).toBe('other');
    expect(reciprocalLabelFor({ label: 'uncle', value: 'x', reciprocalLabel: '  ' })).toBe('other');
  });
});

describe('reciprocalUpdates', () => {
  const self = { id: 'a', name: 'Alice' };

  it('adds an inverse-labeled back-link to a linked contact', () => {
    const bob = contact({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates).toHaveLength(1);
    expect(updates[0].contact).toBe(bob);
    expect(updates[0].relatedNames).toEqual([{ label: 'child', value: 'Alice', contactId: 'a' }]);
  });

  it('appends to the contact existing related names', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'friend', value: 'Carol', contactId: 'c' }],
    } as any);
    const entries: RelatedName[] = [{ label: 'spouse', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates[0].relatedNames).toEqual([
      { label: 'friend', value: 'Carol', contactId: 'c' },
      { label: 'spouse', value: 'Alice', contactId: 'a' },
    ]);
  });

  it('skips contacts that already link back (add-only, never relabels)', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'daughter', value: 'Alice', contactId: 'a' }],
    } as any);
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    expect(reciprocalUpdates(self, entries, [bob])).toEqual([]);
  });

  it('skips unlinked entries, unknown ids, self-links, empty values, and dedups per contact', () => {
    const bob = contact({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [
      { label: 'friend', value: 'Loose Name' }, // no contactId
      { label: 'spouse', value: 'Gone', contactId: 'ghost' }, // not in roster
      { label: 'spouse', value: 'Alice', contactId: 'a' }, // self
      { label: 'brother', value: '  ', contactId: 'b' }, // empty value
      { label: 'brother', value: 'Bob', contactId: 'b' },
      { label: 'friend', value: 'Bob', contactId: 'b' }, // duplicate target
    ];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([{ label: 'sibling', value: 'Alice', contactId: 'a' }]);
  });

  it('folds nothing extra in for contacts whose related names are legacy/absent', () => {
    const bob = contact({ _id: 'b', name: 'Bob', phone: '555' } as any);
    const entries: RelatedName[] = [{ label: 'partner', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates[0].relatedNames).toEqual([{ label: 'partner', value: 'Alice', contactId: 'a' }]);
  });

  it('refreshes a stale mirrored name on the linked contact when the saver renamed (keeps the label)', () => {
    // Bob's back-link still holds the saver's OLD name ("Alice"); the saver now
    // goes by "Alicia". The mirror updates the value, leaving the (customized)
    // label alone — and never touches an unrelated entry.
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [
        { label: 'friend', value: 'Carol', contactId: 'c' },
        { label: 'daughter', value: 'Alice', contactId: 'a' },
      ],
    } as any);
    const renamed = { id: 'a', name: 'Alicia' };
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(renamed, entries, [bob]);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([
      { label: 'friend', value: 'Carol', contactId: 'c' },
      { label: 'daughter', value: 'Alicia', contactId: 'a' },
    ]);
  });

  it('emits no back-link write when the mirrored name is already current', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'daughter', value: 'Alice', contactId: 'a' }],
    } as any);
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    expect(reciprocalUpdates(self, entries, [bob])).toEqual([]);
  });

  it('propagates a relabel (spouse → partner) onto the linked contact mirror', () => {
    // Alan (self) has Kyra as spouse and now relabels her to partner; Kyra's
    // back-link (spouse → Alan) must follow to partner. Detected via prevEntries.
    const kyra = contact({
      _id: 'k',
      name: 'Kyra',
      relatedNames: [{ label: 'spouse', value: 'Alan', contactId: 'alan' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'spouse', value: 'Kyra', contactId: 'k' }];
    const entries: RelatedName[] = [{ label: 'partner', value: 'Kyra', contactId: 'k' }];
    const updates = reciprocalUpdates({ id: 'alan', name: 'Alan' }, entries, [kyra], prev);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([{ label: 'partner', value: 'Alan', contactId: 'alan' }]);
  });

  it('collapses a gendered relabel to the neutral inverse on the mirror', () => {
    const kyra = contact({
      _id: 'k',
      name: 'Kyra',
      relatedNames: [{ label: 'child', value: 'Alan', contactId: 'alan' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'mother', value: 'Kyra', contactId: 'k' }];
    const entries: RelatedName[] = [{ label: 'father', value: 'Kyra', contactId: 'k' }];
    const updates = reciprocalUpdates({ id: 'alan', name: 'Alan' }, entries, [kyra], prev);
    // mother→child and father→child are the same inverse, so no write is needed.
    expect(updates).toEqual([]);
  });

  it('mirrors a custom relationship using the saver-chosen reciprocal label', () => {
    // Alice links Bob as a custom "daughter-in-law" and sets the reciprocal to
    // "father-in-law"; Bob's card gets that exact label (not the 'other' fallback).
    const bob = contact({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [
      { label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' },
    ];
    const updates = reciprocalUpdates(self, entries, [bob]);
    // Mirror carries the inverse label AND the saver's own label as its reciprocal
    // so Bob's card is self-consistent.
    expect(updates[0].relatedNames).toEqual([
      { label: 'father-in-law', value: 'Alice', contactId: 'a', reciprocalLabel: 'daughter-in-law' },
    ]);
  });

  it('falls back to other for a custom relationship with no reciprocal chosen', () => {
    const bob = contact({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates[0].relatedNames).toEqual([{ label: 'other', value: 'Alice', contactId: 'a' }]);
  });

  it('propagates an edited custom reciprocal label onto the existing mirror', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'father-in-law', value: 'Alice', contactId: 'a' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }];
    const entries: RelatedName[] = [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'parent-in-law' }];
    const updates = reciprocalUpdates(self, entries, [bob], prev);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([
      { label: 'parent-in-law', value: 'Alice', contactId: 'a', reciprocalLabel: 'daughter-in-law' },
    ]);
  });

  it('renaming the saver refreshes the mirror value but keeps its custom label + reciprocal', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'father-in-law', value: 'Alice', contactId: 'a', reciprocalLabel: 'daughter-in-law' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }];
    const entries: RelatedName[] = [{ label: 'daughter-in-law', value: 'Bob', contactId: 'b', reciprocalLabel: 'father-in-law' }];
    const updates = reciprocalUpdates({ id: 'a', name: 'Alicia' }, entries, [bob], prev);
    expect(updates[0].relatedNames).toEqual([
      { label: 'father-in-law', value: 'Alicia', contactId: 'a', reciprocalLabel: 'daughter-in-law' },
    ]);
  });

  it('does NOT relabel an independently-customized mirror on an unrelated re-save', () => {
    // Bob's back-link is a customized "daughter"; Alice re-saves without changing
    // her own label (mother → mother), so the customization is preserved.
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'daughter', value: 'Alice', contactId: 'a' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    expect(reciprocalUpdates(self, entries, [bob], prev)).toEqual([]);
  });

  it('removing a linked related name strips the back-link from the other contact', () => {
    // Alice drops her link to Bob; Bob's card loses only the entry pointing back
    // at Alice, keeping his unrelated entries.
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [
        { label: 'friend', value: 'Carol', contactId: 'c' },
        { label: 'daughter', value: 'Alice', contactId: 'a' },
      ],
    } as any);
    const prev: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    const updates = reciprocalUpdates(self, [], [bob], prev);
    expect(updates).toHaveLength(1);
    expect(updates[0].contact).toBe(bob);
    expect(updates[0].relatedNames).toEqual([{ label: 'friend', value: 'Carol', contactId: 'c' }]);
  });

  it('unlinking (typing free text over a linked row) also strips the back-link', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'child', value: 'Alice', contactId: 'a' }],
    } as any);
    const prev: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bobby' }]; // no contactId
    const updates = reciprocalUpdates(self, entries, [bob], prev);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([]);
  });

  it('a kept link is a sync, not a removal — and removal skips ghosts and no-back-link contacts', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'child', value: 'Alice', contactId: 'a' }],
    } as any);
    const carol = contact({ _id: 'c', name: 'Carol' }); // never linked back
    const prev: RelatedName[] = [
      { label: 'mother', value: 'Bob', contactId: 'b' }, // kept below
      { label: 'friend', value: 'Carol', contactId: 'c' }, // removed, but no back-link on Carol
      { label: 'spouse', value: 'Gone', contactId: 'ghost' }, // removed, not in roster
    ];
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', contactId: 'b' }];
    expect(reciprocalUpdates(self, entries, [bob, carol], prev)).toEqual([]);
  });

  it('dedups removal writes when several prev rows linked the same contact', () => {
    const bob = contact({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'child', value: 'Alice', contactId: 'a' }],
    } as any);
    const prev: RelatedName[] = [
      { label: 'mother', value: 'Bob', contactId: 'b' },
      { label: 'friend', value: 'Bob', contactId: 'b' },
    ];
    const updates = reciprocalUpdates(self, [], [bob], prev);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([]);
  });
});

describe('relatedNameRemovalsOnDelete', () => {
  it('clears related-name entries that pointed at the deleted contact', () => {
    const alan = contact({
      _id: 'alan',
      name: 'Alan',
      relatedNames: [
        { label: 'partner', value: 'Kyra', contactId: 'k' },
        { label: 'friend', value: 'Carol', contactId: 'c' },
      ],
    } as any);
    const carol = contact({ _id: 'c', name: 'Carol' });
    const updates = relatedNameRemovalsOnDelete('k', [alan, carol]);
    expect(updates).toHaveLength(1);
    expect(updates[0].contact).toBe(alan);
    expect(updates[0].relatedNames).toEqual([{ label: 'friend', value: 'Carol', contactId: 'c' }]);
  });

  it('leaves contacts that never linked to the deleted one untouched', () => {
    const bob = contact({ _id: 'b', name: 'Bob', relatedNames: [{ label: 'friend', value: 'Carol', contactId: 'c' }] } as any);
    expect(relatedNameRemovalsOnDelete('k', [bob])).toEqual([]);
  });

  it('ignores free-text (unlinked) related names sharing a name', () => {
    const bob = contact({ _id: 'b', name: 'Bob', relatedNames: [{ label: 'friend', value: 'Kyra' }] } as any);
    expect(relatedNameRemovalsOnDelete('k', [bob])).toEqual([]);
  });
});

describe('buildImportedMatcher', () => {
  const row = (r: Partial<import('../contactFields').DeviceContactIdentity> & { key: string; name: string }) => r as any;

  it('matches by the stored deviceContactId link', () => {
    const match = buildImportedMatcher([contact({ _id: 'p1', name: 'Sarah Smith', deviceContactId: 'dev-1' } as any)]);
    expect(match(row({ key: 'dev-1', name: 'Renamed On Device' }))).toBe(true);
    expect(match(row({ key: 'dev-2', name: 'Someone Else' }))).toBe(false);
  });

  it('flags a pre-link import by phone, across storage formats', () => {
    // Imported before deviceContactId existed AND before E.164 canonicalization:
    // no link, free-form national number.
    const match = buildImportedMatcher([
      contact({ _id: 'p1', name: 'S. Smith', phones: [{ label: 'mobile', value: '(604) 555-1212' }] } as any),
    ]);
    // The picker canonicalizes device numbers to E.164 before matching.
    expect(match(row({ key: 'dev-9', name: 'Sarah Smith', phones: [{ label: 'mobile', value: '+16045551212' }] }))).toBe(true);
  });

  it('folds the legacy single phone field into the match set', () => {
    const match = buildImportedMatcher([contact({ _id: 'p1', name: 'S. Smith', phone: '604 555 1212' } as any)]);
    expect(match(row({ key: 'dev-9', name: 'Sarah Smith', phones: [{ label: 'mobile', value: '+16045551212' }] }))).toBe(true);
  });

  it('matches by email, case-insensitively', () => {
    const match = buildImportedMatcher([
      contact({ _id: 'p1', name: 'S. Smith', emails: [{ label: 'home', value: 'Sarah@Example.com' }] } as any),
    ]);
    expect(match(row({ key: 'dev-9', name: 'Sarah', emails: [{ label: 'work', value: 'sarah@example.com' }] }))).toBe(true);
    expect(match(row({ key: 'dev-9', name: 'Sarah', emails: [{ label: 'work', value: 'other@example.com' }] }))).toBe(false);
  });

  it('matches by exact full name (trimmed, case- and whitespace-insensitive) but never partially', () => {
    const match = buildImportedMatcher([contact({ _id: 'p1', name: '  Sarah   Smith ' } as any)]);
    expect(match(row({ key: 'dev-9', name: 'sarah smith' }))).toBe(true);
    expect(match(row({ key: 'dev-9', name: 'Sarah' }))).toBe(false);
    expect(match(row({ key: 'dev-9', name: 'Sarah Smithers' }))).toBe(false);
  });

  it('flags nothing when the roster is empty', () => {
    const match = buildImportedMatcher([]);
    expect(match(row({ key: 'dev-1', name: 'Anyone', phones: [{ label: 'mobile', value: '+16045551212' }] }))).toBe(false);
  });
});
