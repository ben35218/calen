// D1 CalendarKey re-sealing (calendar.md → shared-lane key loading).
//
// The contract these pin is a data-integrity one: re-sealing an event must
// carry the WHOLE canonical subset. The original implementation sealed 6 of
// EVENT_ENC's 20 fields, which silently deleted the rest from the ciphertext —
// `calendarType` worst of all, since the Record row keeps no plaintext copy
// (only `scope.resource`) and BOTH the owner's grid and the viewer's agenda
// bucket events by the decrypted value. A stripped event therefore rendered on
// no calendar for anyone, while looking perfectly healthy on the server.

const mockUpdateEvent = jest.fn().mockResolvedValue({ data: {} });
const mockCalList = jest.fn();
jest.mock('../../api', () => ({
  calendarApi: { updateEvent: (...a: unknown[]) => mockUpdateEvent(...a) },
  customCalendarsApi: {
    list: () => mockCalList(),
    mintKey: jest.fn().mockResolvedValue({ data: {} }),
    wrapMembers: jest.fn().mockResolvedValue({ data: {} }),
    pendingKeys: jest.fn().mockResolvedValue({ data: [] }),
  },
}));

// sealForCalendar echoes the content it was handed, so a test can assert on
// exactly what WOULD have been encrypted.
const mockSealForCalendar = jest.fn(
  async (_c: string, _id: string, resource: string, fields: unknown) =>
    ({ enc: { ks: 'cal', ct: JSON.stringify(fields) }, keyVersion: 1, scope: { resource } }),
);
jest.mock('../e2ee', () => ({
  getHDK: () => 'hdk',
  getKeyPair: () => ({}),
  mintCalendarKey: jest.fn(),
  wrapCalendarKeyForMember: jest.fn(),
  loadCalendarKeys: jest.fn().mockResolvedValue(1),
  sealForCalendar: (...a: unknown[]) => mockSealForCalendar(...(a as [string, string, string, unknown])),
  currentCalendarKeyVersion: () => 1,
  getResourceKey: () => 'k',
}));

const mockGetAll = jest.fn();
jest.mock('../replica', () => ({ getAll: () => mockGetAll() }));
jest.mock('../records', () => ({
  syncRecords: jest.fn().mockResolvedValue({}),
  resetRecordCursor: jest.fn().mockResolvedValue(undefined),
}));

import { repairCalendarLaneEvents, reconcileCalendarKeys } from '../calendarKeys';
import { customCalendarsApi } from '../../api';
import { mintCalendarKey } from '../e2ee';

// A fully-populated event as the replica holds it after decryption.
const healthyEvent = () => ({
  _id: 'e1',
  calendarType: 'custom-shared',
  title: 'Practice',
  description: 'bring cleats',
  location: 'Field 3',
  placeId: 'p1',
  url: 'https://x.test',
  phone: '+15551234567',
  startDate: '2026-08-10T17:00:00.000Z',
  endDate: '2026-08-10T18:00:00.000Z',
  allDay: false,
  travelMinutes: 15,
  travelDistanceKm: 4,
  reminderMinutes: 30,
  alert2Minutes: 10,
  alertAudience: 'all',
  guestListVisible: true,
  invitationId: 'inv1',
  cancelled: false,
  recurrence: { freq: 'WEEKLY' },
  exceptionDates: ['2026-08-17'],
  scope: { resource: 'custom-shared' },
});

// The same event after the old truncating re-seal: routing intact, sealed
// `calendarType` gone.
const strippedEvent = () => ({
  _id: 'e2',
  title: 'Recital',
  startDate: '2026-08-12T19:00:00.000Z',
  endDate: '2026-08-12T20:00:00.000Z',
  scope: { resource: 'custom-shared' },
});

describe('reSealEvents (via the first-share mint)', () => {
  beforeEach(() => {
    mockUpdateEvent.mockClear();
    mockSealForCalendar.mockClear();
    (mintCalendarKey as jest.Mock).mockResolvedValue({ household: { wrappedKey: 'w', hdkVersion: 1 } });
    (customCalendarsApi.pendingKeys as jest.Mock).mockResolvedValue({
      data: [{
        calendarKey: 'custom-shared', currentKeyVersion: 0, needsMint: true,
        rotationPending: false, collaborators: [], missingMembers: [],
      }],
    });
  });

  // The regression that cost real data: migrating a calendar's events onto its
  // CalendarKey must not narrow what's sealed.
  it('migrates the event with its WHOLE sealed subset, not a hand-picked few', async () => {
    mockGetAll.mockResolvedValue([healthyEvent()]);

    await reconcileCalendarKeys();

    expect(mockSealForCalendar).toHaveBeenCalledTimes(1);
    const fields = mockSealForCalendar.mock.calls[0][3] as Record<string, unknown>;
    // Every field the old implementation silently dropped.
    expect(fields.calendarType).toBe('custom-shared');
    expect(fields.allDay).toBe(false);
    expect(fields.recurrence).toEqual({ freq: 'WEEKLY' });
    expect(fields.exceptionDates).toEqual(['2026-08-17']);
    expect(fields.url).toBe('https://x.test');
    expect(fields.placeId).toBe('p1');
    expect(fields.reminderMinutes).toBe(30);
    expect(fields.alert2Minutes).toBe(10);
    expect(fields.alertAudience).toBe('all');
    expect(fields.guestListVisible).toBe(true);
    expect(fields.invitationId).toBe('inv1');
    expect(fields.cancelled).toBe(false);
    expect(fields.travelMinutes).toBe(15);
    expect(fields.travelDistanceKm).toBe(4);
    // …alongside the six it did keep.
    expect(fields.title).toBe('Practice');
    expect(fields.description).toBe('bring cleats');
    expect(fields.location).toBe('Field 3');
    expect(fields.phone).toBe('+15551234567');
    expect(fields.startDate).toBe('2026-08-10T17:00:00.000Z');
    expect(fields.endDate).toBe('2026-08-10T18:00:00.000Z');
  });

  it('still finds an already-stripped event via its plaintext lane', async () => {
    // No sealed calendarType to group by — only scope.resource. Without the
    // fallback this event would be skipped and left under a retired key.
    mockGetAll.mockResolvedValue([strippedEvent()]);

    await reconcileCalendarKeys();

    expect(mockSealForCalendar).toHaveBeenCalledTimes(1);
    expect((mockSealForCalendar.mock.calls[0][3] as Record<string, unknown>).calendarType)
      .toBe('custom-shared');
  });
});

describe('repairCalendarLaneEvents', () => {
  beforeEach(() => {
    mockUpdateEvent.mockClear();
    mockSealForCalendar.mockClear();
    mockCalList.mockResolvedValue({
      data: [{ key: 'custom-shared', mine: true, calKeyVersion: 1 }],
    });
  });

  it('restores calendarType from the plaintext lane so the event renders again', async () => {
    mockGetAll.mockResolvedValue([strippedEvent()]);

    expect(await repairCalendarLaneEvents()).toBe(1);
    const [, , resource, fields] = mockSealForCalendar.mock.calls[0];
    expect(resource).toBe('custom-shared');
    // The field the grid and the viewer bucket by is back.
    expect((fields as Record<string, unknown>).calendarType).toBe('custom-shared');
    expect((fields as Record<string, unknown>).title).toBe('Recital');
    // And the write still carries the plaintext routing.
    expect(mockUpdateEvent).toHaveBeenCalledWith('e2', expect.objectContaining({ calendarType: 'custom-shared' }));
  });

  it('leaves a healthy event alone (idempotent — no rewrite once clean)', async () => {
    mockGetAll.mockResolvedValue([healthyEvent()]);

    expect(await repairCalendarLaneEvents()).toBe(0);
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('never rewrites an event it could not decrypt (that would destroy it, not repair it)', async () => {
    // Locked session / key not held: the content fields are absent for the same
    // reason a stripped event's are, so the two must be told apart by content.
    mockGetAll.mockResolvedValue([{ _id: 'e3', scope: { resource: 'custom-shared' } }]);

    expect(await repairCalendarLaneEvents()).toBe(0);
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it("won't rewrite a calendar shared TO us (a view collaborator is 403'd on the lane)", async () => {
    mockCalList.mockResolvedValue({
      data: [{ key: 'custom-shared', mine: false, calKeyVersion: 1 }],
    });
    mockGetAll.mockResolvedValue([strippedEvent()]);

    expect(await repairCalendarLaneEvents()).toBe(0);
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });
});
