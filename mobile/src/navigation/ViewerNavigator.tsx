import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HeaderCloseButton } from '../components/ui';
import ViewerCalendarScreen from '../screens/viewer/ViewerCalendarScreen';
import ViewerEventScreen from '../screens/viewer/ViewerEventScreen';
import ViewerPrintScreen from '../screens/viewer/ViewerPrintScreen';
import ViewerUnlockScreen from '../screens/viewer/ViewerUnlockScreen';
import UnlockPaywallScreen from '../screens/plan/UnlockPaywallScreen';
import { RootStackParamList } from './types';
import { useSessionLocked } from '../hooks/useSessionLocked';
import { colors } from '../theme';

// Free viewer mode's shell (billing-plans.md): what a signed-in user WITHOUT
// the $4.99 app unlock gets when a calendar has been shared with them (or a
// share invitation is pending) — instead of the hard paywall. Deliberately
// tiny: the read-only shared-calendar home (month grid ⇄ agenda list), its
// event detail, the print sheet, the unlock paywall as an upgrade route, and
// sign-out (inside the screens). A viewer has no Invitations inbox —
// pending calendar shares auto-accept inside ViewerCalendarScreen, so a shared
// calendar simply appears. Everything else stays behind the paywall in
// AppNavigator.
//
// Routes are a slice of RootStackParamList so the reused screens' typings
// resolve unchanged.
//
// A LOCKED viewer opens on `ViewerUnlock` instead of the calendar, and with no
// way back to it until they're in. Landing them on the calendar would be a
// month of empty cells with a note taped to it — every event on it is
// ciphertext this device can't open — and the one thing worth doing would be
// hidden behind a menu. Restoring access IS the screen in that state.
//
// `initialRouteName` is read once, at mount, which is what makes this safe:
// the lock state is settled before this navigator can mount — RootNavigator
// holds the splash until auth bootstrap finishes (including its silent
// biometric/passkey unlock attempt), and the live sign-in paths (login /
// register in store/auth) run their E2EE enroll/unlock BEFORE setUser flips
// the gate. Once the user is in, the navigator does NOT re-mount and yank them
// out of whatever they're reading. The paths that can't settle first (passkey
// login's interactive unlock, the post-reset flow) are caught by
// ViewerUnlockScreen's self-heal, which leaves for the calendar the moment the
// session turns out to be unlocked.

const Stack = createNativeStackNavigator<RootStackParamList>();

const hdr = (bg: string) => ({ headerStyle: { backgroundColor: bg }, headerTintColor: '#fff' as const });

export default function ViewerNavigator() {
  const lockedAtMount = useSessionLocked();
  return (
    <Stack.Navigator
      initialRouteName={lockedAtMount ? 'ViewerUnlock' : 'ViewerHome'}
      screenOptions={{
        ...hdr(colors.background),
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      {/* The shell's home draws its own floating chrome over a full-bleed
          calendar (like the unlocked app's CalendarHome), so no header bar. */}
      <Stack.Screen
        name="ViewerHome"
        component={ViewerCalendarScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen name="ViewerEvent" component={ViewerEventScreen} options={{ title: 'Event' }} />
      {/* Print is a finish-and-dismiss task, so it presents modally with a ✕ —
          the same rule (and the same close button) as the unlocked app's
          PrintCalendar. */}
      <Stack.Screen
        name="ViewerPrint"
        component={ViewerPrintScreen}
        options={({ navigation }) => ({
          title: 'Print',
          presentation: 'modal',
          headerLeft: () => <HeaderCloseButton onPress={() => navigation.goBack()} />,
        })}
      />
      {/* The unlock/recovery route. Without it a viewer whose key stopped
          opening the shared events (the forgotten-password reset case) had no
          affordance at all inside the shell — the real unlock UI lives in
          Profile → Privacy & data, behind the paywall, so the only way back in
          was to buy the app.

          When it IS the landing screen, the swipe-back gesture is disabled: as
          the stack's first route there's nothing behind it, and a half-swipe
          that rubber-bands looks like a broken screen. Pushed from the shell it
          behaves like any other route, back chevron and all. */}
      <Stack.Screen
        name="ViewerUnlock"
        component={ViewerUnlockScreen}
        options={{ title: '', gestureEnabled: !lockedAtMount }}
      />
      {/* The upgrade route is the SAME full-screen paywall the gate renders
          for a locked user with no shared calendars (RootNavigator mounts it
          bare, headerless). Pushing it must not put a titled bar over it: the
          header is transparent and title-less, so the screen is pixel-identical
          and all that's added is the floating back button — the one thing this
          instance needs that the gate's doesn't have. */}
      <Stack.Screen
        name="UnlockPaywall"
        component={UnlockPaywallScreen}
        options={{
          title: '',
          headerTransparent: true,
          headerStyle: { backgroundColor: 'transparent' },
          headerShadowVisible: false,
        }}
      />
    </Stack.Navigator>
  );
}
