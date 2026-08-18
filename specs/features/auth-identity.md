---
title: Auth & identity
status: current
last-verified: 3cfa750+ (2026-08-14); **both teardowns now also clear the home-screen widget snapshot** — sign-out and household-change delete the App Group file (`clearWidgetData()`, widget normative in calendar.md): it holds the account's decrypted calendar outside the E2EE envelope, so it goes the same way as the replica (2026-08-14); **remote session revocation now prunes the device's push subscription** — `revokeSession` reads the session row's `deviceId` before `$pull`ing it and removes the matching `User.pushSubscriptions` entry in the same update (the entry is stamped with the install's `X-Device-Id` at push-registration time, notifications.md); a remotely signed-out device 401s on every call and could never unregister its own APNs-valid token, so it kept receiving the account's pushes after "sign out device"; legacy deviceId-less sessions revoke the token only (2026-08-13); **password-only accounts get one proactive passkey prompt on the second app open** — first run belongs to the mandatory recovery-code ceremony, so the nudge (via the pop-up lane's new security-nudge channel, mechanics in notifications.md) waits for the device's second open and fires only while recovery health is `single_factor` (enrolled + confirmed recovery code + no passkey + platform support — passkey-first registrations never see it); Add Passkey runs `addPasskeyFactor` in place when the vault is unlocked (same success/failure alerts as the Privacy & security row, failure copy naming the TestFlight limitation), else routes at Privacy & security `focus: 'recovery'`; prompted once per device per user, "Not Now" respected, the Recovery-methods badge stays the durable surface (2026-08-13); 3cd3b36+ (2026-08-12); **the household-change teardown re-arms the first-paint gate** — `resetCalendarPrefs()` drops the readiness `useCalendarPrefsReady` gates the RootNavigator splash on, and the hook only restarts its load when the signed-in flag flips (the sign-out case) — never mid-session, so any in-session household change (join / leave / removal / re-key "start fresh") left the splash holding forever; the teardown now calls the new `reloadCalendarPrefs()` right after the reset (device repro: "start fresh" hung on a loading screen after the recovery-code confirm until an app restart); the teardown also fires on re-key now, since the new identity can't read what the old one decrypted; pinned in calendarPrefs.test.ts (2026-08-12); **the Account screen's invite-preference eyebrow is labelled by direction** — "Invites" → **"Sending invites"**, because the profile hub already has an `Invitations` row for the *received*-invite inbox (badge-counted) and the same word for both made a send-side device preference read as a second inbox; copy-only, the row, sheet, and persistence are unchanged (2026-08-12); **full users get the "start fresh" last resort** — the locked box on Privacy & security now carries the re-key entry point ("No way back in? Start fresh with a new key") the free-viewer shell alone had, so a user who reset their password with no passkey and a lost recovery code can mint a new identity, get a new one-time recovery code, and save data again; the household settlement (solo purge + fresh HDK vs. member re-admission via flagged rotation) is normative in platform/crypto-e2ee.md "Re-key" (2026-08-12); ddaa21b+ (2026-08-10); **sign-out now also retires the install's push token** — `logout()` best-effort `unregisterCurrentPushToken()` before clearing the session token (remote push registration went live with the household event invites; a signed-out device must not keep receiving the account's pushes — registration/tap-routing specced in notifications.md) (2026-08-06); f6874e9+ (2026-08-05); **the lock state now settles before the app mounts** — the password login and both register paths await `initE2EE` (Argon2 KDF + envelope round-trips) BEFORE `setUser` flips the RootNavigator gate, with `setSealAuthor` called eagerly beside the token (and reset to null on the passkey-registration rollback, whose `setUser(null)` never runs); entering the app first raced every once-at-mount read of the lock state — a brand-new invitee's billing status usually beat the KDF, so `ViewerNavigator` mounted "locked", pinned `initialRouteName` to the restore-access screen, and showed a just-registered viewer "Nothing shared with you yet"; passkey login's post-auth unlock and the post-reset flow still enter unsettled and are backstopped by the viewer shell's self-heal (billing-plans.md "Free viewer mode") (2026-08-05); c2d18c0+ (2026-08-04); **the sign-out teardown gained a sibling: a HOUSEHOLD-CHANGE teardown** — joining, leaving, or being removed changes which records a user may see while the session stays signed in, so `subscribeHouseholdChanged` (raised by `ensureHouseholdKey` when the household moves under a LIVE session, never on the first read after sign-in) now drives the household-scoped half of the same wipe from the app root: query cache, replica, record-sync cursor, calendar-prefs cache, owned-add-ons mirror — leaving the identity half (key, token, per-user unlock) alone. This is a privacy fix: the replica is a FLAT store of decrypted rows with no `householdId` column and sync only removes rows on tombstones the departed household will never send, so a leaver or removed member kept that household's calendar/meals/tasks readable on their phone indefinitely while the leave dialog promised "anything shared here stays with the other members"; the cursor reset is equally required in the JOIN direction, since the joined household's records are all older than the stale high-water mark. Emitter contract pinned in e2ee.test.ts (2026-08-04); 9282d82+ (2026-08-02); **sign-out now also clears the calendar prefs cache** (`resetCalendarPrefs()`) — `hc_custom_calendars` and its siblings hold ACCOUNT state (which calendars exist, their sharing, colours, order, visibility) in unscoped AsyncStorage keys, so a signed-out account's list survived into the next sign-in: a free-viewer signing in was told "No shared calendars yet" (the stale rows were the other account's own `mine:true` calendars and the shell renders only `mine:false`), an owner signing back in saw their built-ins missing, and calendar names + outside-share addresses leaked between accounts on a shared device; new sign-out-teardown section enumerates every store logout must drop, covered by `calendarPrefs.test.ts` (2026-08-02); the F1 reset hold now recognizes a signed-out install — `isKnownDevice` also matches the request's `X-Device-Id` against existing `User.sessions` rows (sign-out is client-local, so the row persists; explicit device removal in Sign-in & Security still revokes recognition), so "previously signed in here, then signed out" resets instantly instead of hitting the 24 h hold (2026-08-02); "Forgot password?" hands the email already typed on the sign-in form to the reset screen via the `ForgotPassword` route param, which seeds its email field — no retyping (2026-08-02); account deletion is now billing-aware — an active Calen AI plan interposes a keep-billing warning (Manage-subscription affordance) before the destructive confirm, the confirm names any forfeited credit balance, `deleteUserAndData` best-effort-purges the RevenueCat subscriber (`REVENUECAT_SECRET_API_KEY`) and flags the account-deleted email with `hadActiveAiPlan`; normative rules live in billing-plans.md "Account deletion × billing" (2026-07-30); password AND email change are biometric-first with a current-password fallback — `PUT /auth/password` and `PUT /auth/email` treat `currentPassword` as optional (bcrypt-verified when present), a fresh device unlock via `reauthWithBiometric()` replaces it when the device key cache is armed; email-change client contract fixed to send `currentPassword` (was mismatched `password`) (2026-07-29); flat Account layout + email above phone, tap-to-reveal email change, location action hidden once address set (2026-07-27); account phone uses shared PhoneField (country picker + as-you-type), stored E.164 (2026-07-27); AI card (aiEnabled/aiUsePersonalInfo toggles) added to Privacy data controls (2026-07-27); registration now sends a `welcome` email and account deletion sends an `account_deleted` confirmation just before purge (both best-effort via the mailer; lifecycle owned by email-lifecycle.md) (2026-07-29); reminders (master toggle + day-based alert time) moved out of `AccountScreen` into a dedicated `RemindersScreen` off the profile hub (2026-07-29); passkey sign-in is now passwordless-first + usernameless — `POST /auth/passkey/challenge` accepts no email (discoverable-credential challenge, empty `allowCredentials`), `/passkey/login` resolves the user from the asserted credential id (new index on `passkeyCredentials.credentialId`), and the LoginScreen leads with the passkey (usernameless when the email field is empty, username-first single-gesture unlock when typed); usernameless E2EE unlock happens post-auth via the device-key cache then a passkey assertion (2026-07-29); RegisterScreen presentation aligned to the login redesign — Calen wordmark header, passkey-consistent copy ("Create account with a passkey"), and the method-hint text fixed from unreadable gray to white on the blue background (presentation only; the passkey-first mode toggle is unchanged) (2026-07-29); LoginScreen tightened to keep the Register footer above the fold on small devices — dropped the redundant "Sign in to your account" subtitle (the passkey button below is self-describing) and trimmed header/divider/wordmark spacing (presentation only) (2026-07-29); RegisterScreen now warns before sign-up that a one-time recovery-code step follows (heads-up so the mandatory `RecoveryCodeModal` reads as expected, not an ambush), and the passkey-failure alert names the TestFlight/beta limitation — passkeys need the associated-domains entitlement absent on those builds, so it points testers to the password path (copy-only; rollback behavior unchanged) (2026-07-29); AccountScreen gained an "Invites → Email app" row (shown only when 2+ known mail apps are installed) surfacing the device-local invite mail-app preference the chooser sheet remembers — pick an app or "Ask each time", persisted instantly via `lib/shareInvite.setPreferredMailApp` (chooser itself specced in households-sharing.md) (2026-07-29); the forgotten-password dead end for a LOCKED viewer is closed — a reset still leaves the password envelope stale, but the viewer shell now offers passkey / recovery code / re-key + owner-approved access request instead of only the paywalled Privacy & data screen (9282d82+, 2026-08-02); the Account screen's First/Last name fields capitalize as words with `textContentType="givenName"`/`"familyName"` QuickType hints (proper-noun rule in mobile/CLAUDE.md) (2026-08-10)
code:
  - mobile/src/screens/auth/
  - mobile/src/screens/profile/AccountScreen.tsx
  - mobile/src/store/auth.tsx
  - server/src/routes/auth.js
  - server/src/services/accountDeletion.js
  - server/src/routes/authPasskey.js
  - server/src/routes/keys.js
  - server/src/models/User.js
  - server/src/models/DeviceLink.js
  - mobile/src/lib/{passkeys,secureToken,deviceId,deviceLink,deviceKey}.ts
  - mobile/src/api/client.ts
  - server/src/services/sessions.js
tests:
  - server/src/test/authFlows.integration.test.js
  - server/src/test/passwordlessRegister.integration.test.js
  - server/src/test/sessions.integration.test.js
  - server/src/test/deviceLink.integration.test.js
  - server/src/test/recoveryMandate.integration.test.js
  - mobile/src/lib/__tests__/e2ee.test.ts
  - mobile/src/screens/auth/__tests__/forgotPasswordEmail.test.tsx
  - mobile/src/screens/auth/__tests__/signInSettlesLock.test.tsx
  - mobile/src/screens/auth/__tests__/logoutTeardown.test.tsx
---

# Auth & identity

## Purpose

Account sign-in and the identity/unlock factors that gate E2EE. Because content
is encrypted under keys derived from these factors, **authentication and
key-unlock are the same event** — a login must both prove who you are and open
your private key. The key primitives are in
[platform/crypto-e2ee.md](../platform/crypto-e2ee.md).

## Behavior (normative)

### Registration

- `POST /auth/register` creates the `User`, seeds default categories, and
  provisions the E2EE identity: an X25519 keypair whose private key is wrapped by
  a **password** factor (Argon2id). Registration flows into mandatory
  **recovery-code** enrollment (`RecoveryCodeModal`) and prompts passkey setup.
- Every account MUST have at least one non-password recovery path (recovery code
  and/or passkey) so a forgotten password isn't total data loss.
- `RegisterScreen` SHOULD forewarn the user, before they submit, that a one-time
  recovery-code step follows sign-up — so the mandatory `RecoveryCodeModal` reads
  as expected rather than an ambush.
- **Passkey-first registration** (`registerWithPasskey`) creates the account, then
  enrolls the passkey; if the passkey ceremony doesn't complete, the just-created
  account is rolled back (`deleteAccount`) so no passwordless account is stranded
  with only an unsaved recovery code, and the user returns to a clean register
  screen. On **TestFlight/beta builds this fails every time** — those builds lack
  the associated-domains entitlement passkeys require — so the failure alert MUST
  name that limitation and point the user to the password path.

### Sign-in paths

- **Password:** `POST /auth/login` → JWT; the client derives the KEK and unwraps
  the private key (`store/auth.tsx`).
- **The lock state settles before the app mounts.** The password sign-in and
  both register paths run the E2EE enroll/unlock (`initE2EE` — the Argon2 KDF
  plus envelope round-trips) to completion **before** `setUser` flips the
  RootNavigator gate, with the seal-author id set eagerly beside the token so
  anything sealed during the unlock pipeline stays attributed. Entering the app
  first raced every once-at-mount read of the lock state: a brand-new invitee's
  billing status usually beat the KDF, so `ViewerNavigator` mounted "locked",
  pinned its once-read `initialRouteName` to the restore-access screen, and
  stranded a user who had just typed a working password. Paths that cannot
  settle first — usernameless passkey login's post-auth unlock, the post-reset
  flow — are backstopped by the viewer shell's self-heal
  ([billing-plans.md](billing-plans.md) "Free viewer mode").
- **Passkey:** a Face ID assertion signs in, and (when it can) unlocks E2EE in
  the same gesture. Two modes:
  - **Usernameless (default, no email typed):** `POST /auth/passkey/challenge`
    with no `email` issues a discoverable-credential challenge (empty
    `allowCredentials`; passkeys are registered with `residentKey: 'required'`).
    The OS account picker chooses; `POST /auth/passkey/login` resolves the user
    from the returned credential id (indexed on `User.passkeyCredentials.credentialId`,
    globally unique). The challenge can't carry a `prfSalt` for an unknown user,
    so the client unlocks E2EE **after** auth via the same path a relaunch uses
    (biometric device-key cache, then a passkey assertion) — a second Face ID
    only when the cache is cold.
  - **Username-first (email typed):** the challenge constrains to that account's
    credentials and returns each credential's `prfSalt`, so one assertion signs
    in AND unlocks E2EE (the PRF output derives the KEK). The login screen leads
    with the passkey and passes a typed email through this path automatically.
  - Passkeys are also registered as sign-in credentials
    (`/auth/passkey/register-options` + `/register`, `@simplewebauthn/server`,
    stored on `User.passkeyCredentials`).
- **Email-OTP / forgot-password:** `POST /auth/forgot` emails a 6-digit code;
  `POST /auth/reset` consumes it. "Forgot password?" carries the email already
  typed on the sign-in form into the reset screen (`ForgotPassword` route param
  `{ email? }`, seeding its email field), so the user never retypes it; the field
  stays editable until a code is sent. A reset deliberately leaves the stale password
  envelope in place — the client re-wraps the private key after a passkey/recovery
  unlock (it cannot unwrap from a new password alone).
  - **Say this plainly wherever a reset leaves data locked.** The reset restores
    sign-in only; signing in again with the new password can never open the old
    envelope. Any UI that offers "sign in again" as the fix sends the user round
    a loop that cannot terminate. An unlocked user is steered to Privacy & data;
    a **locked free viewer** — who has no Privacy & data — gets the shell's
    `ViewerUnlock` route (passkey / recovery code / re-key + owner approval), see
    [billing-plans.md](billing-plans.md) "Free viewer mode".
  - **Last resort:** an account that can open its identity key by no factor at
    all can mint a new one (`POST /keys/rekey`) and have shared resources
    re-granted to it. It recovers access, never data. A full (non-viewer) user
    reaches it from the locked box on Privacy & security ("start fresh"): the
    re-key also settles their household — records only the dead key could open
    are erased and a fresh HDK mints (solo), or a rotation is flagged so a
    fellow member's device re-admits the new key (shared) — and a new one-time
    recovery code is issued. The rules live in
    [../platform/crypto-e2ee.md](../platform/crypto-e2ee.md) "Re-key".

### Passkey adoption nudge (password-only accounts)

- A password-registered account SHOULD be prompted **once** to add a passkey —
  proactively, not only via the buried Privacy & security row. The prompt
  fires on the device's **second app open** (never the first: that run carries
  the mandatory `RecoveryCodeModal`, and stacking a second security ask there
  trains reflexive dismissal), and only while recovery health is
  `single_factor` (enrolled, recovery code confirmed, platform supports
  passkeys, no passkey factor) — so passkey-first registrations and accounts
  that already added one never see it.
- The pitch leads with data durability, not sign-in convenience: a passkey
  here both signs in AND unlocks/recovers E2EE data (PRF). **Add Passkey**
  runs the `addPasskeyFactor` ceremony immediately when the vault is unlocked
  (mirroring the Privacy & security row's success/failure alerts, the failure
  copy naming the TestFlight/beta entitlement limitation); with the vault
  locked it routes at Privacy & security (`focus: 'recovery'`) instead, where
  the unlock UI lives. **Not Now** is respected — prompted once per device per
  user; the Recovery methods badge remains the durable surface.
- Pop-up mechanics (open counting, one-nudge-per-open, invitations outrank,
  passkey outranks the guardian nudge) are owned by
  [notifications.md](notifications.md) "Security nudges".

### New-device protection

- A password reset from an unrecognized device is **held** (`resetHoldUntil`,
  `RESET_COOLDOWN_HOURS`) and loudly announced to existing devices + email; the
  user can cancel it with `POST /auth/reset/cancel`.
- A device is **recognized** (the reset applies immediately) when either:
  - the request carries a valid session token for the same account in the
    `Authorization` header — "I forgot my password but I'm signed in on my own
    phone"; or
  - the request's `X-Device-Id` matches an existing device-session row on
    `User.sessions` — the install has signed in to this account before and its
    row was never revoked. Sign-out is client-local (the row stays), so signing
    out does **not** demote a device back to unrecognized; explicitly removing
    it in Sign-in & Security (`DELETE /auth/sessions/:sid`) does. The install id
    is an unguessable keychain-held 128-bit value, but it is client-supplied —
    a deliberate, *weak* recognition signal that only skips the hold; it never
    authenticates a session by itself.
- Auth endpoints are per-IP rate-limited; sessions slide via `X-Refreshed-Token`.

### Sign-out teardown (what a device must forget)

Query keys, the replica, and the on-device pref caches are **not scoped by
user**, so signing out has to wipe every store that holds ACCOUNT state or the
next sign-in on that device paints the previous account's data. `logout()`
drops, in order: the in-memory E2EE key + biometric device-key cache, the
**install's push token** (best-effort `unregisterCurrentPushToken()`, fired
while the session token can still authorize it — a signed-out device must not
keep receiving the account's pushes; registration itself is specced in
notifications.md), the token,
the react-query cache, the app-unlock and viewer-content caches, the record
replica, the record-sync cursor (its own AsyncStorage key — a wiped replica with
a live cursor resumes from the old high-water mark and never re-pulls what was
cleared), the **calendar prefs cache** (`resetCalendarPrefs()`), the
**owned add-ons mirror** (`resetOwnedAddons()` — `hc_owned_addons`; left
behind, a viewer session's empty entitlement set became the next owner
sign-in's boot state and locked their Occasions/Chores/Meals lanes to empty;
normative in billing-plans.md), and the **home-screen widget snapshot**
(`clearWidgetData()` — the App Group file is the account's decrypted calendar
sitting outside the E2EE envelope, so a signed-out device must not keep
rendering it on the home screen; widget behavior is normative in calendar.md).

That last one is account state despite living in device-shaped keys: which
calendars exist, who they're shared with, their colours, order and visibility.
Leaving it behind caused two failures. Correctness — the next account renders the
previous one's calendar list until the server refresh lands, so a free-viewer
signing in was told **"No shared calendars yet"** (the stale rows were the other
account's own `mine: true` calendars, and the viewer shell renders only
`mine: false`), and an owner signing back in saw their built-ins missing for the
mirror-image reason. Privacy — it leaks calendar names, colours and outside-share
email addresses from one account to the next on a shared device.

### Household-change teardown (the same wipe, without signing out)

Signing out is not the only way a device ends up holding the wrong household's
data. **Joining, leaving, or being removed from a household** changes which
records the user may see while the session stays signed in, so it runs the
household-scoped half of the same teardown: the react-query cache, the replica,
the record-sync cursor, the calendar-prefs cache, the owned-add-ons mirror, and
the home-screen widget snapshot (the old household's decrypted calendar; the
`['calendar']` invalidation at the end of the teardown re-runs the snapshot
writer once the new household's records land).
The identity half is deliberately untouched — the key, token, and per-user app
unlock all still belong to this user.

- The signal is `subscribeHouseholdChanged`, raised by `ensureHouseholdKey` when
  the household moves **under a live session**. It never fires on the first read
  after signing in (the previous value is simply `null` there), so it can't wipe
  a freshly-restored replica on every launch.
- **Privacy, not just correctness.** The replica is a flat store of decrypted
  rows with **no `householdId` column**, and record sync only removes a row when
  the server sends a tombstone — which a household the user has left will never
  send them again. Without this wipe a departing or removed member keeps that
  household's calendar, meals and tasks readable on their phone indefinitely,
  while the leave dialog promises *"anything shared here stays with the other
  members."* Server-side they are already cut off (their key envelope is deleted
  and rotation flagged); this is the device half of that eviction.
- The cursor reset is equally load-bearing in the **join** direction: the records
  of the household just joined are all older than the stale high-water mark, so
  without it they would never be pulled. Same rule as sign-out, same reason.
- A re-key ("start fresh") raises the same signal: the new identity can't read
  anything the old one decrypted, so the wipe applies even though the household
  *id* didn't change.
- **The wipe must re-arm what it disarms.** `resetCalendarPrefs()` also drops
  the first-paint readiness the RootNavigator splash gates on
  (`useCalendarPrefsReady`), and that hook only restarts its load when the
  signed-in flag flips — which it never does here. The teardown therefore calls
  `reloadCalendarPrefs()` right after the reset (re-reads the emptied cache,
  pulls the current household's calendars + the account arrangement, marks
  ready within the bounded first-paint wait). Without it the splash held
  forever after any in-session household change; the visible repro was "start
  fresh" hanging on a loading screen right after the recovery-code modal.
  Pinned in `calendarPrefs.test.ts`.

Normative detail for the membership side lives in
[households-sharing.md](households-sharing.md).

### Device security (screen capture & app lock)

- **Screen security** (Signal-parity A3): screenshots/recording can be blocked
  (`expo-screen-capture`) and an app-switcher `PrivacyShield` cover hides content;
  toggled by the `screenSecurity` pref (default on).
- **App lock** (A4, `useAppLock`): the app can require Face ID again after being
  backgrounded, with a configurable delay (Never / 0 / 1 / 5 min) in Privacy &
  security → Data & privacy controls.

### Factors, sessions, devices

- Factor management: `GET /keys/me`, `POST /keys/enroll`,
  `POST /keys/recovery-complete`, `PUT /keys/factors`,
  `DELETE /keys/factors/:factor`. Adding/removing a factor re-wraps only the
  private key, never household data.
- **Device linking:** `POST /keys/link/start` + `/link/complete` (+ public
  `GET /keys/link/:linkId`) hand the identity key to a second device without a
  password round-trip (`lib/deviceLink.ts`, `LinkDeviceScreen`).
- **Device sessions (F2):** every issued JWT carries the id (`sid`) of a
  session row on `User.sessions`; deleting the row revokes that token.
  `GET /auth/sessions`, `DELETE /auth/sessions/:sid`.
  - **Revocation also silences the device's pushes:** `revokeSession` looks up
    the row's `deviceId` before pulling it and prunes the matching
    `User.pushSubscriptions` entry (stamped with the same `X-Device-Id` at
    push-registration time — see
    [notifications.md](notifications.md)) in the same update. A remotely
    signed-out device 401s on every subsequent call, so it can never run its
    own push unregister, and its Expo token stays APNs/FCM-valid — without
    this prune the revoked device kept receiving the account's pushes forever.
    Sessions without a `deviceId` (legacy clients) revoke the token only.
  - **Install identity:** each app install generates a random UUID on first
    launch, persists it in the keychain (`lib/deviceId.ts`), and sends it as
    `X-Device-Id` on every request (alongside the cosmetic `X-Device-Name` /
    `X-Device-Platform` labels). Like the name, it is a label/dedup key, never
    a session-granting auth factor (the revocation key stays the `sid` in the
    JWT) — with one deliberate exception: a matching session row lets a reset
    skip the F1 hold (see New-device protection above).
  - **One row per install:** a sign-in whose `X-Device-Id` matches an existing
    session row **replaces** that row (fresh `sid`, updated name/`lastSeenAt`,
    original `createdAt` kept) instead of appending — so the Devices list shows
    physical devices, not a history of sign-ins, and re-login invalidates the
    install's previous token (one live token per install). Sign-ins without the
    header (legacy clients) append as before. The list is capped at
    `MAX_SESSIONS`, dropping the least-recently-seen row.
  - **New-device alert (F3):** "unfamiliar device" means no existing row with
    the same `X-Device-Id`; requests without the header fall back to matching
    name+platform. MUST NOT coalesce rows on name+platform alone — names like
    "iPhone" are non-unique and attacker-guessable, and merging on them would
    both hide a second real device and suppress the takeover alert.
- Account self-service: `GET /auth/me`, `PUT /auth/email`, `PUT /auth/password`,
  `DELETE /auth/account` (immediate full deletion). Deletion is
  **billing-aware**: the client warns when a Calen AI plan is active (deleting
  the account can't cancel an Apple subscription), the confirm names any
  forfeited credit balance, and the server best-effort-purges the RevenueCat
  subscriber and flags the good-bye email — normative rules in
  [billing-plans](billing-plans.md) "Account deletion × billing".
- The JWT lives in `expo-secure-store` (`lib/secureToken.ts`); an automatic Face
  ID unlock is attempted on token-restore relaunch.

## Data & API surface

- **Model:** `User` (email, name, `passwordHash`, `identityPublicKey`,
  `wrappedPrivateKey[]` factor envelopes, `passkeyCredentials[]`, recovery/reset
  state, `sessions[]` — `{deviceId?, deviceName, platform, createdAt, lastSeenAt}`
  rows, `householdId`, `contactId`), `DeviceLink`.
- **Endpoints:** `server/src/routes/auth.js`, `authPasskey.js` (mounted under
  `/api/auth`), `keys.js` (`/api/keys`).
- **Client:** `screens/auth/*` (Login, Register, ForgotPassword), `store/auth.tsx`,
  `lib/passkeys.ts`, `LinkDeviceScreen`, `AccountScreen`, `PrivacyDataScreen`.

## Profile information architecture

`ProfileHome` is an iOS-style drill-in hub. Identity and credentials are split
from encryption/recovery across two screens so neither is cluttered. **Sign out**
lives on the `ProfileHome` hub itself (a danger button below the section menu,
above the legal links), not inside a drill-in section — it's a session action, so
it stays at the top level rather than collapsing away with the Account card:

- **`AccountScreen`** (`Account`) — identity + location (header-check save) and
  Delete account, laid out **flat** (no expand/collapse sections): a grouped
  Account card under an "Account" eyebrow, then — only when 2+ known mail apps
  are installed — a **"Sending invites"** eyebrow with a single **Email app** row (the
  device-local invite mail-app preference: shows the remembered app or "Ask
  each time", opens the same mail-app picker sheet with an added Ask-each-time
  row, persists instantly outside the form's dirty/save cycle; chooser behavior
  owned by [households-sharing](households-sharing.md)), then Delete account.
  That eyebrow is labelled by **direction**, not just "Invites": the profile hub's
  `Invitations` row is the inbox of invites the user *received*, and this section
  is the mail app that invites the user *sends* go out through — the same word for
  both reads as the same destination. Reminders are a
  **separate screen** (`RemindersScreen`, route `Reminders`, off the profile
  hub) — the master on/off toggle + the personal day-based alert time; those
  controls are self-contained (each saves itself), so that screen has no
  header-check save. See [features/notifications.md](notifications.md). **Email**
  is the account's contact
  identity, so it sits **directly above the phone number** (a shared `PhoneField`
  with a country picker + as-you-type formatting, stored E.164) in the Account card as
  a value row with its own change flow. The **whole row is the affordance** — tap
  it to reveal the inline change form, with a
  chevron indicating expand state, mirroring the Sign-in → Password card on
  `PrivacyDataScreen` rather than a separate "Change" button. Changing email
  re-authenticates with the **same biometric-first, current-password-fallback**
  pattern as the password change: when the device key cache is armed
  (`isDeviceKeyEnabled()`) a fresh device unlock (`reauthWithBiometric()`)
  replaces re-typing the password and the Current-password field is hidden;
  otherwise the field is shown and the typed value is verified server-side.
  `PUT /auth/email` treats `currentPassword` as **optional** (bcrypt-verified
  when present, otherwise the change proceeds on the authenticated session);
  `requireAuth` + `credChangeLimiter` remain the gates and the biometric branch
  is enforced on-device (unlike the password change, email touches no E2EE key,
  so there is no unlock requirement). A passwordless account keeps the existing
  "not available yet" treatment here — its row is inert (no chevron) with a hint
  explaining why. **Password
  change lives on `PrivacyDataScreen`**, not here — it re-wraps the E2EE key and
  belongs where the unlock UI is. The route takes no params. While the
  home-address field is **empty**, it offers an opt-in **"Use my current
  location"** action (`expo-location`, foreground one-shot): device GPS +
  reverse geocoding *prefill the field only* — nothing reaches the server until
  the user reviews and saves, and an E2EE household seals the result exactly
  like a typed address. Once the field holds an address (typed or picked) the
  action is hidden as redundant. Saving a
  changed address also re-derives the household's default timezone
  (see [notifications.md](notifications.md) → Timezone stickiness) and
  preselects the home province/state on holiday calendars that have no
  regional picks yet (see [calendar.md](calendar.md) → "Holiday calendars know
  where home is").
- **`PrivacyDataScreen`** (`PrivacyData`, titled **"Privacy & security"**) — the
  encryption status hero + inline
  unlock UI, a **Sign-in** section (password change, presented as a whole-row
  tappable card that expands the change form inline — no separate "Change"
  button — matching the tappable Recovery/Transparency rows; requires the E2EE
  key unlocked so the new password can re-wrap it, so the Save button is disabled
  while locked. Re-auth is **biometric-first with a current-password fallback**:
  when this device has armed the Face ID / Touch ID key cache
  (`isDeviceKeyEnabled()`), a fresh biometric prompt (`reauthWithBiometric()`)
  replaces re-typing the current password and the change is sent with no
  `currentPassword`; otherwise the Current-password field is shown and the typed
  value is verified server-side. `PUT /auth/password` treats `currentPassword` as
  **optional** — verified with `bcrypt` when present, and when absent the change
  proceeds on the authenticated session (`requireAuth` + `credChangeLimiter`
  remain the gates). The biometric branch is enforced **on-device**, an accepted
  trade-off vs. the friction of re-typing the password; mandatory E2EE re-wrap
  still needs the unlocked key client-side, so a bare session token can't reach
  the user's data), a **Recovery methods** roll-up (recovery code + Face ID/passkey,
  each with a status badge — the non-password backstops, mirroring
  `useRecoveryHealth`), Devices
  (sessions + held-reset cancel + link-device), and data controls (an
  **Artificial intelligence** card with the `aiEnabled` / `aiUsePersonalInfo`
  toggles — see [ai-assistant.md](../features/ai-assistant.md); app lock,
  screen security, transparency note, encrypted backup). Sign-in sits **above**
  Recovery methods and password is deliberately kept **out** of that roll-up: a
  password is an everyday unlock, not a backstop, and a reset password can't
  decrypt at all — counting it as recovery would give false confidence. Deep-link param
  `{ focus?: 'unlock' | 'recovery' }`; `focus: 'unlock'` auto-presents Face ID
  when a passkey is enrolled. This is the target of the locked-data prompt.

Every account gets a recovery code by default at enrollment (issued via the
one-time `RecoveryCodeModal`); the Recovery methods roll-up surfaces its status
(backed by `useRecoveryHealth`). Its row opens a dedicated `RecoveryCodeScreen`
that explains the code — including that it is **never stored and cannot be shown
again** (only once, at creation) — and offers create / replace. Replacing
invalidates the current code and is gated behind a confirm; the new code is
surfaced by the app-root `RecoveryCodeModal`. A third method — a
household member as a **dual-control** recovery backstop (guardian's sealed box +
a 4-digit PIN) — is specified and built in
[guardian-recovery.md](guardian-recovery.md).

## Encryption boundary

Email/name and public key are server-visible; the private key is stored only as
per-factor ciphertext and every factor KEK is derived client-side. Config:
`PASSKEY_RP_ID`, `PASSKEY_ORIGINS`, `JWT_SECRET`, `RESET_COOLDOWN_HOURS`.

## Verification

- Forgot/reset lifecycle (no enumeration, hashed short-lived codes, burn-on-guess,
  expiry), passkey challenge/login/register guards, delete-account confirmation,
  and token half-life refresh — `authFlows.integration.test.js`.
- The sign-in → reset email hand-off (typed email passed as the `ForgotPassword`
  route param, seeding the reset screen; blank stays blank) —
  `mobile/src/screens/auth/__tests__/forgotPasswordEmail.test.tsx`.
- Passwordless registration and the `hasPassword` flag lifecycle —
  `passwordlessRegister.integration.test.js`.
- Session create/revoke, per-install coalescing (`X-Device-Id` replace + old
  token revoked, distinct ids stay separate, legacy no-header append), and
  new-device reset protection (hold, cancel, window elapse) —
  `sessions.integration.test.js`.
- Device linking (one-shot sealed payload, cross-account isolation, expiry,
  validation, slot replacement) — `deviceLink.integration.test.js`.
- The recovery mandate (`recoverySetupAt` unset → set, idempotent, gated on
  enrollment) — `recoveryMandate.integration.test.js`.
- Client unlock factors (password + recovery-code unlock restoring the same
  keypair, wrong-password lockout, the biometric device cache seam) —
  `mobile/src/lib/__tests__/e2ee.test.ts`.
- Screen security / app lock are exercised on-device only (no automated
  coverage yet — see Open questions).

## Open questions

- Document the exact "recovery-health guard" thresholds that force re-enrollment.
- Confirm behavior for passkeys enrolled before public-key storage (no sign-in
  until re-added).
