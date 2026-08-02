jest.mock('../../lib/e2ee', () => ({ openRecord: jest.fn() }));

import { matchRoster } from '../useRosterSuggestions';
import type { Person } from '../../api';

// The pure matcher behind the share/invite autocomplete (household invite +
// calendar outside-share). Phone fixtures are "+"-prefixed so canonicalization
// is device-country-independent in this environment.

const person = (over: Partial<Person>): Person => ({
  _id: over._id ?? 'p1',
  name: over.name ?? 'Someone',
  type: 'friend',
  ...over,
});

const ANA = person({
  _id: 'ana',
  name: 'Ana Silva',
  emails: [{ label: 'home', value: 'Ana@Example.com' }],
  phones: [{ label: 'mobile', value: '+1 (555) 123-4567' }],
});
const PHONE_ONLY = person({
  _id: 'bo',
  name: 'Bo Chen',
  phones: [{ label: 'mobile', value: '+15559876543' }],
});
const NO_CONTACT = person({ _id: 'cal', name: 'Cal Empty' });

const none = new Set<string>();

describe('matchRoster', () => {
  it('returns nothing for an empty query', () => {
    expect(matchRoster([ANA], '', none)).toEqual([]);
    expect(matchRoster([ANA], '   ', none)).toEqual([]);
  });

  it('matches by name and resolves to the primary email, lowercased', () => {
    const hits = matchRoster([ANA, PHONE_ONLY], 'ana', none);
    expect(hits).toHaveLength(1);
    expect(hits[0].p._id).toBe('ana');
    expect(hits[0].entry).toEqual({ email: 'ana@example.com' });
  });

  it('resolves an email-less contact to their canonical E.164 phone', () => {
    const hits = matchRoster([PHONE_ONLY], 'bo', none);
    expect(hits[0].entry).toEqual({ phone: '+15559876543' });
  });

  it('matches by phone digits regardless of typed formatting', () => {
    const hits = matchRoster([ANA, PHONE_ONLY], '555-987', none);
    expect(hits).toHaveLength(1);
    expect(hits[0].p._id).toBe('bo');
  });

  it('falls back to the phone when the email is taken, and drops fully-taken contacts', () => {
    const emailTaken = new Set(['ana@example.com']);
    expect(matchRoster([ANA], 'ana', emailTaken)[0].entry).toEqual({ phone: '+15551234567' });
    const allTaken = new Set(['ana@example.com', '+15551234567']);
    expect(matchRoster([ANA], 'ana', allTaken)).toEqual([]);
  });

  it('drops contacts with nothing contactable and caps results at 5', () => {
    expect(matchRoster([NO_CONTACT], 'cal', none)).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) =>
      person({ _id: `p${i}`, name: `Match ${i}`, emails: [{ label: 'home', value: `m${i}@x.com` }] }),
    );
    expect(matchRoster(many, 'match', none)).toHaveLength(5);
  });

  it('reads legacy single-value fields via the read-time fold', () => {
    const legacy = person({ _id: 'leg', name: 'Lee Legacy', email: 'LEE@x.com' });
    expect(matchRoster([legacy], 'lee', none)[0].entry).toEqual({ email: 'lee@x.com' });
  });
});
