import axios from 'axios';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { API_URL } from '../config';
import { getCachedToken, saveToken } from '../lib/secureToken';
import { tokenExpiry } from '../lib/jwtClaims';
import { getDeviceId } from '../lib/deviceId';

// Device identity headers (Signal-parity F2/F3): X-Device-Id is the stable
// per-install UUID the server keys session rows by (one Devices row per
// install); name/platform label the row so the list is readable and new-device
// alerts say WHICH device. None grant a session; the id's one security role is
// skipping the F1 reset hold for an install that has signed in before.
const DEVICE_NAME = Device.deviceName || Device.modelName || 'Unknown device';
const DEVICE_PLATFORM = Platform.OS;

// Mirrors client/src/services/api.js, adapted for React Native:
//   - baseURL is the absolute API URL (no dev proxy on device)
//   - the bearer token comes from the in-memory cache backed by SecureStore
//   - a 401 handler notifies listeners so the auth store can sign the user out
//     (RN has no window.location to redirect)
const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use(async (config) => {
  const token = getCachedToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['X-Device-Name'] = DEVICE_NAME;
  config.headers['X-Device-Platform'] = DEVICE_PLATFORM;
  // Best-effort: a request without the id just falls back to the server's
  // legacy per-sign-in session behavior — never block the request on it.
  const deviceId = await getDeviceId().catch(() => null);
  if (deviceId) config.headers['X-Device-Id'] = deviceId;
  return config;
});

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

// The auth store registers a callback here so a session-death 401 triggers
// sign-out (see shouldSignOutOn401 for what qualifies).
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn;
}

// Endpoints where an old server build answers a failed CREDENTIAL INPUT check
// (wrong current password) with 401 instead of 403. The server now sends 403
// there; this list covers the transition window where a new app meets an old
// server, so a typo on the change-password screen can't sign the device out.
const CREDENTIAL_CHECK_PATHS = ['/auth/email', '/auth/password', '/auth/account'];

// Whether a 401 response means "this session is dead" (sign the user out) as
// opposed to a 401 that says nothing about the stored session. Exported for
// tests. Two exclusions:
//   1. Requests that carried no bearer token — a call racing ahead of the
//      cold-start token load (or a pre-auth endpoint like /auth/login) can't
//      testify about a token it never presented. Before this guard, such a
//      race deleted a valid session.
//   2. The credential-check endpoints above.
export function shouldSignOutOn401(config?: { url?: string; headers?: Record<string, unknown> }): boolean {
  if (!config?.headers?.Authorization) return false;
  const path = String(config.url || '').split('?')[0];
  return !CREDENTIAL_CHECK_PATHS.includes(path);
}

// Whether an `X-Refreshed-Token` the server handed back may replace the token
// the device holds. Only a token that outlives the current one is adopted, and
// only while a current one exists. Exported for tests. Two failure modes this
// closes:
//   1. A replayed response. iOS's URL cache kept a week-old GET and, on a 304,
//      handed the app that cached response's headers — an `X-Refreshed-Token`
//      minted (and since expired) in a previous session. Adopting it swapped a
//      seconds-old token for a dead one and signed the device out on the next
//      call: the TestFlight 47–49 login loop. The server now sends `no-store`
//      and no ETags; this guard means a stale header can never do that again.
//   2. A response landing after sign-out: with no current token there is
//      nothing to slide, and resurrecting one would re-arm a dead session.
export function shouldAdoptRefreshedToken(refreshed: unknown, current: string | null): boolean {
  if (typeof refreshed !== 'string' || !refreshed || !current) return false;
  const next = tokenExpiry(refreshed);
  const now = tokenExpiry(current);
  if (next === null) return false;
  // An undecodable current token can't be compared; let a well-formed refresh
  // replace it rather than pin the device to something the server can't read.
  return now === null || next > now;
}

api.interceptors.response.use(
  (res) => {
    // Sliding session: past the token's half-life the server hands back a fresh
    // one in this header; storing it keeps an active user signed in forever.
    const refreshed = res.headers['x-refreshed-token'];
    if (shouldAdoptRefreshedToken(refreshed, getCachedToken())) void saveToken(refreshed as string);
    return res;
  },
  (err) => {
    if (err.response?.status === 401 && shouldSignOutOn401(err.config)) onUnauthorized?.();
    return Promise.reject(err);
  }
);

export default api;
