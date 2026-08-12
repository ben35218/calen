import { navTargetForView } from '../navDestinations';

// Maps a server suggest_navigation `view` id to a screen + params. The setup
// (gear-chip) ids deep-link into the exact settings screen/field; keep in sync
// with CONFIG_DESTINATIONS in server/src/services/navDestinations.js.

describe('navTargetForView — nav (view) ids', () => {
  it('maps a plain view id to its screen', () => {
    expect(navTargetForView('view_calendar')).toEqual({ route: 'CalendarHome' });
  });

  it('returns null for an unknown id', () => {
    expect(navTargetForView('nope')).toBeNull();
  });

  it('needs trip context for a trip-scoped id', () => {
    expect(navTargetForView('open_trip')).toBeNull();
    expect(navTargetForView('open_trip', { tripId: 't1' })).toEqual({
      route: 'TripDetail',
      params: { id: 't1' },
    });
  });
});

describe('navTargetForView — setup ids deep-link to a screen + field', () => {
  it('setup_ai_personal_info → Privacy & data AI toggle', () => {
    expect(navTargetForView('setup_ai_personal_info')).toEqual({
      route: 'PrivacyData',
      params: { focus: 'aiPersonalInfo' },
    });
  });

  it('setup_home_address → Account address field', () => {
    expect(navTargetForView('setup_home_address')).toEqual({
      route: 'Account',
      params: { promptField: 'homeAddress' },
    });
  });

  it('setup_household → Household invite prompt', () => {
    expect(navTargetForView('setup_household')).toEqual({
      route: 'Household',
      params: { promptInvite: true },
    });
  });

  it('setup_contact → Contact form phone section', () => {
    expect(navTargetForView('setup_contact')).toEqual({
      route: 'ContactForm',
      params: { type: 'service', focus: 'phone' },
    });
  });

  it('setup_reminders → Reminders enable prompt', () => {
    expect(navTargetForView('setup_reminders')).toEqual({
      route: 'Reminders',
      params: { promptEnable: true },
    });
  });

  it('setup_event_phone needs the focused event id, else null', () => {
    expect(navTargetForView('setup_event_phone')).toBeNull();
    expect(navTargetForView('setup_event_phone', { eventId: 'e1' })).toEqual({
      route: 'EventLocation',
      params: { eventId: 'e1', promptPhone: true },
    });
  });
});
