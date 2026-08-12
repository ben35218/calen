import { createAliasContext } from '../aiPayload';

// G2 (Signal-parity plan): the identifier-free-prompt guarantee, as a test.
// Whatever goes through the G1 sanitizer must contain NO ObjectId-shaped
// strings and none of the stripped server-metadata keys — the model sees
// content and opaque aliases only. If a new field sneaks database identifiers
// into an AI payload, this fails.

const OBJECT_ID_RE = /\b[0-9a-f]{24}\b/i;

// A representative decrypted record set: everything openRecord could hand the
// assistants, ids and metadata included.
const fixture = {
  contacts: [{
    _id: '64b1f0a2c39e5d0012ab34cd',
    userId: '64b1f0a2c39e5d0012ab34ce',
    householdId: '64b1f0a2c39e5d0012ab34cf',
    name: 'Sam Polk',
    birthday: '2015-03-02',
    keyVersion: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }],
  calendarSources: {
    events: [{
      _id: '64b1f0a2c39e5d0012ab34d0',
      userId: '64b1f0a2c39e5d0012ab34ce',
      householdId: '64b1f0a2c39e5d0012ab34cf',
      title: 'Dentist',
      startDate: '2026-07-20T15:00:00.000Z',
      calendarType: 'appointments',
      enc: { alg: 'xchacha20poly1305-ietf', nonce: 'n', ct: 'c' },
      invitationId: '64b1f0a2c39e5d0012ab34d1',
    }],
    tasks: [{
      _id: '64b1f0a2c39e5d0012ab34d2',
      itemId: '64b1f0a2c39e5d0012ab34d3', // foreign key → must be aliased, consistently
      title: 'Replace filter',
      nextDueDate: '2026-08-01T00:00:00.000Z',
    }],
  },
};

function deepScan(value: unknown, fail: (why: string) => void, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepScan(v, fail, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (['userId', 'householdId', 'enc', 'keyVersion', 'createdAt', 'updatedAt', 'invitationId'].includes(k)) {
        fail(`stripped key "${k}" present at ${path}`);
      }
      deepScan(v, fail, `${path}.${k}`);
    }
    return;
  }
  if (typeof value === 'string' && OBJECT_ID_RE.test(value)) {
    fail(`ObjectId-shaped string "${value}" at ${path}`);
  }
}

describe('aiPayload sanitizer (G1/G2)', () => {
  it('outputs no ObjectIds and no server metadata', () => {
    const ctx = createAliasContext();
    const out = ctx.sanitize(fixture);
    deepScan(out, (why) => { throw new Error(why); });
  });

  it('aliases the same id consistently so cross-references survive', () => {
    const ctx = createAliasContext();
    const out = ctx.sanitize({
      a: { _id: '64b1f0a2c39e5d0012ab34d3', name: 'Furnace' },
      b: { itemId: '64b1f0a2c39e5d0012ab34d3', title: 'Replace filter' },
    }) as any;
    expect(out.a._id).toBe(out.b.itemId);
    expect(out.a._id).toMatch(/^r\d+$/);
  });

  it('resolves aliases back to real ids in tool results, leaving other strings alone', () => {
    const ctx = createAliasContext();
    const out = ctx.sanitize({ _id: '64b1f0a2c39e5d0012ab34d0', title: 'Dentist' }) as any;
    const result = ctx.resolveAliases({
      pendingEvent: { eventId: out._id, note: 'reschedule Dentist' },
      navigateTo: 'view_calendar',
    });
    expect(result.pendingEvent.eventId).toBe('64b1f0a2c39e5d0012ab34d0');
    expect(result.navigateTo).toBe('view_calendar');
  });

  it('keeps content fields and non-id strings intact', () => {
    const ctx = createAliasContext();
    const out = ctx.sanitize(fixture) as any;
    expect(out.contacts[0].name).toBe('Sam Polk');
    expect(out.contacts[0].birthday).toBe('2015-03-02');
    expect(out.calendarSources.events[0].title).toBe('Dentist');
    expect(out.calendarSources.events[0].calendarType).toBe('appointments');
  });
});
