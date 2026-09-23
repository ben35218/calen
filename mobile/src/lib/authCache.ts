import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from '../api';

// The last /auth/me payload, cached so a cold launch that cannot REACH the
// server (offline, a timeout, a mid-deploy 5xx) can still enter the app on the
// stored session instead of stranding the user at the login screen. Before
// this cache existed, any transient bootstrap failure deleted a perfectly
// valid token — the "why do I have to sign in every day?" bug.
//
// Plaintext profile only (id / email / name / entitlement flags) — the same
// sensitivity class as the calendar-prefs cache, and wiped by the same
// sign-out teardown (store/auth signOut).
const KEY = 'hc_auth_user';

export async function saveCachedUser(user: User): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // Best-effort — a failed write just means the next offline launch can't
    // fast-path; nothing else depends on it.
  }
}

export async function loadCachedUser(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export async function clearCachedUser(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
