import React, { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { NavigationContainer, DarkTheme, useNavigationContainerRef } from '@react-navigation/native';
import { useAuth } from '../store/auth';
import { isPurchasesConfigured, configurePurchases, logInPurchases } from '../lib/purchases';
import { useUnlocked } from '../lib/unlock';
import { useViewerContent } from '../lib/viewerAccess';
import UnlockPaywallScreen from '../screens/plan/UnlockPaywallScreen';
import ViewerNavigator from './ViewerNavigator';
import { useReminderScheduler } from '../hooks/useReminderScheduler';
import { useAppLock } from '../hooks/useAppLock';
import { useSelfPersonSeed } from '../hooks/useSelfPersonSeed';
import { usePrivacyPrefs } from '../lib/privacyPrefs';
import { useCalendarPrefsReady } from '../lib/calendarPrefs';
import { useOnboardingStatus } from '../lib/onboarding';
import OnboardingScreen from '../screens/onboarding/OnboardingScreen';
import AuthNavigator from './AuthNavigator';
import AppNavigator from './AppNavigator';
import { RootStackParamList } from './types';
import { colors } from '../theme';

// Dark navigation theme so scene backgrounds (and transition edges) stay dark.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.primary,
    text: '#fff',
    border: colors.border,
  },
};

// Top-level gate: splash while restoring the session, then the auth stack
// (logged out) → first-run onboarding (signed in, hasn't seen it) → the hard
// unlock paywall (no $4.99 app unlock) → the main tabs. Onboarding sits before
// the paywall so a new user learns what Calen is before being asked to pay. The
// paywall is skipped in builds without RevenueCat keys (Expo Go / dev — the
// "not configured" doctrine) and for admin accounts. Free viewer mode: a locked
// user with viewer content (a calendar shared with them, or a pending share
// invitation — lib/viewerAccess mirrors GET /billing/status) gets the read-only
// ViewerNavigator shell instead of the paywall.
export default function RootNavigator() {
  const { bootstrapping, isLoggedIn, user } = useAuth();
  const { unlocked, loaded: unlockLoaded } = useUnlocked();
  const viewer = useViewerContent();
  const onboarding = useOnboardingStatus();
  const remindersEnabled = usePrivacyPrefs().prefs.remindersEnabled;
  // Calendar colours are prefs, and every surface falls back to the app
  // defaults until they load — so painting before they land showed the grid,
  // chips and section accents in the wrong colours for a beat and then
  // recoloured them. Loading them behind the splash (with the other caches)
  // makes the first frame the user's own arrangement.
  const calendarPrefsReady = useCalendarPrefsReady(isLoggedIn && !bootstrapping);
  const navRef = useNavigationContainerRef<RootStackParamList>();

  // Central RevenueCat identity: purchases are per-USER (app_user_id = user
  // id). configure() covers the cold start; logIn() covers account switches
  // and aliases legacy installs that were keyed to the household id.
  useEffect(() => {
    if (!isLoggedIn || !user?._id || !isPurchasesConfigured()) return;
    configurePurchases(user._id);
    void logInPurchases(user._id);
  }, [isLoggedIn, user?._id]);

  const paywallActive = isPurchasesConfigured() && user?.role !== 'admin';
  const needsUnlock = isLoggedIn && paywallActive && unlockLoaded && !unlocked;
  // Don't flash the app (or the paywall) while the unlock/viewer caches are
  // still reading from disk — hold the splash a beat instead.
  const unlockPending = isLoggedIn && paywallActive && !(unlockLoaded && viewer.loaded);

  // On-device reminders (Phase 5): schedule while signed in and the user hasn't
  // turned reminders off; refresh on foreground. Flipping the toggle off cancels
  // the pending schedule (the hook's cleanup path).
  useReminderScheduler(isLoggedIn && !bootstrapping && remindersEnabled);

  // App lock (Signal-parity A4): relock the in-memory keys after the configured
  // background window; no-op while the pref is "never".
  useAppLock(isLoggedIn && !bootstrapping);

  // Seed the encrypted "You" Person once unlocked (mandatory E2EE: the server no
  // longer creates it), so person-assignment UIs always have at least the user —
  // not only after the People screen is opened.
  useSelfPersonSeed(isLoggedIn && !bootstrapping);

  // Hold the splash a beat longer while the first-run flag reads from disk, so a
  // returning user never flashes the onboarding screen before it resolves.
  const onboardingPending = isLoggedIn && !onboarding.loaded;
  // Same for the calendar arrangement (colours/order/visibility): held only
  // while signed in, and self-capped when it has to wait on the account.
  const calendarPrefsPending = isLoggedIn && !calendarPrefsReady;

  if (bootstrapping || unlockPending || onboardingPending || calendarPrefsPending) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme} ref={navRef}>
      {!isLoggedIn ? (
        <AuthNavigator />
      ) : !onboarding.complete ? (
        <OnboardingScreen onGetStarted={onboarding.markComplete} />
      ) : needsUnlock ? (
        // Free viewer mode: shared-calendar access without the unlock. A brand
        // new invitee's very first login may show the paywall for one status
        // round-trip (the paywall mounts useBilling, whose fetch caches the
        // viewer signal and re-renders this gate).
        viewer.hasContent ? <ViewerNavigator /> : <UnlockPaywallScreen />
      ) : (
        <AppNavigator />
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
