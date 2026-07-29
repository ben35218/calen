import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// First-run orientation flag. A brand-new install lands on the calendar with no
// signal that Calen is more than a calendar; the onboarding screen (shown once,
// before the app) fixes that. Persisted per-install in AsyncStorage — mirrors
// the tiny subscriber store in privacyPrefs.ts so the gate re-renders the moment
// "Get started" flips it.

const KEY = 'hc_onboarding_complete';

let complete = false;
let loaded = false;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

// `loaded` flips only AFTER the disk read resolves so the gate can hold the
// splash instead of flashing onboarding at a user who has already seen it.
// Concurrent callers share the one in-flight read.
function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        complete = (await AsyncStorage.getItem(KEY)) === '1';
      } catch {
        complete = false;
      }
      loaded = true;
      subs.forEach((fn) => fn());
    })();
  }
  return loading;
}

// Mark onboarding done and surface it immediately to every mounted subscriber
// (the RootNavigator gate) so the app renders without a relaunch.
export function markOnboardingComplete() {
  complete = true;
  AsyncStorage.setItem(KEY, '1').catch(() => {});
  subs.forEach((fn) => fn());
}

// Test-only: drop the module cache so a spec can exercise a fresh install.
export function __resetOnboardingForTests() {
  complete = false;
  loaded = false;
  loading = null;
}

export interface OnboardingStatus {
  complete: boolean;
  loaded: boolean;
  markComplete: () => void;
}

export function useOnboardingStatus(): OnboardingStatus {
  const [state, setState] = useState({ complete, loaded });

  useEffect(() => {
    const sub = () => setState({ complete, loaded });
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  return { ...state, markComplete: markOnboardingComplete };
}
