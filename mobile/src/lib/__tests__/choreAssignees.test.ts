import { choreAssigneeOptions } from '../choreAssignees';
import type { Person } from '../../api';

const person = (p: Partial<Person> & { _id: string; name: string }) => p as Person;

const ME = 'u-me';
const PARTNER = 'u-partner';

// A roster with two household member self-Persons plus ordinary contacts.
const me = person({ _id: 'p-me', name: 'Ben', type: 'family', accountId: ME });
const partner = person({ _id: 'p-partner', name: 'Alex', type: 'family', accountId: PARTNER });
const familyContact = person({ _id: 'p-mom', name: 'Mom', type: 'family' });
const friend = person({ _id: 'p-sam', name: 'Sam', type: 'friend' });
const plumber = person({ _id: 'p-plumber', name: 'Ace Plumbing', type: 'service' });
const ROSTER = [familyContact, partner, friend, me, plumber];

describe('choreAssigneeOptions', () => {
  it('offers household members only — not family/friend/service contacts', () => {
    const opts = choreAssigneeOptions({ people: ROSTER, memberIds: [ME, PARTNER], myId: ME });
    expect(opts.map((o) => o.value)).toEqual(['p-me', 'p-partner']);
  });

  it('lists you first, then the rest of the household alphabetically', () => {
    const zoe = person({ _id: 'p-zoe', name: 'Zoe', type: 'family', accountId: 'u-zoe' });
    const opts = choreAssigneeOptions({
      people: [zoe, ...ROSTER], memberIds: ['u-zoe', PARTNER, ME], myId: ME,
    });
    expect(opts.map((o) => o.label)).toEqual(['Ben (You)', 'Alex', 'Zoe']);
  });

  it('leaves just you in a solo household', () => {
    const opts = choreAssigneeOptions({ people: ROSTER, memberIds: [ME], myId: ME });
    expect(opts).toEqual([{ value: 'p-me', label: 'Ben (You)' }]);
  });

  it('falls back to you when the household fetch is missing (offline / 404)', () => {
    const opts = choreAssigneeOptions({ people: ROSTER, memberIds: [], myId: ME });
    expect(opts).toEqual([{ value: 'p-me', label: 'Ben (You)' }]);
  });

  it('drops a self-Person whose account is no longer a member', () => {
    const opts = choreAssigneeOptions({ people: ROSTER, memberIds: [ME], myId: ME });
    expect(opts.some((o) => o.value === 'p-partner')).toBe(false);
  });

  it('keeps an existing non-member assignee visible so it never reads as Unassigned', () => {
    const opts = choreAssigneeOptions({
      people: ROSTER, memberIds: [ME], myId: ME, currentAssigneeId: 'p-mom',
    });
    expect(opts).toEqual([
      { value: 'p-me', label: 'Ben (You)' },
      { value: 'p-mom', label: 'Mom' },
    ]);
  });

  it('does not duplicate the current assignee when they are a member', () => {
    const opts = choreAssigneeOptions({
      people: ROSTER, memberIds: [ME, PARTNER], myId: ME, currentAssigneeId: 'p-partner',
    });
    expect(opts.filter((o) => o.value === 'p-partner')).toHaveLength(1);
  });
});
