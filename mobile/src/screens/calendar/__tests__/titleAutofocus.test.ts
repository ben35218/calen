// New Event opens with the cursor already in the Title field; Edit Event and an
// assistant-prefilled draft do not steal focus. The event form feeds its route
// params straight into this rule. See specs/features/calendar.md → Events.
import { shouldAutoFocusTitle } from '../../../lib/calendar';

describe('event form title autofocus', () => {
  it('focuses the title on a blank new event', () => {
    expect(shouldAutoFocusTitle({})).toBe(true);
    // Opening the form on a tapped day is still a blank create.
    expect(shouldAutoFocusTitle({ prefill: undefined } as { prefill?: unknown })).toBe(true);
  });

  it('does not focus when editing an existing event', () => {
    expect(shouldAutoFocusTitle({ eventId: 'evt_1' })).toBe(false);
  });

  it('does not focus a create prefilled by the assistant', () => {
    expect(shouldAutoFocusTitle({ prefill: { title: 'Dentist' } })).toBe(false);
  });
});
