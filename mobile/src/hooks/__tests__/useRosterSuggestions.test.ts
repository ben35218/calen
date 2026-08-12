jest.mock('../../lib/e2ee', () => ({ openRecord: jest.fn() }));
// Reached transitively: invitees → inviteAlerts stores the prompted-once record.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { matchRoster } from '../useRosterSuggestions';
import type { Contact } from '../../api';

// The pure matcher behind the share/invite autocomplete (household invite +
// calendar outside-share). Phone fixtures are "+"-prefixed so canonicalization
// is device-country-independent in this environment.

const contact = (over: Partial<Contact>): Contact => ({
  _id: over._id ?? 'p1',
  name: over.name ?? 'Someone',
  type: 'friend',
  ...over,
});

const ANA = contact({
  _id: 'ana',
  name: 'Ana Silva',
  emails: [{ label: 'home', value: 'Ana@Example.com' }],
  phones: [{ label: 'mobile', value: '+1 (555) 123-4567' }],
});
const PHONE_ONLY = contact({
  _id: 'bo',
  name: 'Bo Chen',
  phones: [{ label: 'mobile', value: '+15559876543' }],
});
const NO_CONTACT = contact({ _id: 'cal', name: 'Cal Empty' });

const none = new Set<string>();
const entries = (rows: ReturnType<typeof matchRoster>) => rows.map((r) => r.entry);

describe('matchRoster', () => {
  it('returns nothing for an empty query', () => {
    expect(matchRoster([ANA], '', none)).toEqual([]);
    expect(matchRoster([ANA], '   ', none)).toEqual([]);
  });

  it('offers every address on a matched card, emails before phones', () => {
    const rows = matchRoster([ANA, PHONE_ONLY], 'ana', none);
    expect(rows.map((r) => r.p._id)).toEqual(['ana', 'ana']);
    expect(entries(rows)).toEqual([{ email: 'ana@example.com' }, { phone: '+15551234567' }]);
    expect(rows.map((r) => r.label)).toEqual(['home', 'mobile']);
    // Rows are keyed per address, not per contact, so both render.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('lists multiple emails and phones on one card', () => {
    const multi = contact({
      _id: 'dee',
      name: 'Dee Multi',
      emails: [{ label: 'home', value: 'dee@home.com' }, { label: 'work', value: 'dee@work.com' }],
      phones: [{ label: 'mobile', value: '+15551110000' }, { label: 'home', value: '+15552220000' }],
    });
    expect(entries(matchRoster([multi], 'dee', none))).toEqual([
      { email: 'dee@home.com' },
      { email: 'dee@work.com' },
      { phone: '+15551110000' },
      { phone: '+15552220000' },
    ]);
  });

  it('resolves an email-less contact to their canonical E.164 phone, prettified for display', () => {
    const rows = matchRoster([PHONE_ONLY], 'bo', none);
    expect(rows[0].entry).toEqual({ phone: '+15559876543' });
    expect(rows[0].display).toBeTruthy();
  });

  it('matches by phone digits regardless of typed formatting', () => {
    const rows = matchRoster([ANA, PHONE_ONLY], '555-987', none);
    expect(rows).toHaveLength(1);
    expect(rows[0].p._id).toBe('bo');
  });

  it('drops the whole contact when ANY of their addresses is taken', () => {
    // A household member's email is taken; their phone reaches the same contact,
    // so the card must not fall through to it.
    expect(matchRoster([ANA], 'ana', new Set(['ana@example.com']))).toEqual([]);
    expect(matchRoster([ANA], 'ana', new Set(['+15551234567']))).toEqual([]);
  });

  it('collapses an address duplicated on the card', () => {
    const dupe = contact({
      _id: 'eve',
      name: 'Eve Dupe',
      emails: [{ label: 'home', value: 'eve@x.com' }, { label: 'work', value: 'EVE@x.com' }],
    });
    expect(entries(matchRoster([dupe], 'eve', none))).toEqual([{ email: 'eve@x.com' }]);
  });

  it('drops contacts with nothing contactable and caps the dropdown', () => {
    expect(matchRoster([NO_CONTACT], 'cal', none)).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) =>
      contact({ _id: `p${i}`, name: `Match ${i}`, emails: [{ label: 'home', value: `m${i}@x.com` }] }),
    );
    // Both caps apply: 5 contacts max, 6 rows max — single-address cards hit the
    // contact cap first.
    expect(matchRoster(many, 'match', none)).toHaveLength(5);
  });

  it('never splits a contact across the row cap', () => {
    const wide = (id: string) => contact({
      _id: id,
      name: `Match ${id}`,
      emails: [
        { label: 'home', value: `${id}-a@x.com` },
        { label: 'work', value: `${id}-b@x.com` },
        { label: 'other', value: `${id}-c@x.com` },
        { label: 'other', value: `${id}-d@x.com` },
      ],
    });
    const rows = matchRoster([wide('one'), wide('two')], 'match', none);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.p._id))).toEqual(new Set(['one']));
  });

  it('lists the first contact in full even when it alone exceeds the cap', () => {
    const huge = contact({
      _id: 'big',
      name: 'Big Card',
      emails: Array.from({ length: 8 }, (_, i) => ({ label: 'other', value: `big${i}@x.com` })),
    });
    expect(matchRoster([huge], 'big', none)).toHaveLength(8);
  });

  it('reads legacy single-value fields via the read-time fold', () => {
    const legacy = contact({ _id: 'leg', name: 'Lee Legacy', email: 'LEE@x.com' });
    expect(matchRoster([legacy], 'lee', none)[0].entry).toEqual({ email: 'lee@x.com' });
  });
});
