import {
  inverseRelatedLabel, reciprocalUpdates, RelatedName,
  splitName, composeName, normalizePerson, denormalizeForSave, NormalizedPerson,
} from '../personFields';
import type { Person } from '../../api';

const person = (p: Partial<Person> & { _id: string; name: string }) => p as Person;

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

describe('normalizePerson structured names', () => {
  it('trusts stored firstName/lastName when present', () => {
    const n = normalizePerson(person({ _id: 'x', name: 'Robert Smith', firstName: 'Bob', lastName: 'Smith' } as any));
    expect([n.firstName, n.lastName]).toEqual(['Bob', 'Smith']);
  });

  it('splits the legacy name when structured fields are absent', () => {
    const n = normalizePerson(person({ _id: 'x', name: 'Mary Anne Smith' }));
    expect([n.firstName, n.lastName]).toEqual(['Mary', 'Anne Smith']);
  });

  it('keeps a first-name-only stored value without re-splitting the display name', () => {
    const n = normalizePerson(person({ _id: 'x', name: 'Cher', firstName: 'Cher', lastName: '' } as any));
    expect([n.firstName, n.lastName]).toEqual(['Cher', '']);
  });
});

describe('denormalizeForSave structured names', () => {
  const base: NormalizedPerson = {
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

describe('reciprocalUpdates', () => {
  const self = { id: 'a', name: 'Alice' };

  it('adds an inverse-labeled back-link to a linked contact', () => {
    const bob = person({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', personId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates).toHaveLength(1);
    expect(updates[0].person).toBe(bob);
    expect(updates[0].relatedNames).toEqual([{ label: 'child', value: 'Alice', personId: 'a' }]);
  });

  it('appends to the contact existing related names', () => {
    const bob = person({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'friend', value: 'Carol', personId: 'c' }],
    } as any);
    const entries: RelatedName[] = [{ label: 'spouse', value: 'Bob', personId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates[0].relatedNames).toEqual([
      { label: 'friend', value: 'Carol', personId: 'c' },
      { label: 'spouse', value: 'Alice', personId: 'a' },
    ]);
  });

  it('skips contacts that already link back (add-only, never relabels)', () => {
    const bob = person({
      _id: 'b',
      name: 'Bob',
      relatedNames: [{ label: 'daughter', value: 'Alice', personId: 'a' }],
    } as any);
    const entries: RelatedName[] = [{ label: 'mother', value: 'Bob', personId: 'b' }];
    expect(reciprocalUpdates(self, entries, [bob])).toEqual([]);
  });

  it('skips unlinked entries, unknown ids, self-links, empty values, and dedups per contact', () => {
    const bob = person({ _id: 'b', name: 'Bob' });
    const entries: RelatedName[] = [
      { label: 'friend', value: 'Loose Name' }, // no personId
      { label: 'spouse', value: 'Gone', personId: 'ghost' }, // not in roster
      { label: 'spouse', value: 'Alice', personId: 'a' }, // self
      { label: 'brother', value: '  ', personId: 'b' }, // empty value
      { label: 'brother', value: 'Bob', personId: 'b' },
      { label: 'friend', value: 'Bob', personId: 'b' }, // duplicate target
    ];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates).toHaveLength(1);
    expect(updates[0].relatedNames).toEqual([{ label: 'sibling', value: 'Alice', personId: 'a' }]);
  });

  it('folds nothing extra in for contacts whose related names are legacy/absent', () => {
    const bob = person({ _id: 'b', name: 'Bob', phone: '555' } as any);
    const entries: RelatedName[] = [{ label: 'partner', value: 'Bob', personId: 'b' }];
    const updates = reciprocalUpdates(self, entries, [bob]);
    expect(updates[0].relatedNames).toEqual([{ label: 'partner', value: 'Alice', personId: 'a' }]);
  });
});
