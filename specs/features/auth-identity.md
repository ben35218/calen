---
title: Auth & identity
status: current
last-verified: 337a313 (2026-07-24)
code:
  - mobile/src/screens/auth/
  - mobile/src/store/auth.tsx
  - server/src/routes/auth.js
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

### Sign-in paths

- **Password:** `POST /auth/login` → JWT; the client derives the KEK and unwraps
  the private key (`store/auth.tsx`).
- **Passkey:** a single Face ID assertion both signs in and unlocks E2EE.
  `POST /auth/passkey/challenge` returns each credential's `prfSalt`;
  `POST /auth/passkey/login` verifies the WebAuthn assertion; the PRF output
  derives the KEK. Passkeys are also registered as sign-in credentials
  (`/auth/passkey/register-options` + `/register`, `@simplewebauthn/server`,
  stored on `User.passkeyCredentials`).
- **Email-OTP / forgot-password:** `POST /auth/forgot` emails a 6-digit code;
  `POST /auth/reset` consumes it. A reset deliberately leaves the stale password
  envelope in place — the client re-wraps the private key after a passkey/recovery
  unlock (it cannot unwrap from a new password alone).

### New-device protection

- A password reset from an unrecognized device is **held** (`resetHoldUntil`,
  `RESET_COOLDOWN_HOURS`) and loudly announced to existing devices + email; the
  user can cancel it with `POST /auth/reset/cancel`.
- Auth endpoints are per-IP rate-limited; sessions slide via `X-Refreshed-Token`.

### Device security (screen capture & app lock)

- **Screen security** (Signal-parity A3): screenshots/recording can be blocked
  (`expo-screen-capture`) and an app-switcher `PrivacyShield` cover hides content;
  toggled by the `screenSecurity` pref (default on).
- **App lock** (A4, `useAppLock`): the app can require Face ID again after being
  backgrounded, with a configurable delay (Never / 0 / 1 / 5 min) in Sign-in &
  Security.

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
  - **Install identity:** each app install generates a random UUID on first
    launch, persists it in the keychain (`lib/deviceId.ts`), and sends it as
    `X-Device-Id` on every request (alongside the cosmetic `X-Device-Name` /
    `X-Device-Platform` labels). Like the name, it is a label/dedup key only —
    NEVER an auth factor (the revocation key stays the `sid` in the JWT).
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
  `DELETE /auth/account` (immediate full deletion).
- The JWT lives in `expo-secure-store` (`lib/secureToken.ts`); an automatic Face
  ID unlock is attempted on token-restore relaunch.

## Data & API surface

- **Model:** `User` (email, name, `passwordHash`, `identityPublicKey`,
  `wrappedPrivateKey[]` factor envelopes, `passkeyCredentials[]`, recovery/reset
  state, `sessions[]` — `{deviceId?, deviceName, platform, createdAt, lastSeenAt}`
  rows, `householdId`, `personId`), `DeviceLink`.
- **Endpoints:** `server/src/routes/auth.js`, `authPasskey.js` (mounted under
  `/api/auth`), `keys.js` (`/api/keys`).
- **Client:** `screens/auth/*` (Login, Register, ForgotPassword), `store/auth.tsx`,
  `lib/passkeys.ts`, `LinkDeviceScreen`, `AccountScreen`, `PrivacyDataScreen`.

## Profile information architecture

`ProfileHome` is an iOS-style drill-in hub. Identity and credentials are split
from encryption/recovery across two screens so neither is cluttered:

- **`AccountScreen`** (`Account`) — identity + location (header-check save),
  Reminders, Sign-in (email + password change; password change requires the
  E2EE key unlocked so it can re-wrap), Sign out, Delete account. Deep-link
  param `{ section?: 'account' | 'reminders' | 'security' }`.
- **`PrivacyDataScreen`** (`PrivacyData`) — the encryption status hero + inline
  unlock UI, a **Recovery methods** roll-up (recovery code + Face ID/passkey,
  each with a status badge — the non-password backstops, mirroring
  `useRecoveryHealth`; the password is an everyday unlock, not a recovery
  method, and a reset password can't decrypt at all), Devices
  (sessions + held-reset cancel + link-device), and data controls (app lock,
  screen security, transparency note, encrypted backup). Deep-link param
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
