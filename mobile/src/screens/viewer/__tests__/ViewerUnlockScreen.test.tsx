import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react-native';

// The viewer's way back in after a forgotten-password reset (crypto-e2ee.md
// "Re-key", billing-plans.md "Free viewer mode"). The contract under test:
//   - the shared calendars are named, so the user knows what they're asking for
//     even though none of their events can be decrypted;
//   - a passkey unlock is offered first and, when it works, returns straight to
//     the shell without troubling anyone;
//   - "Request access" re-keys ONCE (a new identity key covers every
//     envelope at once) and then asks EVERY shared calendar's owner;
//   - an account with encrypted records of its own is warned before the re-key
//     abandons them, and does not proceed unless the user confirms;
//   - the recovery code stays a quiet secondary path, not the headline;
//   - the PASSWORD is offered only when it can actually work (the ordinary
//     relaunch lock) and hidden after a reset, where it provably cannot — the
//     dead-end loop this screen exists to end;
//   - the page states the locked state plainly (the hero headline) and every
//     explanation is folded behind an ⓘ toggle so the actions stay loudest;
//   - typing happens in bottom sheets (password, recovery code), so the page
//     itself stays a short list of choices;
//   - the upgrade pitch stays OFF this screen (it lives on the calendar home).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockGoBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockCanGoBack = { value: true };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    replace: mockReplace,
    navigate: mockNavigate,
    canGoBack: () => mockCanGoBack.value,
  }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

const mockRequestAccess = jest.fn().mockResolvedValue({ data: {} });
jest.mock('../../../api', () => ({
  customCalendarsApi: { requestAccess: (key: string) => mockRequestAccess(key) },
}));

const mockUnlockWithPasskey = jest.fn();
const mockUnlockWithPassword = jest.fn();
const mockUnlockWithRecoveryCode = jest.fn();
const mockRekey = jest.fn();
// Whether this session already verified a password (sign-in / the reset itself)
// and is holding it for the re-key. Default false so the tests below exercise
// the fallback sheet; the remembered case has its own test.
const mockKnowsPassword = { value: false };
jest.mock('../../../lib/e2ee', () => ({
  unlockWithPasskey: () => mockUnlockWithPasskey(),
  unlockWithPassword: (pw: string) => mockUnlockWithPassword(pw),
  unlockWithRecoveryCode: (c: string) => mockUnlockWithRecoveryCode(c),
  rekeyIdentity: (pw: string | null, opts?: unknown) => mockRekey(pw, opts),
  hasSessionPassword: () => mockKnowsPassword.value,
}));

// `e2eePasswordStale` is the difference between the ordinary relaunch lock (the
// password still opens the key) and the post-reset lock (it provably cannot).
const mockUser = { e2eePasswordStale: true as boolean | undefined };
const mockLogout = jest.fn();
jest.mock('../../../store/auth', () => ({
  useAuth: () => ({ user: mockUser, logout: mockLogout }),
}));
jest.mock('../../../lib/passkeys', () => ({ passkeysSupported: () => true }));
jest.mock('../../../lib/calendarKeys', () => ({
  ensureSharedCalendarKeys: jest.fn().mockResolvedValue(undefined),
}));

const mockCustom = { list: [] as unknown[] };
const mockRefreshCustom = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../lib/calendarPrefs', () => ({
  useCustomCalendars: () => ({ calendars: mockCustom.list, loaded: true }),
  refreshCustomCalendars: () => mockRefreshCustom(),
}));

// Whether this account ever bought the app unlock. False (the viewer default)
// means it has never been able to create content of its own, which is what
// makes the server's data-loss count meaningless for them.
const mockUnlocked = { value: false };
jest.mock('../../../lib/unlock', () => ({
  useUnlocked: () => ({ unlocked: mockUnlocked.value, loaded: true }),
}));

// The session lock state. Locked by default — the screen exists for a locked
// viewer; the self-heal tests flip it to the mounted-by-mistake case.
const mockSessionLocked = { value: true };
jest.mock('../../../hooks/useSessionLocked', () => ({
  useSessionLocked: () => mockSessionLocked.value,
}));

import { Alert } from 'react-native';
import ViewerUnlockScreen from '../ViewerUnlockScreen';

function sharedCal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custom-shared', name: 'Soccer Season', color: '#123456',
    alertsEnabled: true, sharedWithHousehold: false, householdAccess: 'full',
    sharedWith: [], sharedWithOutside: [], mine: false, access: 'view',
    ...overrides,
  };
}

beforeEach(() => {
  mockCustom.list = [sharedCal()];
  mockKnowsPassword.value = false;
  mockUnlocked.value = false;
  mockSessionLocked.value = true;
  mockLogout.mockClear();
  mockRefreshCustom.mockClear();
  mockUser.e2eePasswordStale = true; // the post-reset case, unless a test says otherwise
  mockCanGoBack.value = true;
  mockGoBack.mockClear();
  mockReplace.mockClear();
  mockNavigate.mockClear();
  mockUnlockWithPassword.mockReset().mockResolvedValue(false);
  mockRequestAccess.mockClear();
  mockUnlockWithPasskey.mockReset().mockResolvedValue(false);
  mockUnlockWithRecoveryCode.mockReset().mockResolvedValue(false);
  mockRekey.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

test('names the shared calendars and does not tell the user to sign in again', async () => {
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-two', name: 'Book Club' })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('Soccer Season')).toBeTruthy();
  expect(view.getByText('Book Club')).toBeTruthy();
  // The dead-end advice the old shell gave — a reset re-wraps nothing, so
  // signing in again can never decrypt these events.
  expect(view.queryByText(/sign in again/i)).toBeNull();
});

test('a viewer’s own household calendars are never listed here', async () => {
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-mine', name: 'My Errands', mine: true })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText('My Errands')).toBeNull();
});

test('a successful passkey unlock returns to the shell without asking anyone', async () => {
  mockUnlockWithPasskey.mockResolvedValue(true);
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Unlock with passkey'));
  await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  expect(mockRekey).not.toHaveBeenCalled();
  expect(mockRequestAccess).not.toHaveBeenCalled();
});

test('requesting access re-keys once and asks every shared calendar’s owner', async () => {
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-two', name: 'Book Club' })];
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  const pw = await waitFor(() => view.getByPlaceholderText('Your current password'));
  fireEvent.changeText(pw, 'hunter2');
  // The submit stays disabled until the typed password lands in state, and a
  // press on a disabled button is a no-op — retry until it takes.
  await waitFor(() => {
    fireEvent.press(view.getByText('Send request'));
    expect(mockRekey).toHaveBeenCalled();
  });
  await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
  // One identity key covers every envelope — re-keying per calendar would be
  // both wasteful and misleading about what the action does.
  expect(mockRekey).toHaveBeenCalledTimes(1);
  // A pure viewer (locked, no calendars of their own) has no content to lose,
  // so the data-loss guard is pre-confirmed rather than shown — see the
  // never-unlocked test below.
  expect(mockRekey).toHaveBeenCalledWith('hunter2', { confirmDataLoss: true });
  expect(mockRequestAccess).toHaveBeenCalledWith('custom-shared');
  expect(mockRequestAccess).toHaveBeenCalledWith('custom-two');
  // The wait is on the owner, so say so rather than dropping back silently.
  expect(view.getByText('Request sent')).toBeTruthy();
});

test('a password verified this session is reused — no sheet, no retyping', async () => {
  // The point of the whole flow: a reset signs the user in and leaves them
  // locked, so the app is already holding a password the server just accepted.
  // Asking for it again on the screen that exists because they lost access is
  // friction with no security value. Passing null lets e2ee use what it holds.
  mockKnowsPassword.value = true;
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(mockRekey).toHaveBeenCalledWith(null, { confirmDataLoss: true }));
  expect(view.queryByPlaceholderText('Your current password')).toBeNull();
  // ...and it still reaches every owner, exactly as the typed path does.
  await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledWith('custom-shared'));
  await waitFor(() => expect(view.getByText('Request sent')).toBeTruthy());
});

test('the data-loss warning still guards the no-typing path', async () => {
  // Skipping the password must not skip the confirmation that the re-key
  // abandons this account's own encrypted records.
  mockKnowsPassword.value = true;
  mockUnlocked.value = true;
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-mine', name: 'My Errands', mine: true })];
  mockRekey.mockResolvedValue({
    ok: false, needsConfirm: true, recordCount: 7, recoverableByHousehold: false,
  });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  expect(String(alertSpy.mock.calls[0][1])).toContain('7');
  expect(mockRequestAccess).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});

test('with no password held, the sheet still collects one', async () => {
  // The relaunch-days-later case: token restored, nothing typed this session,
  // so there is no wrapping key and the screen must ask for one.
  mockKnowsPassword.value = false;
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(view.getByPlaceholderText('Your current password')).toBeTruthy());
  expect(mockRekey).not.toHaveBeenCalled();
});

test('a viewer who never unlocked the app is not warned about data they never made', async () => {
  // The account is behind the hard paywall, so nothing on it was created by the
  // user: the lone Record is the "You" Person the client auto-seeds at boot,
  // which the server's guard counts as "1 items you saved in Calen". Warning
  // someone that re-keying destroys data they neither made nor can read is a
  // scare with no decision behind it, so the guard is pre-confirmed.
  mockUnlocked.value = false;
  mockCustom.list = [sharedCal()]; // shared only — nothing of their own
  mockKnowsPassword.value = true;
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(mockRekey).toHaveBeenCalledWith(null, { confirmDataLoss: true }));
  expect(alertSpy).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});

test('the confirmation does not offer a calendar that isn’t there yet', async () => {
  // Until an owner approves, the new identity has nothing wrapped to it — a
  // "Back to calendar" button would land the user on an empty grid that reads
  // as the app having lost their data. The wait IS the state.
  mockKnowsPassword.value = true;
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(view.getByText('Request sent')).toBeTruthy());
  expect(view.queryByText('Back to calendar')).toBeNull();
  expect(mockGoBack).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  // The only way onward is out.
  fireEvent.press(view.getByText('Sign out'));
  expect(mockLogout).toHaveBeenCalled();
});

test('a pending request survives a sign-out — the confirmation comes back', async () => {
  // The bug: "Request sent" was component state, so signing out and back in
  // dropped the user onto a blank calendar whose sync note gave no hint their
  // request existed. The seat's `accessRequestedAt` is the server's durable
  // record of the wait, so a fresh mount (nothing local, `asked` false) still
  // opens on the confirmation.
  mockCustom.list = [sharedCal({ accessRequestedAt: '2026-08-03T00:00:00.000Z' })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('Request sent')).toBeTruthy();
  // ...and not the options screen, which would invite them to ask all over again.
  expect(view.queryByText('Request access')).toBeNull();
});

test('once the owner approves, the wait ends and the calendar opens', async () => {
  // Approval clears the stamp server-side, so the poll is what notices. Nothing
  // else would ever move the user off this screen.
  mockCustom.list = [sharedCal({ accessRequestedAt: '2026-08-03T00:00:00.000Z' })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('Request sent')).toBeTruthy();
  expect(mockRefreshCustom).toHaveBeenCalled(); // polling for the answer

  mockCustom.list = [sharedCal()]; // the owner said yes
  view.rerender(<ViewerUnlockScreen />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('ViewerHome'));
});

test('a session that turns out to be unlocked leaves for the calendar on its own', async () => {
  // The registration race: RootNavigator's gate can remount while a sign-in's
  // E2EE enroll is still deriving keys, so ViewerNavigator reads "locked" at
  // mount, pins its once-read initialRouteName here — and the unlock lands
  // moments later with nothing left to notice it. The screen itself is that
  // something: it must hand an unlocked session straight to the calendar.
  mockSessionLocked.value = false;
  mockCanGoBack.value = false; // the landing-screen case — this IS the shell
  await render(<ViewerUnlockScreen />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('ViewerHome'));
});

test('an unlocked session still waits on the confirmation, never the calendar', async () => {
  // Post-re-key the session IS unlocked, but nothing has been wrapped to the
  // new identity yet — the self-heal must not undercut the terminal
  // request-sent state by dropping the user onto an empty grid.
  mockSessionLocked.value = false;
  mockCustom.list = [sharedCal({ accessRequestedAt: '2026-08-03T00:00:00.000Z' })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('Request sent')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockGoBack).not.toHaveBeenCalled();
});

test('a first paint with no stamp yet does not bounce to the calendar', async () => {
  // The list loads asynchronously, so "no pending request" on frame one means
  // "not fetched yet", not "approved" — leaving before the answer arrives would
  // throw the user back to the blank calendar this screen exists to replace.
  const view = await render(<ViewerUnlockScreen />);
  expect(mockReplace).not.toHaveBeenCalled();
  expect(view.getByText('This calendar is locked')).toBeTruthy();
});

test('the re-key password is presented as the new key, not as an identity check', async () => {
  // It is NOT a "confirm it's you" gate and must never be dropped as one:
  // rekeyIdentity → enroll(password) wraps the NEW private key under it, and
  // that envelope is the password factor every later unlock opens. Removing the
  // field would leave the fresh identity with only a recovery-code factor — the
  // viewer would be locked out again on the next relaunch. Someone who just
  // reset their password shouldn't be asked to prove themselves, so the copy
  // says what the password is for.
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(view.getByText(/becomes this phone’s key/)).toBeTruthy());
  expect(view.queryByText(/Confirm it’s you/)).toBeNull();
});

test('an account with its own encrypted data is warned before the re-key destroys it', async () => {
  // Owns a calendar of their own → real content, so the guard must be honoured.
  mockUnlocked.value = true;
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-mine', name: 'My Errands', mine: true })];
  mockRekey.mockResolvedValue({
    ok: false, needsConfirm: true, recordCount: 42, recoverableByHousehold: false,
  });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  const pw = await waitFor(() => view.getByPlaceholderText('Your current password'));
  fireEvent.changeText(pw, 'hunter2');
  await waitFor(() => {
    fireEvent.press(view.getByText('Send request'));
    expect(alertSpy).toHaveBeenCalled();
  });
  const [, message] = alertSpy.mock.calls[0];
  expect(String(message)).toContain('42');
  // Nothing was asked for and nothing was destroyed — the user has to say yes.
  expect(mockRequestAccess).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});

test('the recovery code is available but stays behind a quiet link', async () => {
  mockUnlockWithRecoveryCode.mockResolvedValue(true);
  const view = await render(<ViewerUnlockScreen />);
  // Not a button competing with the primary actions — most viewers won't have
  // the code to hand, and leading with it makes the screen read as a dead end.
  expect(view.queryByPlaceholderText('Enter your recovery code')).toBeNull();

  fireEvent.press(view.getByText('I have a recovery code'));
  const field = await waitFor(() => view.getByPlaceholderText('Enter your recovery code'));
  fireEvent.changeText(field, 'ABCD-EFGH');
  await waitFor(() => {
    fireEvent.press(view.getByText('Unlock'));
    expect(mockUnlockWithRecoveryCode).toHaveBeenCalled();
  });
  await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  expect(mockUnlockWithRecoveryCode).toHaveBeenCalledWith('ABCD-EFGH');
});


test('after a password reset the password is not offered — it cannot work', async () => {
  mockUser.e2eePasswordStale = true;
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText('Unlock with password')).toBeNull();
  // ...and the copy says why, rather than sending them round the loop again.
  expect(view.queryByText(/sign in again/i)).toBeNull();
  fireEvent.press(view.getByText('This calendar is locked'));
  await waitFor(() => expect(view.getByText(/Your new password can’t unscramble/)).toBeTruthy());
});

test('an ordinary relaunch lock offers the password, which unlocks in place', async () => {
  mockUser.e2eePasswordStale = false;
  mockUnlockWithPassword.mockResolvedValue(true);
  const view = await render(<ViewerUnlockScreen />);

  fireEvent.press(view.getByText('Unlock with password'));
  const field = await waitFor(() => view.getByPlaceholderText('Your password'));
  fireEvent.changeText(field, 'hunter2');
  await waitFor(() => {
    fireEvent.press(view.getByText('Unlock'));
    expect(mockUnlockWithPassword).toHaveBeenCalled();
  });
  expect(mockUnlockWithPassword).toHaveBeenCalledWith('hunter2');
  await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  // Nobody else was troubled for a lock the user could open themselves.
  expect(mockRekey).not.toHaveBeenCalled();
});

test('explanations stay folded away until asked for', async () => {
  const view = await render(<ViewerUnlockScreen />);
  // The prose that would otherwise bury the two buttons under a lecture.
  expect(view.queryByText(/Shared calendars are scrambled/)).toBeNull();
  // The headline itself is the disclosure's label — there is no separate "Why
  // is it locked?" row to tap, just the ⓘ sitting inline after the statement.
  expect(view.queryByText(/Why is it locked/)).toBeNull();
  fireEvent.press(view.getByText('This calendar is locked'));
  await waitFor(() => expect(view.getByText(/Shared calendars are scrambled/)).toBeTruthy());
  // Toggles back off — it's a disclosure, not a one-way reveal.
  fireEvent.press(view.getByText('This calendar is locked'));
  await waitFor(() => expect(view.queryByText(/Shared calendars are scrambled/)).toBeNull());
});

test('keeps the upgrade pitch off the options screen', async () => {
  // While the user still has something to try, the offer competes with it and
  // reads as an upsell for the problem itself — "pay us and maybe your calendar
  // comes back" — which isn't even true. (It IS offered once they're waiting;
  // see the confirmation test below.)
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText('Unlock Calen')).toBeNull();
});

test('the confirmation offers the unlock, the one thing left to do', async () => {
  // Waiting on someone else is the only state where the app holds nothing for
  // the user and they cannot act on the problem at all — so the offer stops
  // being an upsell and becomes the answer to "what do I do now?".
  mockKnowsPassword.value = true;
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Request access'));
  await waitFor(() => expect(view.getByText('Request sent')).toBeTruthy());
  fireEvent.press(view.getByText('Unlock Calen'));
  expect(mockNavigate).toHaveBeenCalledWith('UnlockPaywall');
});

test('the hero headline is the screen’s only title', async () => {
  // The route name is not printed anywhere — the nav bar is left blank (bare
  // back chevron, set in ViewerNavigator) and the body opens on the user's
  // situation rather than a heading repeating the destination they tapped.
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText('Restore access')).toBeNull();
  expect(view.getByText('This calendar is locked')).toBeTruthy();
});

test('the calendar card carries no eyebrow above it', async () => {
  // The headline has just said these are the locked shared calendars, so a
  // "Shared with you" label restates it and puts a third stack of text between
  // the user and the actions. Named rows with a padlock each speak for
  // themselves.
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText('Shared with you')).toBeNull();
  expect(view.getByText('Soccer Season')).toBeTruthy();
  // The one eyebrow that survives is the break before the actions.
  expect(view.getByText('How to get back in')).toBeTruthy();
});

test('leads with what is wrong, in plain language', async () => {
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('This calendar is locked')).toBeTruthy();
  // Not "your key is stale" / "the envelope can't be unwrapped" — the user has
  // never heard those words and would conclude the app is broken. Standalone
  // "key" only: "passkey" is the credential's actual name, the one the OS puts
  // in front of the user itself, so it isn't jargon we invented.
  expect(view.queryByText(/\bkeys?\b|envelope|encrypt/i)).toBeNull();
});

test('the headline counts the locked calendars', async () => {
  mockCustom.list = [sharedCal(), sharedCal({ id: 'custom-two', name: 'Book Club' })];
  const view = await render(<ViewerUnlockScreen />);
  expect(view.getByText('Your shared calendars are locked')).toBeTruthy();
});

test('the hero is the headline and its ⓘ, nothing else', async () => {
  // No what-happens-next line under the headline: it only described the buttons
  // already on screen, and a nontechnical user reading three stacked blocks of
  // text before reaching an action concludes the app is broken.
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText(/below/i)).toBeNull();
});

test('a relaunch lock explains a lock the user can open themselves', async () => {
  mockUser.e2eePasswordStale = false;
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('This calendar is locked'));
  await waitFor(() => expect(view.getByText(/just needs you to prove it’s you/)).toBeTruthy());
  // The post-reset dead-end wording would be a lie here — this password works.
  expect(view.queryByText(/can’t unscramble/)).toBeNull();
});

test('there is nothing to type until the user picks a way in', async () => {
  // Typing happens in a bottom sheet, not unfolded inline: the page stays a
  // short, stable list of choices instead of growing a form mid-scroll.
  mockUser.e2eePasswordStale = false;
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByPlaceholderText('Your password')).toBeNull();
  expect(view.queryByPlaceholderText('Enter your recovery code')).toBeNull();

  fireEvent.press(view.getByText('Unlock with password'));
  await waitFor(() => expect(view.getByPlaceholderText('Your password')).toBeTruthy());
  // The sheet is its own focused task — the recovery field didn't come with it.
  expect(view.queryByPlaceholderText('Enter your recovery code')).toBeNull();
});

test('each option keeps its own explanation folded away', async () => {
  const view = await render(<ViewerUnlockScreen />);
  expect(view.queryByText(/We set this phone up fresh/)).toBeNull();
  fireEvent.press(view.getByText('What happens if I ask?'));
  await waitFor(() => expect(view.getByText(/We set this phone up fresh/)).toBeTruthy());
  // Opening one explanation doesn't unfold the others.
  expect(view.queryByText(/Shared calendars are scrambled/)).toBeNull();
});

test('offers a way out, because this screen can be the whole app', async () => {
  // A locked viewer lands here as the entire shell, so the calendar's overflow
  // menu — sign-out's usual home — is unreachable. Without this, someone signed
  // in as the wrong account, or who can't complete any option here, has no exit
  // but deleting the app.
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Sign out'));
  expect(mockLogout).toHaveBeenCalled();
});

test('as the landing screen it opens the calendar rather than popping to nothing', async () => {
  // Locked viewers land here as the whole shell — there is no route beneath, so
  // a goBack would be a no-op and the button would look broken.
  mockCanGoBack.value = false;
  mockUnlockWithPasskey.mockResolvedValue(true);
  const view = await render(<ViewerUnlockScreen />);
  fireEvent.press(view.getByText('Unlock with passkey'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('ViewerHome'));
  expect(mockGoBack).not.toHaveBeenCalled();
});
