import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// AsyncStorage-backed privacy preferences with a tiny subscriber store, mirroring
// the pattern in calendarPrefs.ts so every mounted hook stays in sync when the
// Privacy screen flips a toggle.

const KEY = 'hc_privacy_prefs';

export interface PrivacyPrefs {
  // Master switch for any AI-powered feature (assistants, suggestions, scans).
  aiEnabled: boolean;
  // Whether personal/contact info may be included in AI prompts.
  aiUsePersonalInfo: boolean;
  // On-device reminder notifications (Phase 5a). When off we cancel the schedule
  // and stop rescheduling — no local notifications fire.
  remindersEnabled: boolean;
  // Screen security (Signal-parity A3): block screenshots/recording and cover
  // the app-switcher snapshot. Default ON — decrypted household data shouldn't
  // leak into the photo roll or the task switcher unless the user opts out.
  screenSecurity: boolean;
  // App lock (Signal-parity A4): minutes in the background before the in-memory
  // keys are dropped and a fresh Face ID unlock is required. -1 = never (off,
  // the default — matches Signal's opt-in screen lock), 0 = immediately.
  appLockMinutes: number;
}

export const DEFAULT_PRIVACY_PREFS: PrivacyPrefs = {
  aiEnabled: true,
  aiUsePersonalInfo: true,
  remindersEnabled: true,
  screenSecurity: true,
  appLockMinutes: -1,
};

// ── In-memory state + subscribers ───────────────────────────────────────────
let state: PrivacyPrefs | null = null;
const subs = new Set<() => void>();
let loaded = false;

function current(): PrivacyPrefs {
  return state ?? DEFAULT_PRIVACY_PREFS;
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    state = { ...DEFAULT_PRIVACY_PREFS, ...saved };
  } catch {
    state = { ...DEFAULT_PRIVACY_PREFS };
  }
  subs.forEach((fn) => fn());
}

function persist(next: PrivacyPrefs) {
  const prev = current();
  state = next;
  AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
  subs.forEach((fn) => fn());
  // Mirror the AI master switch to the server (User.aiEnabled) so the AI routes
  // can refuse even a bypassed client (spec: ai-assistant.md). Best-effort —
  // the on-device gate is primary; a missed sync self-heals on the next flip.
  if (prev.aiEnabled !== next.aiEnabled) {
    // Deferred require to avoid a module cycle (api/client → stores → prefs).
    const { settingsApi } = require('../api') as typeof import('../api');
    settingsApi.update({ aiEnabled: next.aiEnabled }).catch(() => {});
  }
}

// Read the current prefs imperatively (e.g. before firing an AI request). Falls
// back to defaults until the first load resolves.
export function getPrivacyPrefs(): PrivacyPrefs {
  ensureLoaded();
  return current();
}

// Convenience hook for the common case: gate any AI entry point (assistant
// buttons, photo scans, recipe import) on the master switch so nothing
// AI-powered is shown while "Use AI features" is off.
export function useAiEnabled(): boolean {
  return usePrivacyPrefs().prefs.aiEnabled;
}

export function usePrivacyPrefs() {
  const [prefs, setPrefs] = useState<PrivacyPrefs>(current());

  useEffect(() => {
    const sub = () => setPrefs({ ...current() });
    subs.add(sub);
    ensureLoaded().then(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  function set<K extends keyof PrivacyPrefs>(key: K, value: PrivacyPrefs[K]) {
    persist({ ...current(), [key]: value });
  }

  return { prefs, set };
}
