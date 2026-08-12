import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { authApi, householdApi, User } from '../api';
import { setUnauthorizedHandler } from '../api/client';
import { loadToken, saveToken, clearToken } from '../lib/secureToken';
import {
  ensureEnrolledOnLogin, ensureHouseholdKey, unlockWithPasskey,
  unlockWithPasskeyPrfOutput, rewrapForNewPassword, lock as lockE2EE,
  unlockFromDeviceCache, forgetDeviceKey, generateAccountSecret, addPasskeyFactor,
  holdRecoveryCode, releaseRecoveryCode, clearRecoveryCode, setSealAuthor,
  subscribeKeysReady, subscribeHouseholdChanged, rememberSessionPassword, getHDK,
} from '../lib/e2ee';
import { passkeysSupported, assertPasskeyForLogin } from '../lib/passkeys';
import { maintainKeyHygiene } from '../lib/dropMigration';
import { ensureSharedCalendarKeys } from '../lib/calendarKeys';
import { queryClient } from '../lib/queryClient';
import { clearAll as clearReplica } from '../lib/replica';
import { resetRecordCursor, syncRecords } from '../lib/records';
import { resetCalendarPrefs, reloadCalendarPrefs } from '../lib/calendarPrefs';
import { resetOwnedAddons } from '../lib/addons';
import { cacheUnlocked, clearUnlockCache } from '../lib/unlock';
import { unregisterCurrentPushToken } from '../lib/push';
import { clearViewerContentCache } from '../lib/viewerAccess';

// Enroll (or unlock) the E2EE keypair after auth, then make sure this session
// holds the household key (owner mints it lazily on first unlock). Additive and
// best-effort: a crypto/enrollment failure must not block sign-in.
//
// ensureHouseholdKey also finalizes born-encrypted activation (drops the
// plaintext for a fresh mandated household) once the key is ready — so any unlock
// path that reaches it activates, not just this password/register one.
async function initE2EE(password: string) {
  try {
    const status = await ensureEnrolledOnLogin(password);
    if (status !== 'locked') await ensureHouseholdKey();
  } catch (err) {
    console.warn('[e2ee] enrollment/unlock skipped:', (err as Error)?.message ?? err);
  }
}

// Session store (React context). Equivalent to client/src/stores/auth.js, but
// token persistence is async (SecureStore) so we expose a `bootstrapping` flag
// for the splash gate while we restore + verify a stored token.
type AuthState = {
  user: User | null;
  bootstrapping: boolean;
  isLoggedIn: boolean;
  login: (creds: { email: string; password: string }) => Promise<void>;
  // One-tap sign-in with a registered passkey; false = user canceled the sheet.
  loginWithPasskey: (email?: string) => Promise<boolean>;
  // Emailed-code reset; signs the user in and reports the E2EE outcome so the
  // screen can explain a still-locked state ('none' = account not enrolled).
  resetPassword: (data: { email: string; code: string; newPassword: string }) =>
    Promise<'unlocked' | 'locked' | 'none' | { held: string }>;
  // Registration establishes the account's primary unlock factor. Passing a
  // `password` creates a real-password account (E2EE wraps under it, manual unlock
  // always available); omitting it creates a passwordless account whose durable
  // factor is a passkey (enroll one via registerWithPasskey).
  register: (data: { email: string; firstName: string; lastName?: string; password?: string }) => Promise<void>;
  // Passwordless signup that enrolls a passkey inline as the durable unlock +
  // sign-in factor before entering the app. If the passkey doesn't enroll (cancel,
  // no PRF, a dev build without associated domains) the just-created account is
  // rolled back and this THROWS — so the caller keeps the user on the register
  // screen to retry or choose a password, never stranding a factorless account.
  registerWithPasskey: (data: { email: string; firstName: string; lastName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  const logout = useCallback(async () => {
    // Leave the authed stack first, in the SAME synchronous tick as the key
    // lock below. lockE2EE() synchronously notifies lock-state subscribers, and
    // the first `await` after it would let React flush that update while the
    // authed screens are still mounted — surfacing ProfileScreen's "data is
    // locked" prompt over the login screen during teardown. Batching setUser(null)
    // with lockE2EE() unmounts those screens in the same commit, so the prompt
    // never arms.
    setUser(null);
    lockE2EE(); // drop the in-memory private key
    await forgetDeviceKey().catch(() => {}); // and the biometric device cache
    // Retire this install's push token while the session can still authorize
    // it — a signed-out device must not keep receiving the account's pushes.
    await unregisterCurrentPushToken().catch(() => {});
    await clearToken();
    // The next sign-in may be a different account: query keys aren't scoped by
    // user, so cached server state and the on-device replica would paint the
    // previous household's records. Wipe both — and the app-unlock cache, so
    // another account on this device can't inherit the paywall unlock.
    queryClient.clear();
    clearUnlockCache();
    clearViewerContentCache();
    await clearReplica().catch(() => {});
    // Wiping the replica MUST also reset the record-sync cursor: it lives in its
    // own AsyncStorage key, so without this the next sign-in resumes incremental
    // sync from the old high-water mark and never re-pulls the records we just
    // cleared — the whole household's content silently vanishes until a full
    // pull happens by chance. Reset → the next syncRecords() does a full pull.
    await resetRecordCursor().catch(() => {});
    // The calendar prefs cache is ACCOUNT state (which calendars exist, their
    // sharing, colours, order, visibility) held in unscoped AsyncStorage keys,
    // so it has to go the same way as the replica: without this the next
    // sign-in paints the previous account's calendar list until the server
    // refresh lands — which is why a viewer saw "No shared calendars yet"
    // (the stale rows were the other account's `mine: true` calendars, and the
    // shell renders only `mine: false`) and an owner signing back in saw their
    // built-ins missing. It also leaks calendar names and outside-share
    // addresses between accounts on a shared device.
    await resetCalendarPrefs().catch(() => {});
    // Same doctrine for the owned add-ons mirror (`hc_owned_addons`): it's the
    // previous ACCOUNT's entitlement set, and every session's billing fetch
    // overwrites it — so a viewer session (owns nothing) followed by the
    // owner signing back in booted the owner with all add-on lanes locked:
    // Occasions/Chores/Meals data zeroed by applyAddonLocks until the next
    // billing fetch AND a calendar refetch. Cleared → the next session starts
    // from the safe default (locked) and repaints when its own status lands.
    await resetOwnedAddons().catch(() => {});
  }, []);

  // Restore a stored token on launch and verify it against /auth/me.
  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) {
          const { data } = await authApi.me();
          setUser(data);
          // A restored session has no password, so E2EE is locked. Try the
          // no-password unlock paths, best-effort (cancel/failure just leaves it
          // locked — password unlock still works):
          //  1. the biometric device-key cache — one Face ID prompt, no network;
          //  2. a passkey assertion, if this account enrolled one.
          try {
            const unlocked =
              (await unlockFromDeviceCache()) ||
              (passkeysSupported() && (await unlockWithPasskey()));
            // Key hygiene (B1/B3 + the D1/D2 owner reconcile) runs from the
            // keys-ready hook below — ensureHouseholdKey fires it.
            if (unlocked) await ensureHouseholdKey();
          } catch {
            // canceled / unavailable — stay locked
          }
        }
      } catch {
        await clearToken();
      } finally {
        setBootstrapping(false);
      }
    })();
  }, []);

  // Any 401 from the API signs the user out.
  useEffect(() => {
    setUnauthorizedHandler(() => { void logout(); });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  // Signal-parity C4: keep the seal-author id (folded into every HDK record's
  // ciphertext as `author`) in sync with the signed-in user.
  useEffect(() => { setSealAuthor(user?._id ?? null); }, [user?._id]);

  // When the household key first becomes available (sign-in, relaunch restore,
  // app-lock foreground, or a manual unlock), re-pull the record feed and refetch
  // the replica-backed views. The first record sync on sign-in races ahead of the
  // unlock: it can't decrypt anything yet, blocks the cursor, and leaves the
  // replica empty — so the calendar/contacts/etc. show only plaintext overlays
  // (weather, holidays) until a manual mutation invalidates them. This closes that
  // gap centrally (ensureHouseholdKey is the chokepoint every unlock path reaches),
  // so content appears on its own once the key lands. See lib/records syncRecords.
  useEffect(() => subscribeKeysReady(() => {
    void (async () => {
      try { await syncRecords(); } catch { /* offline — the cached replica stands */ }
      // Shared-lane CalendarKeys (D1, both directions): the sync above can only
      // decrypt cal-scoped rows if the calendar's key is held, and sign-out
      // wiped the in-memory keys — load them and re-pull (the helper syncs
      // again itself), or an owner's outside-shared calendar (and a
      // collaborator's shared calendar) comes back empty after re-login.
      try { await ensureSharedCalendarKeys(); } catch { /* offline — retried on the next unlock */ }
      queryClient.invalidateQueries();
      // Key hygiene + the D1/D2 owner reconcile (wrap CalendarKeys/TripKeys to
      // newly accepted collaborators, rotate on revoke). MUST run on EVERY
      // unlock — the restore-path-only call it replaces meant an owner who
      // signed out and back in never wrapped the key for a new collaborator,
      // leaving the collaborator's "waiting for the owner" state permanent.
      // Best-effort background pass; cheap no-op when nothing is pending.
      void maintainKeyHygiene();
    })();
  }), []);

  // Household changed under this session (joined / left / removed). Every
  // household-scoped cache on the device now belongs to the WRONG household, so
  // it gets the same teardown sign-out performs — minus the identity half, since
  // the user is still signed in and their per-user unlock is unaffected.
  //
  // This is a privacy fix, not just a correctness one. The replica is a FLAT
  // store of decrypted rows with no householdId column, and record sync only
  // removes a row when the server sends a tombstone — which the household we
  // just left will never send us again. Without this wipe, a member who leaves
  // (or is removed) keeps that household's calendar, meals, and tasks readable
  // on their phone indefinitely, while the leave dialog promises "anything
  // shared here stays with the other members". Server-side they're already cut
  // off (their key envelope is deleted and rotation is flagged), so this is the
  // device half of the same eviction.
  useEffect(() => subscribeHouseholdChanged(() => {
    void (async () => {
      queryClient.clear();
      await clearReplica().catch(() => {});
      // Same pairing as sign-out: a wiped replica MUST reset the sync cursor, or
      // the next pull resumes from the old high-water mark and the household we
      // just JOINED never lands (its records are all older than the cursor).
      await resetRecordCursor().catch(() => {});
      // Calendar prefs are household state (which calendars exist, their
      // sharing, colours, order) and add-on locks are the household-wide union —
      // both change the instant membership does, and leaving must re-lock lanes
      // the old household had paid for.
      await resetCalendarPrefs().catch(() => {});
      // The reset also dropped the first-paint readiness the RootNavigator
      // splash gates on, and the ready hook only restarts the load when the
      // signed-in flag flips — which it won't here (the user stays signed in).
      // Without this re-arm the splash holds forever after any in-session
      // household change (join, leave, removal, re-key "start fresh").
      await reloadCalendarPrefs().catch(() => {});
      await resetOwnedAddons().catch(() => {});
      // Refill ONLY when this session actually holds the new household's key.
      // Syncing without one decrypts nothing, so it would leave the device on an
      // empty replica it just wiped — a blank app until something else happened
      // to re-pull. When no key is held yet (joined and awaiting approval, or
      // still locked), subscribeKeysReady owns the refill and fires the moment
      // records become decryptable.
      if (getHDK()) {
        try { await syncRecords(); } catch { /* offline — refilled on the next pass */ }
      }
      queryClient.invalidateQueries();
    })();
  }), []);

  // Mirror the per-user app unlock into the device cache on every auth payload
  // sighting (login/register/me). Belt-and-braces with useBilling — whichever
  // lands first flips the hard paywall.
  useEffect(() => {
    if (user) cacheUnlocked(Boolean(user.appUnlocked));
  }, [user?._id, user?.appUnlocked]);

  // Report this app version for the §9 readiness gate (every member must be on a
  // compatible build before the whole-household drop). Best-effort.
  useEffect(() => {
    if (!user) return;
    householdApi
      .reportClientVersion(Constants.expoConfig?.version ?? '0.0.0', Platform.OS)
      .catch(() => {});
  }, [user?._id]);

  const login = useCallback(async (creds: { email: string; password: string }) => {
    const { data } = await authApi.login(creds);
    await saveToken(data.token);
    // Unlock/enroll E2EE BEFORE setUser: setUser flips the RootNavigator gate,
    // and downstream navigators read the lock state once at mount — a free
    // viewer's billing status usually lands before the Argon2 KDF finishes, so
    // mounting early pinned ViewerNavigator's initialRouteName to ViewerUnlock
    // and stranded a user who had just typed the correct password on the
    // recovery screen. The token is already stored, so keysApi is authed; the
    // seal author is set eagerly so anything sealed during the unlock pipeline
    // (keys-ready sync, key hygiene) carries the author id.
    setSealAuthor(data.user._id);
    await initE2EE(creds.password);
    setUser(data.user);
  }, []);

  // Pass an email for the username-first flow (one assertion signs in AND
  // unlocks E2EE via the credential's PRF salt). Omit it for usernameless
  // sign-in: the OS account picker chooses the passkey, the server resolves the
  // user from the assertion, and E2EE unlocks post-auth (the challenge couldn't
  // carry a PRF salt for an unknown user).
  const loginWithPasskey = useCallback(async (email?: string) => {
    const { data: ch } = await authApi.passkeyChallenge(email ? { email } : {});
    const assertion = await assertPasskeyForLogin(ch);
    if (!assertion) return false; // user canceled the Face ID sheet
    const { data } = await authApi.passkeyLogin({ challengeId: ch.challengeId, response: assertion.response });
    await saveToken(data.token);
    setUser(data.user);
    // Best-effort E2EE unlock (like initE2EE — a crypto failure must not block
    // sign-in). Username-first assertions already evaluated the PRF, so unlock
    // in the same gesture. Usernameless ones didn't, so fall back to the same
    // path a relaunch uses: the biometric device-key cache (no prompt), then a
    // passkey assertion (a second Face ID only when the cache is cold).
    try {
      const unlocked = assertion.prfOutput
        ? await unlockWithPasskeyPrfOutput(assertion.credentialId, assertion.prfOutput)
        : (await unlockFromDeviceCache()) || (await unlockWithPasskey());
      if (unlocked) await ensureHouseholdKey();
    } catch (err) {
      console.warn('[e2ee] passkey unlock skipped:', (err as Error)?.message ?? err);
    }
    return true;
  }, []);

  const resetPassword = useCallback(
    async (payload: { email: string; code: string; newPassword: string }) => {
      const res = await authApi.resetPassword(payload);
      // 202 = the reset is HELD (Signal-parity F1): this device isn't a known
      // session, so the change only applies after the hold window — with loud
      // notifications to the account's other devices + email in the meantime.
      if (res.status === 202) return { held: (res.data as any).holdUntil as string };
      const { data } = res;
      await saveToken(data.token);
      setUser(data.user);
      if (!data.e2eeEnrolled) return 'none' as const;
      // The password envelope is wrapped under the OLD password. Try a silent
      // passkey unlock; if it works, re-wrap under the new password right away.
      // Otherwise the account stays locked until Face ID / recovery code in
      // Profile → Security.
      try {
        if (passkeysSupported() && (await unlockWithPasskey())) {
          await ensureHouseholdKey();
          await rewrapForNewPassword(payload.newPassword);
          return 'unlocked' as const;
        }
      } catch {
        // canceled / PRF unavailable — stay locked
      }
      // Locked, but this password is verified and current. Hold it in memory so
      // the way back in (a re-key, from the viewer shell's "Request access" or
      // Profile → Privacy & data) doesn't make the user retype what they set
      // sixty seconds ago. Dropped on lock/sign-out; see e2ee.sessionPassword.
      rememberSessionPassword(payload.newPassword);
      return 'locked' as const;
    },
    []
  );

  const register = useCallback(
    async (payload: { email: string; firstName: string; lastName?: string; password?: string }) => {
      if (payload.password) {
        // Real-password account: the E2EE envelope wraps under the chosen password,
        // so the account always has a manual unlock factor (and can add a passkey
        // later). hasPassword = true server-side.
        const { data } = await authApi.register({ ...payload, password: payload.password, passwordless: false });
        await saveToken(data.token);
        // Same ordering as login: enroll E2EE before setUser mounts the gate,
        // or a brand-new invitee races the billing fetch and lands on the
        // viewer shell's recovery screen instead of their shared calendar.
        setSealAuthor(data.user._id);
        await initE2EE(payload.password);
        setUser(data.user);
        return;
      }
      // Passwordless signup: mint a high-entropy secret on-device to bootstrap the
      // E2EE envelope (the KEK stays password-derived under the hood). The user
      // never sees it; durability is the recovery code + a passkey (see
      // registerWithPasskey). See docs/PASSWORDLESS-E2EE-PLAN.md §5c.
      const secret = await generateAccountSecret();
      const { data } = await authApi.register({
        email: payload.email, firstName: payload.firstName, lastName: payload.lastName,
        password: secret, passwordless: true,
      });
      await saveToken(data.token);
      setSealAuthor(data.user._id);
      await initE2EE(secret);
      setUser(data.user);
    },
    []
  );

  const registerWithPasskey = useCallback(
    async (payload: { email: string; firstName: string; lastName?: string }) => {
      // Create the passwordless account and unlock E2EE, THEN enroll the passkey
      // while the key is in memory — all before setUser swaps to the app, so the
      // durable factor exists by the time the recovery modal (and born-encrypted
      // drop) run. If enrollment fails we still complete sign-in; the recovery
      // code the modal enforces is the backstop.
      const secret = await generateAccountSecret();
      const { data } = await authApi.register({
        email: payload.email, firstName: payload.firstName, lastName: payload.lastName,
        password: secret, passwordless: true,
      });
      await saveToken(data.token);
      setSealAuthor(data.user._id);
      // Hold the recovery-code modal across enrollment + the passkey step, so a
      // passkey failure isn't confusingly preceded by (or buried under) the
      // recovery code. It's released only once the passkey succeeds.
      holdRecoveryCode();
      await initE2EE(secret);
      let enrolled = false;
      try {
        enrolled = await addPasskeyFactor();
      } catch (err) {
        console.warn('[e2ee] passkey enroll at register failed:', (err as Error)?.message ?? err);
      }
      if (!enrolled) {
        // The passkey didn't take (cancel, no PRF, or a dev/TestFlight build
        // without associated domains). Roll the just-created account back so we
        // don't strand a passwordless account whose only backstop is the recovery
        // code — the user returns to a clean register screen to retry or pick a
        // password. deleteAccount uses the session token (no password needed).
        clearRecoveryCode(); // drop the held code — this account is going away
        await authApi.deleteAccount({}).catch(() => {});
        lockE2EE();
        setSealAuthor(null); // eagerly set above; setUser(null) never runs here
        await forgetDeviceKey().catch(() => {});
        await clearToken();
        throw new Error(
          "Face ID / passkey setup didn’t complete on this device. Try again, or choose a password instead.",
        );
      }
      setUser(data.user); // durable factor in place — enter the app
      releaseRecoveryCode(); // now surface the recovery code (passkey succeeded)
    },
    []
  );

  return (
    <AuthContext.Provider
      value={{ user, bootstrapping, isLoggedIn: !!user, login, loginWithPasskey, resetPassword, register, registerWithPasskey, logout, setUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
