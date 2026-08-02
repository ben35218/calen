// The calendar assistant's "Delete from my calendar" confirm runs the REAL
// deletes through the same lib/eventDelete logic as the native form (the server
// `delete_event` tool only stages them). `assistantDeletePerform` must map the
// model's scope onto the right api call: a one-off event is a plain delete; a
// recurring event removes just the tapped occurrence by default, or the whole
// series when scope is 'series'. See specs/features/ai-assistant.md.
import { assistantDeletePerform } from '../../../lib/eventDelete';
import { calendarApi } from '../../../api';

jest.mock('../../../api', () => ({
  calendarApi: {
    deleteEvent: jest.fn(() => Promise.resolve('deleted')),
    excludeOccurrence: jest.fn(() => Promise.resolve('excluded')),
    truncateSeries: jest.fn(() => Promise.resolve('truncated')),
  },
}));

const api = calendarApi as jest.Mocked<typeof calendarApi>;

describe('assistantDeletePerform', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a one-off event outright, ignoring scope', async () => {
    const ev = { _id: 'e1', startDate: '2026-08-01T12:00:00.000Z', allDay: true };
    await assistantDeletePerform(ev, undefined, 'occurrence');
    expect(api.deleteEvent).toHaveBeenCalledWith('e1');
    expect(api.excludeOccurrence).not.toHaveBeenCalled();
  });

  it('removes only the tapped occurrence of a recurring event by default', async () => {
    const ev = {
      _id: 'r1',
      startDate: '2026-08-01T09:00:00.000Z',
      allDay: false,
      recurrence: { freq: 'weekly' },
    };
    await assistantDeletePerform(ev, '2026-08-08', 'occurrence');
    expect(api.excludeOccurrence).toHaveBeenCalledWith('r1', '2026-08-08');
    expect(api.deleteEvent).not.toHaveBeenCalled();
  });

  it('deletes the whole series when scope is "series"', async () => {
    const ev = {
      _id: 'r2',
      startDate: '2026-08-01T09:00:00.000Z',
      allDay: false,
      recurrence: { freq: 'daily' },
    };
    await assistantDeletePerform(ev, '2026-08-08', 'series');
    expect(api.deleteEvent).toHaveBeenCalledWith('r2');
    expect(api.excludeOccurrence).not.toHaveBeenCalled();
  });

  it('falls back to the series start day when no occurrence date is given', async () => {
    const ev = {
      _id: 'r3',
      startDate: '2026-08-01T12:00:00.000Z',
      allDay: true,
      recurrence: { freq: 'monthly' },
    };
    await assistantDeletePerform(ev, undefined);
    expect(api.excludeOccurrence).toHaveBeenCalledWith('r3', '2026-08-01');
  });
});
