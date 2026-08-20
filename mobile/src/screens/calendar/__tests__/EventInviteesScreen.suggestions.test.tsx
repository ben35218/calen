import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The event Invitees field's autocomplete contract (calendar.md → Invitees &
// sharing): it runs the SAME shared roster matcher as the household invite and
// the calendar outside-share, so a matched contact lists every address it can be
// invited at — each email, then each canonical-E.164 phone, labelled — and a
// taken address removes the whole contact rather than falling through to
// another one on the card.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: ({ children }: { children: React.ReactNode }) => children,
  KeyboardController: { isVisible: () => false, state: () => null },
}));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSequence: (v: unknown) => v,
  };
});

const mockNav = { setOptions: jest.fn(), goBack: jest.fn(), navigate: jest.fn(), pop: jest.fn() };
const SNAPSHOT = {
  title: 'Dinner',
  startDate: '2026-09-01T18:00:00.000Z',
  allDay: false,
  calendarType: 'personal',
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  // A draft event (no eventId): nothing is sent, so a tapped suggestion just
  // stages — which is exactly what the dropdown's contract is about.
  useRoute: () => ({ params: { eventId: undefined, snapshot: SNAPSHOT } }),
}));

// One card with two emails and two phones — the case the old per-contact
// resolution collapsed to a single primary email.
const mockRoster = [
  {
    _id: 'dee',
    name: 'Dee Multi',
    type: 'friend',
    emails: [{ label: 'home', value: 'dee@home.com' }, { label: 'work', value: 'dee@work.com' }],
    phones: [{ label: 'mobile', value: '+15551110000' }],
  },
];
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'contacts') return { data: mockRoster };
    if (queryKey[0] === 'household') return { data: { _id: 'hh', members: [{ _id: 'me', email: 'me@x.com' }] } };
    if (queryKey[0] === 'settings') return { data: { phone: '+15559999999' } };
    return { data: [] };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../lib/e2ee', () => ({
  openRecord: jest.fn(), sealNew: jest.fn(), sealInvitationSnapshot: jest.fn(), ensureHouseholdKey: jest.fn(),
}));
jest.mock('../../../lib/inviteeDraft', () => ({
  getQueuedInvitees: () => [],
  setQueuedInvitees: jest.fn(),
  getQueuedHouseholdInvitees: () => [],
  setQueuedHouseholdInvitees: jest.fn(),
  getQueuedRevokes: () => [],
  setQueuedRevokes: jest.fn(),
  useDraftGuestListVisible: () => true,
  setDraftGuestListVisible: jest.fn(),
}));
jest.mock('../../../lib/householdRsvp', () => ({
  notifyHouseholdInvitees: jest.fn(), rsvpsForEvent: jest.fn(),
}));
jest.mock('../../../lib/inviteAlerts', () => ({ eventInvitationExpired: () => false }));
jest.mock('../../../lib/calendarPrefs', () => ({
  useCalendarColors: () => ({ colors: {}, setColor: jest.fn() }),
  useCustomCalendars: () => ({ calendars: [] }),
}));
jest.mock('../../../hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => jest.fn() }));
jest.mock('../../../components/EmailAppSheet', () => ({
  useEmailComposer: () => ({ composeEmail: jest.fn(), emailSheet: null }),
}));
jest.mock('../../../api', () => ({
  calendarApi: {}, householdApi: {}, invitationsApi: {}, contactsApi: {}, settingsApi: {},
}));
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ user: { _id: 'me', email: 'me@x.com' } }) }));

import EventInviteesScreen from '../EventInviteesScreen';

const FIELD = 'Email or phone number';

describe('EventInviteesScreen contact autocomplete', () => {
  afterEach(cleanup);

  const type = async (view: Awaited<ReturnType<typeof render>>, text: string) => {
    await fireEvent.changeText(view.getByPlaceholderText(FIELD), text);
    await view.findByDisplayValue(text);
  };

  it('offers every email and phone on a matched card, each labelled', async () => {
    const view = await render(<EventInviteesScreen />);
    await type(view, 'dee');
    expect(await view.findByText('home · dee@home.com')).toBeTruthy();
    expect(await view.findByText('work · dee@work.com')).toBeTruthy();
    // The phone is prettified for display, so match its label prefix.
    expect(await view.findByText(/^mobile · /)).toBeTruthy();
  });

  it('stages the address that was tapped, not the card’s first one', async () => {
    const view = await render(<EventInviteesScreen />);
    await type(view, 'dee');
    await fireEvent.press(await view.findByText('work · dee@work.com'));
    // Staged under New — the picked address, verbatim.
    expect(await view.findByText('dee@work.com')).toBeTruthy();
    expect(view.queryByText('dee@home.com')).toBeNull();
  });

  it('drops the whole contact once one of their addresses is staged', async () => {
    const view = await render(<EventInviteesScreen />);
    await type(view, 'dee');
    await fireEvent.press(await view.findByText('home · dee@home.com'));
    await view.findByText('dee@home.com');
    await type(view, 'dee');
    // Their other addresses reach the same person, who is already invited.
    expect(view.queryByText('work · dee@work.com')).toBeNull();
    expect(view.queryByText(/^mobile · /)).toBeNull();
  });
});
