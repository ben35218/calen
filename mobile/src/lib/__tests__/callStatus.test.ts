import { buildEventStatus, latestCallForEvent } from '../callStatus';
import { PhoneCallRecord } from '../../api';

// Minimal confirmed-call factory — buildEventStatus only reads eventId, action,
// outcome, acknowledged, and occurrenceDate.
const call = (over: Partial<PhoneCallRecord>): PhoneCallRecord =>
  ({
    _id: Math.random().toString(36),
    callId: 'c',
    action: 'cancel',
    outcome: 'confirmed',
    acknowledged: false,
    occurrenceDate: null,
    phone: null,
    status: 'ended',
    endedReason: null,
    summary: null,
    dncCaptured: false,
    durationSeconds: null,
    seen: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as PhoneCallRecord;

describe('buildEventStatus — per-occurrence call scoping', () => {
  it('an unscoped (no occurrenceDate) cancel matches the event on every day', () => {
    const s = buildEventStatus([call({ eventId: 'e1', occurrenceDate: null })]);
    expect(s.isCancelled('e1', '2026-08-07')).toBe(true);
    expect(s.isCancelled('e1', '2026-08-14')).toBe(true);
    expect(s.isCancelled('e1', undefined)).toBe(true);
    expect(s.isCancelled('other')).toBe(false);
  });

  it('a scoped cancel dims only its own occurrence, not the rest of the series', () => {
    const s = buildEventStatus([call({ eventId: 'e1', action: 'cancel', occurrenceDate: '2026-08-07' })]);
    expect(s.isCancelled('e1', '2026-08-07')).toBe(true);
    expect(s.isCancelled('e1', '2026-08-14')).toBe(false);
    // Without a date it can't match a date-scoped call.
    expect(s.isCancelled('e1')).toBe(false);
  });

  it('separate occurrences accumulate independently', () => {
    const s = buildEventStatus([
      call({ eventId: 'e1', action: 'cancel', occurrenceDate: '2026-08-07' }),
      call({ eventId: 'e1', action: 'reschedule', occurrenceDate: '2026-08-14' }),
    ]);
    expect(s.isCancelled('e1', '2026-08-07')).toBe(true);
    expect(s.isReschedulePending('e1', '2026-08-14')).toBe(true);
    expect(s.isReschedulePending('e1', '2026-08-07')).toBe(false);
    expect(s.isCancelled('e1', '2026-08-14')).toBe(false);
  });

  it('an unscoped call still covers every day even alongside scoped ones', () => {
    const s = buildEventStatus([
      call({ eventId: 'e1', action: 'cancel', occurrenceDate: '2026-08-07' }),
      call({ eventId: 'e1', action: 'cancel', occurrenceDate: null }),
    ]);
    expect(s.isCancelled('e1', '2026-08-21')).toBe(true);
  });

  it('ignores unconfirmed and acknowledged calls', () => {
    const s = buildEventStatus([
      call({ eventId: 'e1', outcome: 'unconfirmed', occurrenceDate: '2026-08-07' }),
      call({ eventId: 'e2', acknowledged: true, occurrenceDate: '2026-08-07' }),
    ]);
    expect(s.isCancelled('e1', '2026-08-07')).toBe(false);
    expect(s.isCancelled('e2', '2026-08-07')).toBe(false);
  });
});

describe('latestCallForEvent — occurrence scoping', () => {
  const calls = [
    call({ _id: 'a', eventId: 'e1', occurrenceDate: '2026-08-14' }),
    call({ _id: 'b', eventId: 'e1', occurrenceDate: '2026-08-07' }),
  ];
  it('returns the call for the requested occurrence', () => {
    expect(latestCallForEvent(calls, 'e1', '2026-08-07')?._id).toBe('b');
  });
  it('an unscoped/legacy call matches any requested occurrence', () => {
    const legacy = [call({ _id: 'x', eventId: 'e1', occurrenceDate: null })];
    expect(latestCallForEvent(legacy, 'e1', '2026-08-07')?._id).toBe('x');
  });
});
