import React from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react-native';

// The Invitees screen's commit contract (calendar.md → Invitees & sharing):
// opened FROM THE EVENT FORM (`stageOnly`), its ✓ sends nothing — it commits the
// session's staging to lib/inviteeDraft and the FORM's save is what sends,
// revokes, and notifies. Opened from the event DETAIL screen there is no pending
// save behind it, so its ✓ still commits immediately.

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

// The header ✓ is installed through useHeaderCheckButton → navigation.setOptions;
// capture its handler so the test can "tap" it.
let headerCheck: (() => void) | null = null;
const mockNav = {
  setOptions: jest.fn((opts: any) => {
    const el = opts?.headerRight?.();
    const onPress = el?.props?.onPress;
    if (onPress) headerCheck = onPress;
  }),
  goBack: jest.fn(),
  navigate: jest.fn(),
  addListener: () => () => {},
  dispatch: jest.fn(),
};
const SNAPSHOT = {
  title: 'Dinner',
  startDate: '2099-09-01T18:00:00.000Z',
  allDay: false,
  calendarType: 'personal',
};
let mockRouteParams: any = { eventId: 'ev1', snapshot: SNAPSHOT, stageOnly: true };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: mockRouteParams }),
}));

const SENT = [{ _id: 'inv1', toEmail: 'zed@x.com', status: 'pending' }];
const MEMBERS = [
  { _id: 'me', firstName: 'Ben', email: 'me@x.com' },
  { _id: 'm2', firstName: 'Sam', email: 'sam@x.com' },
];
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'contacts') return { data: [] };
    if (queryKey[0] === 'household') return { data: { _id: 'hh', members: MEMBERS } };
    if (queryKey[0] === 'settings') return { data: {} };
    if (queryKey[0] === 'invitations') return { data: SENT };
    return { data: undefined };
  },
  useMutation: ({ mutationFn }: { mutationFn: (v: any) => unknown }) => ({
    mutate: (v: any) => mutationFn(v),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../../lib/e2ee', () => ({
  openRecord: jest.fn(), sealNew: jest.fn(), sealInvitationSnapshot: jest.fn(), ensureHouseholdKey: jest.fn(),
}));
const mockSendInvitations = jest.fn().mockResolvedValue([]);
jest.mock('../../../lib/invitees', () => {
  const actual = jest.requireActual('../../../lib/invitees');
  return { ...actual, sendInvitations: (...a: unknown[]) => mockSendInvitations(...a) };
});
const mockNotify = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../lib/householdRsvp', () => ({
  notifyHouseholdInvitees: (...a: unknown[]) => mockNotify(...a),
  rsvpsForEvent: jest.fn().mockResolvedValue({}),
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
const mockSetHouseholdInvitees = jest.fn().mockResolvedValue({});
const mockRevoke = jest.fn().mockResolvedValue({});
const mockSetGuestList = jest.fn().mockResolvedValue({});
jest.mock('../../../api', () => ({
  calendarApi: {
    setHouseholdInvitees: (...a: unknown[]) => mockSetHouseholdInvitees(...a),
    setGuestListVisible: (...a: unknown[]) => mockSetGuestList(...a),
    getEvent: jest.fn().mockResolvedValue({ data: { householdInvitees: [] } }),
  },
  householdApi: {},
  invitationsApi: { revoke: (...a: unknown[]) => mockRevoke(...a) },
  contactsApi: {},
  settingsApi: {},
}));
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ user: { _id: 'me', email: 'me@x.com' } }) }));

import EventInviteesScreen from '../EventInviteesScreen';
import {
  getQueuedInvitees, getQueuedRevokes, getQueuedHouseholdInvitees, clearQueuedInvitees,
} from '../../../lib/inviteeDraft';

const FIELD = 'Email or phone number';

describe('EventInviteesScreen — staged vs immediate commit', () => {
  beforeEach(() => {
    clearQueuedInvitees();
    headerCheck = null;
    [mockSendInvitations, mockNotify, mockSetHouseholdInvitees, mockRevoke, mockSetGuestList]
      .forEach((m) => m.mockClear());
    mockRouteParams = { eventId: 'ev1', snapshot: SNAPSHOT, stageOnly: true };
  });
  afterEach(cleanup);

  const add = async (view: Awaited<ReturnType<typeof render>>, text: string) => {
    await fireEvent.changeText(view.getByPlaceholderText(FIELD), text);
    await view.findByDisplayValue(text);
    await fireEvent(view.getByPlaceholderText(FIELD), 'submitEditing');
  };
  const tapCheck = async () => { await act(async () => { headerCheck?.(); }); };

  it('a form session sends nothing on ✓ — it stages the invitee for the event save', async () => {
    const view = await render(<EventInviteesScreen />);
    await add(view, 'new@x.com');
    await tapCheck();
    expect(mockSendInvitations).not.toHaveBeenCalled();
    expect(getQueuedInvitees()).toEqual([{ email: 'new@x.com' }]);
  });

  it('a form session notifies no housemate on ✓ — the selection is staged', async () => {
    const view = await render(<EventInviteesScreen />);
    await fireEvent.press(await view.findByText('Sam'));
    await tapCheck();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSetHouseholdInvitees).not.toHaveBeenCalled();
    expect(getQueuedHouseholdInvitees()).toEqual(['m2']);
  });

  it('a form session stages a removal instead of revoking it, and the row leaves the list', async () => {
    const view = await render(<EventInviteesScreen />);
    expect(await view.findByText('zed@x.com')).toBeTruthy();
    // The confirm's Remove button is the destructive action on the native alert.
    const { Alert } = require('react-native');
    const spy = jest.spyOn(Alert, 'alert').mockImplementation((_t: any, _m: any, buttons: any) => {
      buttons.find((b: any) => b.text === 'Remove').onPress();
    });
    await fireEvent.press(view.getByLabelText('Remove zed@x.com'));
    spy.mockRestore();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(view.queryByText('zed@x.com')).toBeNull();
    await tapCheck();
    expect(getQueuedRevokes()).toEqual(['inv1']);
  });

  it('the detail-screen entry still commits on ✓ — nothing is pending behind it', async () => {
    mockRouteParams = { eventId: 'ev1', snapshot: SNAPSHOT };
    const view = await render(<EventInviteesScreen />);
    await add(view, 'new@x.com');
    await tapCheck();
    expect(mockSendInvitations).toHaveBeenCalled();
    expect(getQueuedInvitees()).toEqual([]);
  });
});
