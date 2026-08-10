# Calen — pre-release test plan

Everything that must be verified before the mobile app goes to public release on
the App Store. Derived from [specs/](../specs/) (the normative source),
[mobile/CLAUDE.md](../mobile/CLAUDE.md), `app.json` / `eas.json`, and the
existing automated suites.

**How to use it.** Work top to bottom by section. Each case is
`ID — action → expected`. A case fails if the observed behavior differs from the
spec, *or* if the spec is silent and the behavior is surprising (file that as a
spec gap, not just a bug). Anything marked **⛔ BLOCKER** must pass before
submission; **⚠️ RISK** items have no automated coverage at all and are the most
likely places for a regression to hide.

**This file is the source of truth; the admin portal is where it gets run.**
Import it under Quality → Test cases (or
`node src/scripts/importTestCases.js docs/PRE-RELEASE-TEST-PLAN.md --commit`),
then open a Release for the build and record a run per device. Editing a case
means editing it *here* and re-importing — the portal will not let you rewrite an
imported case, and a case deleted from this file is retired there rather than
destroyed, so its past results survive. The case **IDs are the join key**:
renaming one starts a new case and retires the old, so keep them stable. The
`⛔ BLOCKER` marker is load-bearing — it is what the portal's sign-off gate
refuses on. Mechanics: [specs/features/release-qa.md](../specs/features/release-qa.md).

---

## 0. Test strategy, environments & logistics

### 0.1 Build & environment matrix

- [ ] **ENV-01** — Test on a **native production-profile build** (`eas build --profile production`), not Expo Go. Native modules that only exist in a real build: `expo-sqlite` (replica), `expo-notifications` (local + push + background task), `expo-secure-store`, `react-native-passkeys`, `react-native-purchases`, `expo-screen-capture`, `expo-speech-recognition`, `react-native-libsodium`.
- [ ] **ENV-02** — Confirm the built binary points at the **production HTTPS API**. `app.json` `extra.apiBaseUrl` is still `http://localhost:3001` (the last-resort fallback); `eas.json` sets `EXPO_PUBLIC_API_URL=https://household-calendar-api.onrender.com` for `preview`/`production`. Verify in-app (a network call succeeds with the device off Wi-Fi/LAN) — a localhost binary would appear to work only on the dev machine's network. **⛔ BLOCKER**
- [ ] **ENV-03** — Run the pass against the **production server deploy** (not a local server), with production Mongo, SMTP, Anthropic, Vapi, Expo push, Google Places, and the RevenueCat webhook wired.
- [ ] **ENV-04** — Repeat the smoke subset (§1, §2, §7, §16) on a **TestFlight** build installed from TestFlight, not a direct EAS install — install path affects entitlements (notably passkeys, see AUTH-13).
- [ ] **ENV-05** — Verify the app runs against the deployed API version, and that `POST /household/e2ee/client-version` (client-version reporting) shows no version mismatch warnings.

### 0.2 Device matrix

Run the **full** plan on one primary device; run the smoke subset (§1, §2, §5, §7, §16, §22) on each of the rest.

- [ ] **DEV-01** — iPhone SE 3 (small screen, **Touch ID**, no Dynamic Island) — the layout floor. Every "keep the footer above the fold", sheet-height, and safe-area case lives here.
- [ ] **DEV-02** — A current Face ID iPhone (Dynamic Island, large screen).
- [ ] **DEV-03** — A device on the **oldest supported iOS** version; and one on the newest.
- [ ] **DEV-04** — **iPad.** `app.json` sets `"supportsTablet": true`, so App Review will test on iPad. Either verify every screen on iPad (split-view, rotation, sheet presentation, month grid at width) or set `supportsTablet: false` before submission. **⛔ BLOCKER — decide explicitly.**
- [ ] **DEV-05** — Android: `android.package`, permissions, and the adaptive icon are configured, but `EXPO_PUBLIC_RC_ANDROID_KEY` is **not** in `eas.json` (purchases would render "not configured"). Either exclude Android from this release or run the whole plan on Android too. **⛔ BLOCKER — decide explicitly.**
- [ ] **DEV-06** — Rotation: portrait lock is declared (`"orientation": "portrait"`); confirm no screen renders rotated on iPhone, and decide iPad behavior.

### 0.3 Conditions to vary

- [ ] **COND-01** — Network: full Wi-Fi, LTE, **Network Link Conditioner "Very Bad Network"**, and **airplane mode** (offline). Every list, form save, sync, and AI stream must degrade to a readable state, never a spinner that never resolves.
- [ ] **COND-02** — Locale/region: en-US, en-GB (day/month order, 24h clock), plus one region with a non-Latin locale to confirm no layout break.
- [ ] **COND-03** — Timezones: `America/New_York`, `America/Los_Angeles` (west-of-UTC, the event date-drift class), `Europe/Berlin` (east of UTC), `Asia/Kolkata` (half-hour offset), `UTC`, and one **DST transition** day (set the device clock forward to a spring-forward / fall-back date).
- [ ] **COND-04** — Appearance: light and dark (`userInterfaceStyle: automatic`), **Dynamic Type** at largest accessibility size, **Reduce Motion** on, **Bold Text** on.
- [ ] **COND-05** — Storage/permissions denied states for every permission (see §21).
- [ ] **COND-06** — Fresh install vs. upgrade-over-previous-build (see §26).

### 0.4 Test accounts & data (set up before starting)

- [ ] **ACC-01** — **Owner A**: unlocked (paid), owns all five add-ons, home address set, a household with a rich calendar (≥200 events incl. recurring, multi-day, all-day, attachments), meals, chores, tasks, trips, ≥100 contacts.
- [ ] **ACC-02** — **Member B**: joined A's household, on a second physical device (required for live-sync and RSVP tests).
- [ ] **ACC-03** — **Collaborator C**: separate household, holds a `full`-access outside share of one of A's calendars.
- [ ] **ACC-04** — **View-only collaborator D**: `view` access on the same calendar (used for the 403 enforcement tests).
- [ ] **ACC-05** — **Free viewer V**: signed in, **no** app unlock, only a shared calendar from A.
- [ ] **ACC-06** — **Non-account invitee**: an email address with no Calen account (for the composed-email/`.ics` path), and a phone number with no account (SMS path).
- [ ] **ACC-07** — **Admin account** (role `admin`) for the portal-side checks and the tester escape hatches.
- [ ] **ACC-08** — **Fresh account** minted during the pass (never used) for the first-run/onboarding path.
- [ ] **ACC-09** — Apple **sandbox tester** Apple IDs: at least two (one for purchase, one for the Restore/TRANSFER test), plus one for the AI-plan subscription lifecycle.

### 0.5 Automated gates (run first — a red gate stops the manual pass)

- [ ] **AUTO-01** — `npm test` at repo root (server + `shared/{crypto,calendar,weather}` + mobile) is green.
- [ ] **AUTO-02** — `node scripts/check-spec-sync.mjs --base main` reports no drift.
- [ ] **AUTO-03** — Mobile typecheck / lint clean (`tsc --noEmit` in `mobile/`).
- [ ] **AUTO-04** — Record which specs' **Verification** sections claim coverage that does not exist yet, and treat those areas as manual-only (see §27.2).

---

## 1. First-run & onboarding

Spec: [onboarding.md](../specs/features/onboarding.md)

- [ ] **ONB-01** — Fresh install → register → the onboarding screen appears **once**, before the paywall.
- [ ] **ONB-02** — The screen names Meals, Home & chores, Trips, Contacts, and the Calen assistant; says they live under **Calendars** at the top of the calendar; and states content is end-to-end encrypted.
- [ ] **ONB-03** — **Get started** dismisses it; relaunch goes straight to the paywall/app, no flash of onboarding.
- [ ] **ONB-04** — Delete + reinstall → onboarding shows again (the flag is per-install, not synced).
- [ ] **ONB-05** — Signed out, the auth stack is never gated by onboarding.
- [ ] **ONB-06** — The splash holds until the onboarding flag, unlock cache, viewer cache, **and** calendar-prefs cache resolve — the first calendar frame carries the user's colours, never the app defaults recoloured a beat later.
- [ ] **ONB-07** — With a dead network on a device that has **nothing cached**, the splash releases within ~2s (the cap) rather than hanging.
- [ ] **ONB-08** — The mandatory recovery-code modal renders **over** onboarding after registration (§2.2).

---

## 2. Authentication & identity

Spec: [auth-identity.md](../specs/features/auth-identity.md)

### 2.1 Registration

- [ ] **AUTH-01** — Password registration creates the account, seeds default categories, provisions the E2EE identity, and lands in the app.
- [ ] **AUTH-02** — The register screen **forewarns** that a one-time recovery-code step follows, before submit.
- [ ] **AUTH-03** — Passkey-first registration ("Create account with a passkey") succeeds on a build with the associated-domains entitlement.
- [ ] **AUTH-04** — Passkey ceremony cancelled/failed → the just-created account is **rolled back** and the user returns to a clean register screen (no stranded passwordless account). Confirm by attempting to sign in with that email afterward — it must not exist.
- [ ] **AUTH-05** — On a TestFlight/beta build the passkey failure alert **names** the entitlement limitation and points to the password path.
- [ ] **AUTH-06** — Registration sends the `welcome` email (check the admin EmailLog).
- [ ] **AUTH-07** — Registration grants the **starter credits** (default 100) exactly once (ledger `starter:<userId>`).
- [ ] **AUTH-08** — Duplicate email registration is rejected without leaking whether the address exists elsewhere in the flow.
- [ ] **AUTH-09** — Email/password validation: malformed email, short password, whitespace-only name.
- [ ] **AUTH-10** — First/Last name fields capitalize as words and offer QuickType given/family-name autofill.

### 2.2 Recovery-code mandate

- [ ] **AUTH-11** — The one-time `RecoveryCodeModal` appears after registration and cannot be skipped away permanently.
- [ ] **AUTH-12** — **Force-quit the app while the modal is showing** → relaunch: the account still unlocks with the password, nothing was dropped to encrypted-only, and a **freshly minted** code is re-surfaced (at most once per session). The old unsaved code no longer works.
- [ ] **AUTH-13** — The code is displayed via the shared `SecurityCode` grid (groups never split across a line), copyable, and the screen states it is **never stored and cannot be shown again**.
- [ ] **AUTH-14** — Confirm re-entry of the code → `recoverySetupAt` is set; born-encrypted activation then drops the plaintext fallback on the next unlock.

### 2.3 Sign-in paths

- [ ] **AUTH-15** — Password sign-in unlocks the vault; the app mounts **already unlocked** (never a flash of the locked/viewer state) — the E2EE enroll completes before the navigator gate flips. **⚠️ RISK — this was a recent fix; re-test on a slow device where Argon2 is slowest.**
- [ ] **AUTH-16** — **Usernameless passkey sign-in** (email field empty) → OS account picker → signed in; E2EE unlocks post-auth via the biometric device-key cache, prompting for a second Face ID **only** when the cache is cold.
- [ ] **AUTH-17** — **Username-first passkey sign-in** (email typed) → one Face ID gesture both signs in and unlocks (PRF-derived KEK).
- [ ] **AUTH-18** — Wrong password → clear error, no lockout on first attempts; repeated wrong attempts hit the client's wrong-password lockout and the per-IP rate limit (429 handled gracefully, not a crash).
- [ ] **AUTH-19** — Relaunch with a stored token → automatic Face ID unlock attempt; declining it leaves the app usable but locked, with the red "!" badge on the calendar avatar.
- [ ] **AUTH-20** — Sliding session: after a long session, an `X-Refreshed-Token` swap happens transparently (no forced sign-out mid-use).

### 2.4 Forgot password / reset & new-device hold

- [ ] **AUTH-21** — "Forgot password?" carries the email already typed on the sign-in form into the reset screen; blank stays blank; the field stays editable until a code is sent.
- [ ] **AUTH-22** — `forgot` never reveals whether an address exists (identical response either way).
- [ ] **AUTH-23** — The 6-digit code is short-lived, burns on a wrong guess, and expires.
- [ ] **AUTH-24** — Reset from an **unrecognized** device → the reset is **held** (`RESET_COOLDOWN_HOURS`), existing devices + email are loudly alerted, and `POST /auth/reset/cancel` cancels it from an alerted device.
- [ ] **AUTH-25** — Reset from a device that is **signed in** to the account → applies immediately.
- [ ] **AUTH-26** — Reset from a device that **previously signed in and then signed out** (its `X-Device-Id` session row survives) → applies immediately, no hold.
- [ ] **AUTH-27** — After explicitly removing that device in Sign-in & Security, the same reset **is** held again.
- [ ] **AUTH-28** — **After a reset, the vault is still locked** and the UI says so plainly. It must **never** offer "sign in again" as the fix. An unlocked-app user is steered to Privacy & data; a locked **free viewer** lands on the viewer `ViewerUnlock` route (§6.4). **⛔ BLOCKER — this is the dead-end loop the whole flow exists to end.**

### 2.5 Sessions, devices & device link

- [ ] **AUTH-29** — `GET /auth/sessions` lists **physical devices**, not a history of sign-ins: signing in twice on the same install **replaces** the row (fresh `sid`, original `createdAt`, updated `lastSeenAt`), and the install's previous token is revoked (confirm the other-token 401 on the old build if you can reproduce it).
- [ ] **AUTH-30** — Two distinct installs produce two rows; the list caps at `MAX_SESSIONS`, dropping the least-recently-seen.
- [ ] **AUTH-31** — Deleting a session row revokes that JWT — the affected device is signed out on its next request.
- [ ] **AUTH-32** — **New-device alert** fires on a sign-in from an unseen `X-Device-Id`, and does **not** coalesce two devices that share a name ("iPhone").
- [ ] **AUTH-33** — **Device link**: `LinkDeviceScreen` on device 1 → QR/scan on device 2 → device 2 holds the identity key without a password round-trip. The link is one-shot (a replay fails), expires, and is cross-account isolated.
- [ ] **AUTH-34** — Linking a new device fires the security alert to the household.

### 2.6 Account self-service

- [ ] **AUTH-35** — Account screen is flat (no expand/collapse sections): Account card → (Invites → Email app row, only when 2+ mail apps installed) → Delete account. Reminders is a **separate** screen off the profile hub.
- [ ] **AUTH-36** — Email sits **directly above** phone. Tapping the whole email row reveals the inline change form (chevron indicates state).
- [ ] **AUTH-37** — Email change with the biometric cache armed → a fresh Face ID replaces the current-password field. Without it → the field shows and a wrong password is rejected server-side.
- [ ] **AUTH-38** — A passwordless account's email row is inert with an explanatory hint.
- [ ] **AUTH-39** — **Password change lives on Privacy & security**, not Account; its Save is disabled while the vault is locked (the change must re-wrap the key).
- [ ] **AUTH-40** — Password change re-wraps the E2EE key: after changing, sign out, sign in with the **new** password → data still decrypts. **⛔ BLOCKER (data-loss class).**
- [ ] **AUTH-41** — Phone field uses the shared `PhoneField` (country picker, as-you-type) and stores canonical E.164 — verify by using that number to resolve a household invite (§4.1).
- [ ] **AUTH-42** — Home address: while empty, the **"Use my current location"** action shows; it prefills the field only (nothing reaches the server until save); once an address is set the action is hidden.
- [ ] **AUTH-43** — Saving a changed address re-derives the household timezone, fills `homeCity` (coarse area), preselects the home province/state on holiday calendars that have no regional picks, and invalidates the weather queries so the Weather screen behind Account refreshes.
- [ ] **AUTH-44** — Unsaved-changes guard on the Account form (header ✕, back chevron, swipe-back, Android back all prompt "Discard Changes?").

### 2.7 Account deletion

- [ ] **AUTH-45** — With an **active Calen AI plan**, deletion interposes the keep-billing warning first, offering Manage subscription / Delete anyway / Cancel. **⛔ BLOCKER (App Review 5.1.1(v) + billing honesty).**
- [ ] **AUTH-46** — With billing status unavailable (offline), deletion still proceeds to the plain confirm — deletion is never blocked on a billing read.
- [ ] **AUTH-47** — The destructive confirm names the **forfeited credit balance** when positive.
- [ ] **AUTH-48** — Deletion purges the account and its data; the `account_deleted` email is sent **before** the purge and carries the cancel-in-Apple-settings reminder when the plan was active.
- [ ] **AUTH-49** — With `REVENUECAT_SECRET_API_KEY` set, the RC subscriber is purged best-effort; without it, deletion still succeeds.
- [ ] **AUTH-50** — After deletion, a RevenueCat webhook keyed to the dead id is acked (`matched:false`), and a **re-signup + Restore** re-grants the unlock (deleted-losing-id TRANSFER rule).

### 2.8 Sign-out teardown (data-leak class)

- [ ] **AUTH-51** — Sign out from **ProfileHome** (the danger button below the section menu, above the legal links).
- [ ] **AUTH-52** — Sign out then sign in as a **different account on the same device**. Verify every store was wiped: no previous account's calendar list, colours, order, hidden set, outside-share addresses; no previous replica rows; no owned-add-on carry-over; the record-sync cursor was reset (the new account's records actually arrive). **⛔ BLOCKER (privacy + the "No shared calendars yet" class of bug).**
- [ ] **AUTH-53** — Sign-out best-effort **unregisters the push token**: the signed-out device stops receiving the account's pushes (verify by sending an invite to that account).
- [ ] **AUTH-54** — Sign out → sign back in as the **same** account **without relaunching**: the app must not deadlock on the splash (the unlock/viewer caches reset to a known `false`, not `null`).
- [ ] **AUTH-55** — After sign-in, the previously-signed-out account's calendar arrangement (colours/order/hidden/deleted/muted) is restored from the **account**, not lost.

---

## 3. End-to-end encryption, keys & recovery

Specs: [crypto-e2ee.md](../specs/platform/crypto-e2ee.md), [guardian-recovery.md](../specs/features/guardian-recovery.md)

- [ ] **E2E-01** — A brand-new household is **born encrypted**: it activates automatically on the owner's next key unlock; HouseholdScreen's badge reads "Finishing encryption setup…" while pending and "End-to-end encrypted" once `e2eeActive` — never hard-coded to success.
- [ ] **E2E-02** — Every content write is sealed. Spot-check via the admin portal / DB that a newly created event's `Record` row carries only routing fields and ciphertext (no title, no `calendarType`, no `userId` on an active household).
- [ ] **E2E-03** — Attachments are sealed **on-device before upload**; with the session key not loaded, an upload is **refused with an unlock prompt**, never falling back to plaintext.
- [ ] **E2E-04** — Locked vault: the app lists previously-synced rows but cannot seal new content; every write surfaces an unlock message (test: RSVP to an event, save a contact, upload an attachment).
- [ ] **E2E-05** — **Key rotation on member removal**: owner removes B → the next member unlock mints HDK v(N+1) and re-seals to remaining members; B's device can no longer read new content.
- [ ] **E2E-06** — Old versions stay readable for historical records until retirement; after `reseal-all` + retire, the removed member's keys open nothing.
- [ ] **E2E-07** — **Safety numbers**: verify a member → status sticks; simulate a key change (member re-keys) → status flips to **changed** and prompts re-verification; both sides render the identical `SecurityCode` grid.
- [ ] **E2E-08** — **Re-key (`POST /keys/rekey`)** on an account holding records → `409 confirm_data_loss` first, with the record count; only a repeat call with `confirmDataLoss: true` proceeds. A **pure viewer** (no unlock, no own calendar) is pre-confirmed and never sees the scare. **⛔ BLOCKER.**
- [ ] **E2E-09** — After a re-key: the caller's HDK + resource envelopes are deleted, every calendar seat is stamped `keyChangedAt`, `recoverySetupAt` is cleared (recovery modal re-runs), any armed guardian is dropped, `key_rekeyed` is audited, and the household is alerted that the safety number changed.
- [ ] **E2E-10** — The re-keyed collaborator is **excluded from the owner's automatic wrap** — the owner's next unlock must NOT silently re-grant access. Access returns only via request → owner approve. **⛔ BLOCKER (mailbox-takeover class).**
- [ ] **E2E-11** — Re-key with a **held session password** (right after a reset or a failed-unlock sign-in) fires straight off the button, no sheet. With nothing held (a later relaunch), the sheet asks, and its copy frames the password as the new key, not an identity check.
- [ ] **E2E-12** — `rekeyIdentity` with neither a typed nor a held password **throws** rather than minting an identity nobody can open.
- [ ] **E2E-13** — **Join carry-over**: B creates records in their own solo household, then joins A's household. On B's next unlock, those records migrate (same `_id`), appear for A, and the emptied household is drained/reaped. Idempotent across repeated unlocks.
- [ ] **E2E-14** — During/after a join, **sync does not wedge**: a foreign row from the old household is skipped without parking the cursor; both members' calendars converge. **⛔ BLOCKER (both-devices-stuck class).**
- [ ] **E2E-15** — A household change (join/leave/removal) under a **live session** wipes the replica, cursor, calendar prefs, and owned add-ons — the departing member can no longer read the old household's calendar/meals/tasks on their phone. **⛔ BLOCKER (privacy).**
- [ ] **E2E-16** — Sync cursor safety: with the app killed mid-unlock, a row the session couldn't decrypt **parks** the cursor; once the key loads, `subscribeKeysReady` re-pulls and the content appears without a manual mutation.
- [ ] **E2E-17** — **Guardian recovery — arm**: requires an unlocked vault, a current household member as guardian, safety-number verification, and a 4-digit PIN with confirm; trivial PINs (`0000`, `1234`, repeats/sequences) are rejected. Copy states "only pick someone you'd trust to see your data". **⚠️ RISK — the `/keys/guardian*` routes have NO server integration suite.**
- [ ] **E2E-18** — **Guardian recovery — recover**: from a locked device, request → guardian sees the prompt + push, compares the **ephemeral key's fingerprint out of band**, approves → requester enters the PIN → the original identity key is restored (public key unchanged, HDK envelope still opens, no re-key needed).
- [ ] **E2E-19** — Wrong PIN fails **without burning the slot**; a wrong device / wrong guardian cannot complete; recovery attempts are rate-limited (5/10 min) and alert the user on each.
- [ ] **E2E-20** — After recovery the app prompts to **enrol fresh factors** (new password / recovery code).
- [ ] **E2E-21** — Disarm deletes the envelope and cancels in-flight requests. A guardian who has **left the household** cannot be used (request is refused).
- [ ] **E2E-22** — Recovery-code unlock: sign in on a fresh device, unlock with the recovery code → the exact same keypair is restored, data decrypts.
- [ ] **E2E-23** — Factor add/remove (`PUT/DELETE /keys/factors`) re-wraps only the private key; other factors keep working; a security alert fires each time.
- [ ] **E2E-24** — **Lose every factor with no guardian** → the app says the data is unrecoverable and offers the re-key access path; it must never imply support can recover it.

---

## 4. Household & sharing

Spec: [households-sharing.md](../specs/features/households-sharing.md)

### 4.1 Invitations

- [ ] **HH-01** — Invite by email a person **without** a Calen account → the invitation row is created and the **mail-app chooser** opens; with 0 detected apps it falls back to `mailto:`, with 1 that app opens directly, with 2+ the "Send invite with" sheet lists them plus **Copy invite message**.
- [ ] **HH-02** — Each mail app opens via its own compose deep link with To/subject/body prefilled (verify Gmail, Outlook, Apple Mail if installed).
- [ ] **HH-03** — The first pick is remembered silently; future invites open that app directly; the preference is visible + changeable on Account → Email app (only when 2+ apps installed), including "Ask each time".
- [ ] **HH-04** — A **remembered app that has been uninstalled** falls back to the chooser.
- [ ] **HH-05** — Dismissing the chooser composes nothing and is **not** an error; the invitation row already exists and the screen's note says the message still needs sending.
- [ ] **HH-06** — Invite an address that **already has an account** → **no composer opens**; the screen confirms it's in their Invitations inbox and their devices were notified; the recipient gets a **push** and an inbox row.
- [ ] **HH-07** — Invite by **phone** → `sms:` composer; the number is canonicalized to **E.164** so it matches the recipient's saved `User.phone` (verify the recipient actually sees the invite in-app).
- [ ] **HH-08** — Invite-from-contacts autocomplete: typing matches the decrypted roster by name/email/phone digits, capped at 5, excluding current members, already-invited people, and yourself. Tapping a suggestion invites the primary email (else E.164 phone) with no retyping.
- [ ] **HH-09** — **Remind** (paper-plane) on a pending row re-opens the composer **regardless** of account status.
- [ ] **HH-10** — Duplicate invite to the same address is guarded; re-inviting a **declined** person reopens the row.

### 4.2 Join, approve, notices

- [ ] **HH-11** — The invitee sees the invite in **two** places: the Invitations inbox and the top of HouseholdScreen ("You've been invited" card with Accept/Decline).
- [ ] **HH-12** — Accepting creates a **JoinRequest** — it does **not** grant membership.
- [ ] **HH-13** — The joiner's "Waiting for approval" card shows **their own** safety code, and the approver's prompt points at it.
- [ ] **HH-14** — Pending requests appear on **both** HouseholdScreen and the Invitations inbox; the inbox polls every 5s so a request arriving while it's open appears without a refresh.
- [ ] **HH-15** — Approve → the HDK is wrapped to the joiner on-device; the joiner is notified **twice** (push + a persisted `approved` notice carrying the approver's first name, never the household name) and is **excluded** from the household-wide "new member" alert.
- [ ] **HH-16** — Reject → the join request is rejected **and** the invitation is retired to `declined`; it drops off the inviter's card immediately on both surfaces and reads "Declined" in the rejected person's inbox.
- [ ] **HH-17** — Cancel-my-request (`DELETE /household/join-requests/mine`) works from the joiner's side.
- [ ] **HH-18** — After approval the joiner's device **carries over** their stranded records (§E2E-13) and their **purchased add-ons follow them** (union across members).

### 4.3 Membership changes

- [ ] **HH-19** — Owner removes a member → the removed user gets a push + a persisted `removed` notice in their inbox; they land in a fresh solo household, activated born-encrypted.
- [ ] **HH-20** — **Sole member** = leave is a no-op: the "Leave household" action is **hidden** when `members.length <= 1`, and the endpoint returns the existing household unchanged. **⛔ BLOCKER (this previously orphaned every record).**
- [ ] **HH-21** — Leaving a shared household hands the data to the remaining members, and the leaver's device no longer shows it (§E2E-15).
- [ ] **HH-22** — Both notice kinds count toward the Invitations badge (calendar avatar → Profile's Invitations row → the inbox), and the badge exactly mirrors the inbox's "New" filter (invitations + join requests + notices + unacknowledged call outcomes).
- [ ] **HH-23** — The avatar badge precedence: the red **"!"** (encrypted data locked) beats the pending count; never both.
- [ ] **HH-24** — Security alerts fire for factor add/remove, member join/leave, key rotation, and new device sign-in.
- [ ] **HH-25** — The household **name is sealed** — confirm the server/admin surfaces identify households by **id**, never by name.

### 4.4 Re-key access requests

- [ ] **HH-26** — A re-keyed collaborator's "Request access" surfaces under `reapprovals` in the owner's Invitations inbox (and its badge), carrying the requester's **new** identity public key for out-of-band safety-number comparison.
- [ ] **HH-27** — Approve writes the wrap and clears both stamps **after** the envelope lands; a failed write leaves the request standing.
- [ ] **HH-28** — There is no "reject" — doing nothing grants nothing.
- [ ] **HH-29** — The requester's pending state **survives sign-out**: signing out and back in returns them to the "Request sent" confirmation, not a blank calendar.
- [ ] **HH-30** — Accepting an invitation **preserves** the suppression (a re-keyed account cannot clear its own suppression by re-accepting).

---

## 5. Billing: unlock, credits, plan, add-ons

Spec: [billing-plans.md](../specs/features/billing-plans.md). Use **sandbox** Apple IDs.

### 5.1 The hard paywall

- [ ] **BILL-01** — A signed-in, locked, non-admin user with **no** viewer content gets the full-screen paywall instead of the app.
- [ ] **BILL-02** — The offer block has **exactly one** filled control: the price appears **once**, on the CTA (`Unlock Calen — $X.XX`); terms sit under it as muted micro-copy. **Restore purchase** is a text link in the Terms/Privacy row; **Sign out** is a quiet muted link. Assert exactly one `Button` primitive renders. **⛔ BLOCKER (App Review 3.1.1 / 5.2.5).**
- [ ] **BILL-03** — Terms of Use and Privacy Policy links open working pages.
- [ ] **BILL-04** — Buy → the sandbox purchase completes → the client polls `/billing/status` until `unlocked` flips (3s/45s) → the app opens. A poll timeout shows the reassuring copy, not an error.
- [ ] **BILL-05** — **Restore Purchases** on a second install of the same Apple ID re-grants the unlock; Restore disappears from the link row once activation reports `active`.
- [ ] **BILL-06** — **Restore under a different account** (TRANSFER) moves the unlock from the losing user to the gaining one.
- [ ] **BILL-07** — Refund the sandbox purchase (`CANCELLATION` + `CUSTOMER_SUPPORT`) → the unlock is revoked → the user drops back to the paywall (or the viewer shell if shares remain).
- [ ] **BILL-08** — The unlock state is mirrored on-device, so an unlocked user opens the app **offline**. Unknown + uncached reads as **locked**.
- [ ] **BILL-09** — Sign-out clears the unlock cache — another account on the device cannot inherit it.
- [ ] **BILL-10** — The gate is skipped when RC isn't configured (dev builds) and for `admin`-role accounts; the admin override `POST /monetization-config/unlock` works and is audited.

### 5.2 AI credits

- [ ] **BILL-11** — Credits screen: balance hero, low/out badges, plan card, pack store, "What things cost", "Where your credits go", History (≤5 rows) + "See all history".
- [ ] **BILL-12** — Pack store: select-then-confirm, one tile per catalog pack in catalog order, localized store price (USD fallback until RC loads), CTA restating the selection, "credits never expire" footer, ribbon strips (`+N%` / `BEST VALUE`) computed from the catalog, with the best-value pack pre-selected and every tile reserving the strip height.
- [ ] **BILL-13** — Buying a pack credits the balance exactly once; **re-delivering the same transaction id does not double-credit**.
- [ ] **BILL-14** — A refund debits the same amount and **may drive the balance negative**; the display floors at 0 with an arrears note, and new credits top up the hole first.
- [ ] **BILL-15** — The **rate card** pins the token-priced **chat row first** ("Varies with length"), sorts flat rows ascending from live server values, pins the per-minute **call** row last, and shows **no web-search row**.
- [ ] **BILL-16** — Action labels are truthful: `scan` = "Photo scan", `generation` = "Recipe generation", `manualParse` = "Owner's manual parsing".
- [ ] **BILL-17** — A chat turn debits **whole credits** sized to the turn's tokens; the reply shows "N credit(s)" underneath, never raw tokens. A long, cache-heavy calendar turn should land in the **single digits**, not 50–70. **⚠️ RISK — verify against real usage.**
- [ ] **BILL-18** — A web search inside a chat turn adds **no separate charge**.
- [ ] **BILL-19** — Flat-priced actions debit once per completed action regardless of how many model calls it made: photo scan (3), recipe generation (3), manual parse (40), form-assist (1).
- [ ] **BILL-20** — A plain manual **upload** or **save-from-URL** debits **nothing** (no AI ran).
- [ ] **BILL-21** — Phone calls debit per connected second at `callPerMinute`; placement pre-checks **one minute** of cost; a call already metered is not re-charged.
- [ ] **BILL-22** — Exhausted balance → `402 CREDITS_EXHAUSTED` → the **QuotaBlockedNotice** wall with a "Buy credits" CTA opening `BuyCredits { reason: 'out' }`. The last call may overdraw slightly; the **next** one is blocked.
- [ ] **BILL-23** — Low balance → the **CreditsBanner** informs inside the assistants; it never blocks. Nothing shows for unlimited admins or healthy balances.
- [ ] **BILL-24** — "Where your credits go" reports credits **spent** per feature this week, biggest-first, with a total; hidden when nothing was spent.
- [ ] **BILL-25** — History shows **purchases & grants only** (no usage debits); "See all history" opens `CreditHistory` instantly from the warm cache, month-grouped, pull-to-refresh, with an empty state.
- [ ] **BILL-26** — After a purchase lands, the History card shows the new grant immediately (the activation poll invalidates the ledger query).
- [ ] **BILL-27** — Admin `unlimited: true` renders "Unlimited" instead of a balance and hides the pack store and plan card.

### 5.3 The Calen AI plan

- [ ] **BILL-28** — Subscribe (sandbox) → `INITIAL_PURCHASE` grants `monthlyCredits`; the poll completes only when the plan is active **AND** the balance has risen (never freezing a stale pre-credit balance).
- [ ] **BILL-29** — A renewal grants again, idempotently on the new transaction id.
- [ ] **BILL-30** — Three card states render correctly: **renewing** ("renews with N credits on ⟨date⟩"), **cancelled** (auto-renew off — "benefits until ⟨date⟩, credits yours forever"), **inactive** (subscribe CTA + "more credits per dollar than any pack").
- [ ] **BILL-31** — With RC unavailable (offline/dev), the card degrades to the server base — a false "cancelled" is never shown.
- [ ] **BILL-32** — **Manage subscription** opens the native sheet; the fallback chain (`managementURL` → Apple subscriptions URL) works when it can't.
- [ ] **BILL-33** — Returning from the manage sheet refetches RC + billing on focus/foreground, so a cancel/re-subscribe reflects without an app restart.
- [ ] **BILL-34** — `EXPIRATION` deactivates but **keeps** granted credits; a refund claws that period's grant back.

### 5.4 Feature-calendar add-ons

- [ ] **BILL-35** — The store screen is titled **"Add-ons"** (never "App Store") and shows Restore Purchases + Terms/Privacy near the CTAs. **⛔ BLOCKER (App Review 5.2.5).**
- [ ] **BILL-36** — The **"Included free"** section renders **first** (Occasions, Chores), above the bundle and paid cards; ordering is state-stable (a claimed card stays put as "Added").
- [ ] **BILL-37** — Claiming a free add-on is instant (no webhook gap), idempotent, and works for a **solo user with no household**.
- [ ] **BILL-38** — A paid key can never be claimed for free (server validates against catalog price 0).
- [ ] **BILL-39** — Buying a paid add-on unlocks its lane household-wide (union across members) — verify on **B's** device, not just A's.
- [ ] **BILL-40** — The **bundle** CTA is hidden once any single **paid** add-on is owned; claimed free add-ons don't count.
- [ ] **BILL-41** — An owned add-on whose calendar this device **locally deleted** shows an accent-tinted `+` restore affordance (not the green check); restoring is device-local and returns the card to the check state.
- [ ] **BILL-42** — Buying/claiming an add-on **repaints the month grid immediately** — the previously-zeroed lanes fill without waiting for an unrelated invalidation. **⛔ BLOCKER (embedded-snapshot class).**
- [ ] **BILL-43** — Locking never deletes data: revoke the add-on (admin override), confirm the lane empties; re-grant it, confirm the data **and** the prior visibility/colour/order prefs reappear.
- [ ] **BILL-44** — Every locked feature home (Kitchen, Maintenance, Trips, Chores, Occasions) shows `AddonLockedView`, including via deep link and restored nav state; free ones say "Add for free".
- [ ] **BILL-45** — Locked features are excluded at the data chokepoint everywhere at once: month grid, day/agenda/list, **search**, **print checklist**, **Colours & Order list**, the Add-Calendar **restore-deleted list**, **reminder scheduling**, and **assistant reads**.
- [ ] **BILL-46** — A member who purchased add-ons **leaves** the household → they keep their add-ons in the new solo household (per-user ownership). **⛔ BLOCKER (this previously stripped paid entitlements silently).**
- [ ] **BILL-47** — `scripts/backfillUserAddons.js` has been run **before** the deploy (dry-run first; decide `--paid-to-owner` vs default). Deploying first strips every customer's add-ons. **⛔ BLOCKER — ops sequencing.**

---

## 6. Free viewer mode

Spec: [billing-plans.md](../specs/features/billing-plans.md) → "Free viewer mode". Use account **V**.

- [ ] **VIEW-01** — A locked, non-admin user with ≥1 accepted collaboration or ≥1 pending calendar invitation gets the **viewer shell**, not the paywall. A locked user with none gets the paywall unchanged.
- [ ] **VIEW-02** — A **brand-new invitee's first ever registration** lands in the shell with the shared calendar visible — never stranded on the restore-access screen showing "Nothing shared with you yet" while the invite sits pending. **⛔ BLOCKER (recent race fix; retest on a slow device).**
- [ ] **VIEW-03** — Pending shares **auto-accept** on shell entry and every focus; there is no Invitations inbox and no Accept/Decline in the shell.
- [ ] **VIEW-04** — A freshly accepted share shows the per-calendar "events appear the next time its owner opens Calen" hint until the owner's next unlocked session wraps the key. Then the events appear with no owner-facing prompt.
- [ ] **VIEW-05** — **Grid layer** (default): unbounded month window, month blocks, month/year jump sheet, **today anchor** (opens on today and stays pinned through re-measures until the viewer drags or jumps), labelled chips (≤3 + "+N more") and multi-day span bars. A chip/bar opens the event; a day opens that day's list in a sheet.
- [ ] **VIEW-06** — The shell shows **only `mine:false` calendars' events** — no chores, tasks, meals, trips, occasions, holidays, weather; no create/edit anywhere.
- [ ] **VIEW-07** — **List layer**: day-grouped 56-day agenda with the app's "Today" marker; today always gets a section; `Today` scrolls to it even when empty.
- [ ] **VIEW-08** — Layer choice persists per device (`hc_viewer_view`, grid default); both layers stay mounted, crossfade in place, and keep their scroll positions.
- [ ] **VIEW-09** — Chrome: month/year jump label leading in the top row; one trailing pill with a **fixed** overflow glyph opening a menu (Calendar ✓ / List / Print / Sign out); a persistent bottom **upgrade banner** with no price; Today floating above it.
- [ ] **VIEW-10** — **Print** is a modal with a ✕; its checklist is built from the **shared calendars alone** and the viewer's own lanes are empty in the output.
- [ ] **VIEW-11** — The pushed `UnlockPaywall` route renders **identically** to the gate's full-screen paywall (transparent, title-less header) — only the floating back button differs; no top-inset drift between the two mounts.
- [ ] **VIEW-12** — Buying the unlock from the shell flips to the full app; refunding flips back to the shell (if shares remain) or the paywall.
- [ ] **VIEW-13** — The **on-device reminder scheduler runs for viewers** (shared-event alerts fire).
- [ ] **VIEW-14** — Server-side, a `view` collaborator's write is **403'd** at `/records` (test D: attempt an edit via any path).

### 6.4 Viewer restore-access screen (`ViewerUnlock`)

- [ ] **VIEW-15** — A locked viewer **opens on** this screen (it is the shell), swipe-back off. Reaching it from an already-open shell pushes normally with a back chevron.
- [ ] **VIEW-16** — Reading order: lock disc → plain-language headline ("This calendar is locked" / "Your shared calendars are locked", correct singular/plural) which **is** the ⓘ label (whole row tappable, words optically centred) → the shared calendars by name in a bare card → "How to get back in".
- [ ] **VIEW-17** — **No route name anywhere** (empty nav title, no body heading) and **no upgrade banner** on the options screen.
- [ ] **VIEW-18** — Exactly **one filled primary** button — the best path that can actually work (passkey, else password, else request access); everything else is ghost or a text link.
- [ ] **VIEW-19** — All typing happens in a **BottomSheet** (password, recovery code), one field / one button / its own inline error; stale errors clear on every sheet open and close.
- [ ] **VIEW-20** — The password option shows **only** when `e2eePasswordStale !== true` — after a reset it must be absent (offering it would be the dead-end loop).
- [ ] **VIEW-21** — Button label is **"Unlock with passkey"**, never "with Face ID".
- [ ] **VIEW-22** — "Request access" re-keys **once** and asks every owner (never one button per calendar). With a held session password it fires straight off the button with an in-place spinner.
- [ ] **VIEW-23** — The request-sent state is **terminal**: one centred column, **no "Back to calendar"**, the upgrade banner **is** present here, and Sign out is at the foot.
- [ ] **VIEW-24** — It survives a sign-out (server-side seat stamps) and polls every 15s; the owner's approval sends the viewer on to `ViewerHome` — and the exit never fires on a first paint whose list hasn't loaded.
- [ ] **VIEW-25** — While the hand-off to `ViewerUnlock` is in flight, **nothing calendar-shaped paints** — no empty month flashing the sync note.
- [ ] **VIEW-26** — **Self-heal**: if the session turns out to be unlocked while this screen shows (no action of its own in flight, not in the request-sent state), it loads the shared CalendarKeys and leaves for the calendar on its own, exactly once.
- [ ] **VIEW-27** — Sign out from this screen works (it is the only exit when the screen is the whole shell).

---

## 7. Calendar — events

Spec: [calendar.md](../specs/features/calendar.md)

### 7.1 Create / edit / delete

- [ ] **CAL-01** — **New Event** opens with the Title field focused and the keyboard up; **Edit Event** does not steal focus; an assistant-prefilled create does not either.
- [ ] **CAL-02** — Title capitalizes as sentences (keyboard opens shifted).
- [ ] **CAL-03** — An event requires a `calendarType`; the calendar picker lists built-ins + custom calendars, and the "Add calendar" flow mints `custom-<slug>` ids on-device.
- [ ] **CAL-04** — All fields round-trip: title, description, location, url, phone (E.164), start/end, all-day, calendar, alerts, travel, recurrence, invitees, attachments.
- [ ] **CAL-05** — **Discard-changes guard** on the event form and on Invitees, Location, Add/Subscribe Calendar, Occasion Alerts, and E-Card screens — via header ✕, back chevron, swipe-back, and Android back. A successful save/delete exits without prompting. Read-only guest/collaborator views never prompt.
- [ ] **CAL-06** — Delete a one-off event → single-action confirm ("Delete Event").
- [ ] **CAL-07** — Every calendar surface repaints **immediately** after a save (grid, day view, list, search) with no whole-grid reload or skeleton flash.

### 7.2 Starts / Ends (the duration rule) — **⛔ high-regression area**

- [ ] **CAL-08** — The date/time sheet **commits the wheel's current value on any dismissal**: Done, backdrop tap, and grabber drag-down all accept it. There is no discard-on-tap-away.
- [ ] **CAL-09** — Editing the **start** always carries the end with it, in **both** directions, preserving duration: 9–10am → start 8am gives 8–9am; start 2pm gives 2–3pm.
- [ ] **CAL-10** — A shifted end crossing midnight rolls its **date** to the next day; landing back on the start's day folds the End date away.
- [ ] **CAL-11** — Editing the **end** changes the duration (start stays put) — except an end at/before the start drags the start back by the same amount (8–9am → end 4am gives 3–4am; the start's date rolls back over midnight).
- [ ] **CAL-12** — The end can **never** be left before the start, whichever field is touched, on the event form **and** on trip, trip-item/journey, and cancel/reschedule windows.
- [ ] **CAL-13** — **Timezone round-trip (west of UTC).** Set the device to `America/Los_Angeles`. Create a timed event at **11:05pm**. Open it → save → open → save, five times. The date must **not** step forward a day, and the event must not read as multi-day. Repeat in `Europe/Berlin` and `Asia/Kolkata`. **⛔ BLOCKER.**
- [ ] **CAL-14** — An **all-day** event stores at noon UTC and reads back in UTC — its date is identical in every timezone.
- [ ] **CAL-15** — A timed event genuinely crossing local midnight (11:05pm–12:05am) carries an End date of the next day and appears on **both** days in the grid.
- [ ] **CAL-16** — Across a **DST boundary**, a timed occurrence keeps its wall clock; an all-day occurrence stays pinned.

### 7.3 Recurrence & per-occurrence scoping — **⛔ high-regression area**

- [ ] **CAL-17** — All frequencies work: daily / weekly (with `daysOfWeek`) / monthly (`daysOfMonth`, and `weekOfMonth`+`weekdayKind` — "the last Friday") / yearly (`months`), each with an interval.
- [ ] **CAL-18** — **End Repeat** (`until`) includes the last day, and re-opening the edit form shows the **same** date every time (no one-day-forward drift per edit, in a behind-UTC timezone).
- [ ] **CAL-19** — Tapping the **3rd occurrence** opens the detail view and the edit form showing **that day**, not the series start (clock times and any multi-day span preserved).
- [ ] **CAL-20** — Opened from **search** (no occurrence day) shows the series start.
- [ ] **CAL-21** — **Delete a recurring event** → a native action **sheet** ("…This is a repeating event.") offering *Delete This Event Only* / *Delete All Future Events*.
- [ ] **CAL-22** — *This Event Only* adds the day to `exceptionDates` and the occurrence disappears from the grid; other occurrences remain.
- [ ] **CAL-23** — *All Future* sets `until` to the day before (past occurrences stay), or **deletes the whole event** when the occurrence is the first.
- [ ] **CAL-24** — **Save an edit to an occurrence-level field** (title, notes, date/time, all-day, location, alerts, travel, URL, phone, invitees) → the sheet offers *Save for This Event Only* **and** *Save for Future Events*.
- [ ] **CAL-25** — **Save a series-defining edit** (repeat rule, End Repeat, turning repeat off, `calendarType`) → *Save for Future Events* **alone**.
- [ ] **CAL-26** — A **mixed** edit takes the most restrictive answer.
- [ ] **CAL-27** — **A repeat-rule-only change made from the series' FIRST occurrence still prompts** — it is performed as an in-place series update, but the user is always asked. **⛔ BLOCKER (this previously saved silently).**
- [ ] **CAL-28** — No sheet at all when: the event doesn't repeat; the occurrence was already detached; nothing actually changed (an untouched save of a timed event with no stored end must not prompt).
- [ ] **CAL-29** — **Cancel** on the sheet leaves the user on the form with the edits intact.
- [ ] **CAL-30** — *This Event Only* creates a **detached standalone** event on that day and adds the day to the original's exceptions; the grid shows exactly one item on that cell.
- [ ] **CAL-31** — *Save for Future* **forks**: original truncated to the day before, a new series starting on the (possibly moved) occurrence day; the grid shows no doubled series and no empty husk.
- [ ] **CAL-32** — Both scoped writes **roll back** on a failed second write (simulate offline mid-save) — no duplicate on a cell, no doubled series.
- [ ] **CAL-33** — **A scoped save lands the user on what they saved**: the detail screen underneath rebinds to the new id and day (the edited event is shown, not the unedited original / a now-missing occurrence). Verify for events, chores, and tasks.
- [ ] **CAL-34** — A fork **re-anchors** the rule: moving a weekly Thursday event to Friday makes the new series repeat on Friday. A hand-authored rule (Mon/Wed/Fri; the 1st and the 15th) is left **as written**.
- [ ] **CAL-35** — "Last <weekday>" survives a fork only if the new day is also the last of its kind; otherwise it degrades to the plain ordinal.
- [ ] **CAL-36** — Inherited `exceptionDates` are split at the fork day and shifted by however far the occurrence moved.
- [ ] **CAL-37** — **Deleted occurrences are never resurrected** by an unrelated save (exceptions carry through every payload). Delete two occurrences, then rename the series → both stay deleted. **⛔ BLOCKER.**
- [ ] **CAL-38** — **Attachments follow** an override or a fork (rows and files duplicated, not shared); deleting the copy's attachment does **not** unlink the original's. A failed copy reports "Attachments didn't copy" without rolling back the save.
- [ ] **CAL-39** — Occurrence scoping works on an **outside-shared calendar** (re-sealed in the record's own key lane), and the collaborator can still read the result. **⛔ BLOCKER (lockout class).**

### 7.4 Alerts

- [ ] **CAL-40** — Up to two alerts per event; the second picker excludes the first's value (and vice-versa); "None" and "Custom…" are never filtered out.
- [ ] **CAL-41** — **Clearing the first alert promotes the second into its slot**, carrying its anchor up and leaving the second empty. Holds for the picker's "None" **and** an assistant patch. An event stored with only a second alert opens with it promoted.
- [ ] **CAL-42** — On a timed event with a drive time, both pickers offer departure-anchored rows (*Time to leave / 5 / 10 / 15 / 30 min before leaving*) above the event-anchored ones.
- [ ] **CAL-43** — **The anchor is stored, never inferred.** Set a custom "2 hours before" on an event with a 23-minute drive → re-open: it still reads **2 hours before**, not "1 hr 37 min before leaving". **⛔ BLOCKER.**
- [ ] **CAL-44** — A departure-anchored alert **follows a changed drive time** (same distance before the new departure).
- [ ] **CAL-45** — Losing the basis (All day on, travel off, location cleared) keeps the stored lead time but drops the departure framing.
- [ ] **CAL-46** — **Custom sheet**: Minutes wheel runs to **180**; a slot with **no alert** opens on **Before leaving**; a slot that already holds one opens in **its own** framing (re-opening a "2 hours before" alert and tapping Done must not turn it into two hours before leaving).
- [ ] **CAL-47** — Tapping a unit tab starts that unit at **its own default** (30 min / 2 hr / 2 days), never clamping the previous number (a tap on Hours must not land on 23).
- [ ] **CAL-48** — A departure-anchored value seeds the wheel with its **buffer**, not the stored minutes-before-event.
- [ ] **CAL-49** — **All-day alerts are whole days**: On the day / 1 day / 2 days / 1 week before, each labelled with the fire hour ("On the day (9:00 AM)"), the Custom sheet fixed to Days, and no anchor control.
- [ ] **CAL-50** — Switching **All day ON re-bases** existing alerts (a "15 min before" becomes "on the day"; a second alert collapsing onto the first is dropped) — never leaves a minute offset, never silently clears a configured alert.
- [ ] **CAL-51** — **The All day switch can be turned OFF** and stays off. **⛔ BLOCKER (it previously sprang back on).**
- [ ] **CAL-52** — `alertAudience` (`everyone` / `owner`) targets the right members in a shared household — verify on B's device.

### 7.5 Travel time & location

- [ ] **CAL-53** — On a **new** event, travel defaults **on** only once a destination is set, and only when location was already shared with the app — no permission prompt, no GPS fix before a destination exists. With no destination or no shared location, the default is **off**, and turning it off manually is never overridden.
- [ ] **CAL-54** — **Editing an existing event never changes its travel time automatically** — merely opening a travel-enabled event must not null-and-refetch its saved minutes (nor spuriously dirty the unsaved-changes guard). Recompute resumes only after the user edits the destination or origin.
- [ ] **CAL-55** — Clearing the event location switches travel **off** and drops the drive time (add and edit forms) — and only ever off.
- [ ] **CAL-56** — The Travel Time row reads the drive time with "Leave by…" once computed, **"On"** while enabled but not yet computed, **"None"** when off.
- [ ] **CAL-57** — The Travel Time sub-screen: editable "Starting address", **Current location** and **Home** one-tap shortcuts (Home shown only when set and different), both hidden while a manual duration is set. Header carries ✓ and ✕.
- [ ] **CAL-58** — **Location view — Empty state**: a single search field; typing a **street address** returns address predictions (not an empty dropdown), and typing a business name returns businesses. **⛔ BLOCKER (regression fixed 2026-08-09).**
- [ ] **CAL-59** — **Picked state**: the place collapses to a read-only card — static map, name, address on its own line with the leading business name **stripped**; ✕ returns to Empty.
- [ ] **CAL-60** — **Manual state**: reached via "Enter an address manually"; a saved location with no `place_id` opens straight into Manual; "Search for a place instead" returns to Empty; a typed address renders its own map preview.
- [ ] **CAL-61** — **Every map preview on the Location view is tappable** and opens the same place in Maps as the event view's map; the ✕ stays its own tap target and never opens Maps.
- [ ] **CAL-62** — The business **phone** is an editable `PhoneField` in all three states, with the "Calen uses it to call the business" hint.
- [ ] **CAL-63** — Saving stores a single de-duplicated `location` string, `placeId`, and `phone`.

### 7.6 Detail view

- [ ] **CAL-64** — Everything the form can set is visible: title, location, calendar, invitees, both alerts (one hairline-divided card), URL, attachments, notes, recurrence summary ("Repeats every 2 weeks on Monday … until ⟨date⟩", accent-coloured), travel time row with "Leave by".
- [ ] **CAL-65** — The view **re-pulls on focus** — turning off recurrence in the form is reflected on return without a manual refresh.
- [ ] **CAL-66** — The **Reschedule/Cancel** card is the first row of the details group, directly above the Calendar card, on both one-off and recurring events.
- [ ] **CAL-67** — The mini **timeline card** (timed events only): compact ~3h window opening ~1h before; block content adapts (>1h shows title+location+time, exactly 1h drops location, <1h title only); a longer event's block is **clipped** at the card's bottom while the text still names the true end time; a multi-day event clamps to its first day. All-day events omit the card.
- [ ] **CAL-68** — **Delete Event** is a floating pill **pinned to the screen** — it stays fixed while content scrolls beneath it; content reserves bottom padding so nothing hides under it.
- [ ] **CAL-69** — The location map (static + street view) closes the scroll content; with no location or failed tiles it is simply omitted and the pill still floats.

### 7.7 Attachments

- [ ] **CAL-70** — Attach a photo and a PDF (≤25 MB) → sealed on-device → uploaded → listed.
- [ ] **CAL-71** — Picks staged on a **new** event upload after the save creates it; a failed upload names which files failed (never silently dropped).
- [ ] **CAL-72** — Tapping an attachment downloads, decrypts, and previews **in-app** (WebView) for images and PDFs; the header **Share** hands the file to the OS sheet; a non-previewable type goes straight to the share sheet. No crash on the new architecture.
- [ ] **CAL-73** — The modal preview screen has a top-left ✕.
- [ ] **CAL-74** — An oversized file (>25 MB) is rejected with a clear message.

### 7.8 Invitees & RSVPs (needs two devices)

- [ ] **CAL-75** — **Invitees screen = three titled zones**: *Notify household members* (only when >1 member; creator excluded) / *Invite others* / *Guest list*. Each zone's explanation is behind the ⓘ; the hint sits tight to the card it explains.
- [ ] **CAL-76** — The **Guest list zone is hidden** until an outside invitee is staged or sent.
- [ ] **CAL-77** — The empty state is scoped to the outside-invite zone ("No one outside your household yet.") and is a **single muted line** — the zone must not visibly shrink when someone is added.
- [ ] **CAL-78** — Select household member B → save → B gets an **instant push** and a `householdEvent` row in their Invitations inbox with Accept/Decline; the inbox polls every 5s and the badge counts it.
- [ ] **CAL-79** — B accepts → A gets a reply push; the event detail's Invitees row shows B as a status chip (accepted ✓) **ahead of** outside invitees.
- [ ] **CAL-80** — B changes their answer → the same record updates in place; the latest answer wins; no LWW contention with a concurrent event edit by A.
- [ ] **CAL-81** — A changes the event's **date/time/all-day in place** → non-declined invitees are re-notified ("«title» changed") and **RSVPs are not reset**.
- [ ] **CAL-82** — An occurrence override / series fork starts RSVPs fresh and sends **no** re-notify.
- [ ] **CAL-83** — With a **locked vault**, B can still see the inbox row but responding surfaces "Unlock your household data to respond" — never a silent failure.
- [ ] **CAL-84** — Cancelled events drop out of the inbox; past events surface only once replied.
- [ ] **CAL-85** — Relay validation: an event outside the caller's household 404s; one cross-household recipient fails the whole request (no partial send); the sender is skipped, not an error.
- [ ] **CAL-86** — **Outside invite, account holder**: gets a push (title-free for sealed invites) + the in-app inbox, and **no** email composer opens.
- [ ] **CAL-87** — **Outside invite, non-account**: the organizer's mail app composes the invite carrying the snapshot and the public `.ics` link; the SMS twin mirrors it. Open the `.ics` link in a browser and add it to Apple Calendar.
- [ ] **CAL-88** — Pending email rows carry a **Remind** (paper-plane); phone rows keep resend-text.
- [ ] **CAL-89** — **Guest list toggle** actually takes effect: with it off, a cross-household invitee cannot see who else is invited (the flag is forwarded on every send, across sealed/plaintext/SMS lanes). **⛔ BLOCKER (it was a silent no-op).**
- [ ] **CAL-90** — Accepting a cross-household invitation creates a **sealed copy** on the accepter's calendar with `invitationId`; on that copy, Delete becomes **"Leave event"**. With a locked vault, the accept surfaces an "unlock your vault" message rather than a server rejection.
- [ ] **CAL-91** — Revoking an invitation deletes the plaintext snapshot (the public `.ics` 404s afterward).

### 7.9 Call-derived state

- [ ] **CAL-92** — A **confirmed-cancelled** event renders faded + struck on every surface (month grid, agenda, day view, list, detail); a **confirmed reschedule not yet applied** renders faded, no strike.
- [ ] **CAL-93** — Both clear when the notice is acknowledged (Dismiss on the event view or OK in Invitations).
- [ ] **CAL-94** — A **recurring** occurrence's call dims **only that occurrence** (`occurrenceDate`); an unscoped/legacy call dims the event on every day it renders.
- [ ] **CAL-95** — A hand-set `cancelled` (couldn't-confirm path) persists until deletion and is written by a **client re-seal**, never a plaintext field update (no "update to the latest app version" error).
- [ ] **CAL-96** — The series-wide "Mark appointment as cancelled" fallback is **hidden** on recurring occurrences.
- [ ] **CAL-97** — With no business number, the Reschedule/Cancel card routes to the **Location view** with a prominent callout banner tinted in the **event's own calendar colour** and the phone field highlighted; both clear once a number is typed.

---

## 8. Calendar — views & navigation

- [ ] **VW-01** — Density switcher (anchored **dropdown popover**, not a bottom sheet) shows the active mode's glyph, a checkmark on the active row, and a divider isolating **List**. Choice persists device-local; default **Details**.
- [ ] **VW-02** — **Compact**: uniform short rows, ≤4 coloured dots per day, no text, no bars, no weather lane.
- [ ] **VW-03** — **Stacked**: thin coloured bars per single-day item + overlaid spanning bars; row height grows with the busiest day.
- [ ] **VW-04** — **Details**: chips (title + start time), labelled spanning bars, the maintenance/chore/meal/grocery icon row.
- [ ] **VW-05** — **Switching density is instant** — no rebuild, no re-scan, no flash; the popover's dismissal paints before the layer re-renders; returning to a seen density is a straight cache hit. Time it on a heavy month. **⚠️ RISK — perf-sensitive.**
- [ ] **VW-06** — **Month blocks**: each month its own Sunday-first grid, neighbouring days blank in a boundary week, real whitespace between months, the 1st carrying the abbreviated month name in the app primary on its own reserved line.
- [ ] **VW-07** — The month's opening rule is the **ordinary `colors.border` hairline drawn per own-month day cell** — no tinted/heavier line, and **no rule over the blank lead-in cells**. Verify at all three densities and in the viewer grid.
- [ ] **VW-08** — Spanning bars and the weather lane **clip at the month boundary** (a trip crossing it draws as two clipped bars).
- [ ] **VW-09** — **Unbounded window**: opens last month → +3, grows 6 months at whichever edge you approach, one extension per edge; upward growth never jumps the viewport.
- [ ] **VW-10** — **The past edge does not run away.** Launch, don't touch the grid, wait — the header month must not sweep backwards through the calendar. The pin does not scroll when today is outside the window. **⛔ BLOCKER (runaway-prepend class).**
- [ ] **VW-11** — The sticky header label tracks the row by **key**, so a past-edge prepend never silently renames the month.
- [ ] **VW-12** — **Month/year jump sheet**: ‹ year › stepper + 3×4 grid, visible month filled primary, today's month tinted, unbounded years; a pick grows the window and **teleports** (no animation) to that month's first row, updating the label immediately. The sheet opens and dismisses instantly.
- [ ] **VW-13** — The same jump button heads the **List layer**; a pick there re-cursors the carousel and the tapped-day selection stays put.
- [ ] **VW-14** — **List layer**: single-month dot grid + the tapped day's events below; adjacent-month days blanked; the grid is a vertical carousel that snaps to a full month past a distance/velocity threshold and springs back otherwise.
- [ ] **VW-15** — **List day selection styling**: while today is the selection it carries the filled primary disc; tapping another day demotes today to a bare primary-coloured number and gives the tapped day a **white disc with the number knocked out in the canvas black**.
- [ ] **VW-16** — **Add is selection-aware in List mode**: tap a day, then **+** → the new-event form opens with Starts/Ends on **that** day. In the grid family, **+** defaults to today.
- [ ] **VW-17** — Switching layers **preserves the viewed month in both directions** (grid→List re-cursors, today selected when the adopted month is today's else the 1st; List→grid teleports, no-op when already there).
- [ ] **VW-18** — Floating chrome: top-left **avatar** (badge: "!" beats the invitations count, 9+ cap, never both); top-right utility pill (switcher / search / add); bottom-left labelled **Today | Calendars** pill; bottom-right the **56pt Calen FAB** (shown only while AI is enabled). No Invitations button anywhere on the calendar.
- [ ] **VW-19** — Arriving from an assistant nav chip, the FAB slot shows the **"‹ Calen" return pill** which pops back into the live conversation with full state; the avatar stays put.
- [ ] **VW-20** — **Today** re-centres whichever layer is active.

### 8.2 Day view

- [ ] **DAY-01** — Three modes behind the day view's own switcher (same popover convention); choice persists device-local; default **Single Day**.
- [ ] **DAY-02** — Chrome: back pill labelled with the anchor's month ("‹ July"), switcher/search/add pill, **Today**, month-jump. Native back-swipe stays disabled and horizontal swipes page between days.
- [ ] **DAY-03** — Week strip: today marked in the **app primary** (never red) — tinted number, filled primary circle when it's the anchor; a non-today anchor gets a white circle; Multi Day shows a grey pill spanning the pair, clipped at Saturday. Tapping a number re-anchors in place; a day swipe crossing a week edge pages the strip.
- [ ] **DAY-04** — Hour grid: fixed 24h canvas, gutter `12 AM … Noon … 11 PM`, timed events as translucent blocks with a solid left bar, **clipped per day column** (a midnight-spanning event yields one segment per column), overlapping blocks lane-packed at equal widths.
- [ ] **DAY-05** — A **timed** event covering the whole day demotes to the all-day lane.
- [ ] **DAY-06** — All-day lane: all-day events, trips, holidays, occasions, meals, the grocery marker, **and date-only tasks/chores**. Chips lead with a colour-tinted glyph — events a calendar glyph, occasions their kind icon, **chores their own icon**; date-only **tasks** stay muted empty-circle chips. Capped at three rows with "+N more".
- [ ] **DAY-07** — Now indicator renders only when today is visible, in the app primary, ticking on the minute, with a gutter time badge.
- [ ] **DAY-08** — Hourly **weather rail** appears only while the Weather calendar is visible, is non-interactive, and renders **under** the event blocks; days outside the forecast simply have no rail.
- [ ] **DAY-09** — Swiping pages by the visible day count; the vertical scroll offset survives day swipes **and** the single↔multi switch. Initial position: the now-line for today, just above the first event otherwise, 8 AM when empty.
- [ ] **DAY-10** — **List** mode: days with items only, plus **today** always (even empty) so its marker anchors the list; an all-empty window drops it and shows the EmptyState.
- [ ] **DAY-11** — Sticky day headers ("Monday – Jul 27") with a weather glance when available; today's header preceded by the **"Today" divider marker** and tinted primary.
- [ ] **DAY-12** — The window **starts at the anchor's day**; a new anchor (day swipe, week-strip tap, Today) restarts it. Scrolling to the end extends forward; **scrolling to the top prepends automatically** (infinite scroll up) with no jump and a brief header spinner.
- [ ] **DAY-13** — Leaving List keeps the anchor.

### 8.3 Search & print

- [ ] **SRCH-01** — Calendar search field: `autoCapitalize="none"`, `autoCorrect={false}`; results across events (and everything the chokepoint permits — locked add-ons excluded); header is `colors.background` with no shadow or divider.
- [ ] **SRCH-02** — Opening an event from search (no occurrence day) shows the series start and the delete/save prompts fall back to it.
- [ ] **PRT-01** — Print presents as a **modal** with ✕ and swipe-down.
- [ ] **PRT-02** — Layout + range pickers produce a PDF; the checklist excludes locked add-ons and hidden calendars per the user's prefs.
- [ ] **PRT-03** — Month-grid layout wraps event titles to **two lines** (no one-line ellipsis) and prints compact 12-hour times ("1PM"); the **24-hour toggle** renders zero-padded `HH:mm`.
- [ ] **PRT-04** — The PDF hands off to the OS print dialog / share correctly, on a month with a heavy day.

---

## 9. Calendars manager, custom calendars, holidays

- [ ] **CMG-01** — The manager **pushes** (back chevron), not a modal.
- [ ] **CMG-02** — Groups order **HOUSEHOLD → JUST ME → SHARED**; empty groups hidden; every SHARED row states its direction ("Shared by you · N people" / "Shared with you"), joined after the kind when both apply.
- [ ] **CMG-03** — **Single-member household**: unshared customs display under HOUSEHOLD and JUST ME is absent; the underlying state stays unshared, so they move to JUST ME once a second member joins. While the member count is unknown, the split is kept.
- [ ] **CMG-04** — Tapping a row **toggles visibility only** — it never navigates. The row is `accessibilityRole:"switch"` with checked state; a hidden calendar dims its name; the leading control is a filled check-circle (shown) / empty dimmed circle (hidden) carrying the calendar's colour.
- [ ] **CMG-05** — The toggle's flip is immediate; the month grid beneath re-renders without delaying the tap feedback.
- [ ] **CMG-06** — Every row carries an **edit (info)** button opening Edit Calendar (name/colour/alerts/sharing/delete). Feature-backed and holiday rows additionally show an accent-tinted **"Open" pill**. Feature homes and the holidays editor carry **no header pencil**; their one header action is the alarm bell where calendar-level alerts exist.
- [ ] **CMG-07** — The header **+** opens the Add Calendar chooser (new / subscribe / holiday / restore deleted). Colours & Order and Print are one grouped "manage" card at the end. No long-press delete.
- [ ] **CMG-08** — Built-in default colours match the spec (Activities `#388E3C`, **Appointments `#1976D2`**, Occasions `#E91E63`, Weather `#0288D1`, Chores `#F57C00`, Meals `#00897B`, Maintenance `#1976D2`, Trips `#5E35B1`); reset returns Appointments to blue.
- [ ] **CMG-09** — **The arrangement is account state.** Recolour a calendar, reorder, hide one, delete a built-in, mute another's alerts → sign out → sign in → **every choice survives**. **⛔ BLOCKER (they previously all reverted).**
- [ ] **CMG-10** — An account field stored as **empty** (nothing hidden, no overrides) beats the device cache rather than being re-seeded from it.
- [ ] **CMG-11** — A device whose account has **never stored** the arrangement seeds the account from that device.
- [ ] **CMG-12** — A local edit made **while the settings fetch is in flight** wins.
- [ ] **CMG-13** — The two **view modes** (month density, day-view mode) stay device-local — they do **not** sync between devices.
- [ ] **CMG-14** — Locked add-on calendars collapse into **one storefront row** as the HOUSEHOLD group's **closing row** (never a top-of-screen banner), icon at full saturation, subtitle naming the full catalog in store order **with no price**.
- [ ] **CMG-15** — With **everything owned**, the storefront row **persists** with the subtitle "All add-ons added"; the HOUSEHOLD group always renders because it hosts that row.
- [ ] **CAL-C1** — **New Calendar**: name field's keyboard **Done** dismisses the keyboard (it must not leave the keyboard over the sharing/colour rows). Same on Subscribe.
- [ ] **CAL-C2** — Sharing a calendar outside the household: `useRosterSuggestions` autocomplete (placeholder "Add name, email, or phone…"), suggestions exclude staged outside entries, household member emails, and yourself; the typed path keeps its pointed errors ("That's you", "…is in your household — select them above").
- [ ] **CAL-C3** — Tapping a suggestion **stages** at View Only (nothing sends until the calendar saves); the keyboard stays open across adds; a spinner replaces the add button during the lookup; the "They're on Calen" note clears on typing.
- [ ] **CAL-C4** — The suggestion dropdown is **not occluded by the keyboard** (RevealWrap) — verify on the small device.
- [ ] **CAL-C5** — Outside-share invites skip the composer for account holders (lookup-gated, failing open) and offer a per-row **Remind**.
- [ ] **CAL-C6** — Collaborator C (full) can create/edit events on the shared calendar; D (view) sees them read-only and any write attempt is refused — the form recomputes the read-only view from `access === 'view'`, so the 403 never surfaces as a mystery save error.
- [ ] **CAL-C7** — **Owner signs out and back in → the shared calendar's events are still there.** (`ensureSharedCalendarKeys` loads the owner's own household wrap on every unlock.) **⛔ BLOCKER (they previously vanished).**
- [ ] **CAL-C8** — The collaborator's device decrypts shared events after their first unlock; before the owner's wrap, surfaces show the "waiting for the owner" state, not an error.
- [ ] **CAL-C9** — **Re-seal integrity**: after a first-share mint or a revoke-rotation, every migrated event still renders on its calendar (`calendarType` survives), for the owner **and** the collaborator. **⛔ BLOCKER (14 sealed fields were previously deleted).**
- [ ] **CAL-C10** — `repairCalendarLaneEvents` restores `calendarType` on already-damaged events, is idempotent, and refuses to rewrite anything it couldn't decrypt (run it against a locked session and confirm nothing is destroyed).
- [ ] **SUB-01** — **Subscribe** an external ICS feed (`webcal`/`https`) → its events expand into the grid; the provider helper detects Gmail/iCloud/Outlook from an email and deep-links to the right settings page with steps (guidance only — the user still pastes the URL).
- [ ] **SUB-02** — A malformed/unreachable feed URL fails with a readable message, not a crash. *(Refresh cadence + failure behavior is an open spec question — record what the app actually does.)*
- [ ] **HOL-01** — A fresh install auto-seeds the device-locale country's holiday calendar (deduped by country against the server list).
- [ ] **HOL-02** — Right after that seed, the **home province/state is preselected** when derivable — only on the seeded calendar, never on a server or legacy one.
- [ ] **HOL-03** — Creating a holiday calendar for a country matching home seeds `selectedRegions`.
- [ ] **HOL-04** — Saving a home address auto-selects the region on holiday calendars of that country **that have no picks yet**; an explicit choice is never overridden.
- [ ] **HOL-05** — The holidays editor's **notifications bell** opens **Holiday Alerts** (Alert / Second alert / Alert at). The config is **shared by every holiday calendar** — opening it from a second country lands on the same values.
- [ ] **HOL-06** — Holiday alerts **default to off**; each calendar's own Alerts switch mutes its holidays; a housemate reading a shared holiday calendar sets their **own** alerts.
- [ ] **HOL-07** — A holiday alert with a large offset (e.g. 2 weeks before a holiday 25 days out) still fires — the lookahead runs past the 21-day window.

---

## 10. Occasions & e-cards

- [ ] **OCC-01** — Occasions derive from `Person.birthday` + labeled `dates[]`; `anniversary` and `death` are selectable kinds, a legacy `marriage` still resolves, any other label is a `custom` occasion under that label. `marriage` is no longer offered.
- [ ] **OCC-02** — On the month grid, occasions render as **kind icons** in the icon row, not event chips.
- [ ] **OCC-03** — Tapping an occasion anywhere read-only (grid, day view, agenda) opens the **Occasions screen** (not the person form) and **scrolls it to the top with an outline** (`focus` matched by person + kind + month/day + label).
- [ ] **OCC-04** — `occasionsHidden` **omits** a contact entirely — from the grid, day/list, search, print, reminders, **and the Occasions list** (there is no dimmed "hidden" group).
- [ ] **OCC-05** — Tapping a shown occasion row opens the person **scrolled to the Dates section**.
- [ ] **OCC-06** — The **today-anchored timeline** renders: *Recently observed* (dimmed, ≤7 days past, **no** e-card prompt, a "Sent" pill when a one-time card already went out) → the **"Today · ⟨date⟩"** marker → *Coming up* (0–60 days, the e-card envelope lives here, today's occasions lead with the accent outline) → collapsed *Later this year (N)* (auto-expanded when a focused occasion lives there).
- [ ] **OCC-07** — `whenLabel` renders "Yesterday" / "3 days ago" / "Today" / "Tomorrow" / "in N days"; "Later" rows drop it.
- [ ] **OCC-08** — With nothing in the 60-day window, the inline "Nothing in the next 60 days." note shows; with no occasions at all, the empty state offers **Add dates in Contacts**; the explanatory Hint shows only when occasions exist.
- [ ] **OCC-09** — **Occasion alerts**: one calendar-level config (offsets + one time), defaults **noon the day of** + **two weeks before**; the two slots must be distinct; the Occasions Alerts switch mutes them; the config **survives a sign-out** (account-backed). **⛔ BLOCKER.**
- [ ] **ECD-01** — Schedule an e-card: pick from the per-kind **three-design gallery**; the swatch row + live editable card render; the chosen key is stored.
- [ ] **ECD-02** — Unknown/legacy template keys resolve to the kind's default style on **both** the picker and the renderer.
- [ ] **ECD-03** — Editable lines: greeting, message, sign-off, signature — bare inputs on the card face with placeholders, a "Tap to edit" pencil badge (tapping focuses the greeting with the caret at the start) and dashed underlines. Each ≤120 chars.
- [ ] **ECD-04** — Blank fields fall back at send time: greeting → per-recipient "Dear ⟨first name⟩,"; sign-off → the style's phrase; signature → the author's first name (which also signs the subject).
- [ ] **ECD-05** — Font menu (Auto / Modern / Serif / Elegant / Script) applies in the native preview **and** the email; unknown keys fall back.
- [ ] **ECD-06** — **Photos**: multi-select in **one** library visit, `selectionLimit` = open slots (3 minus existing); up to 3, ≤10 MB each.
- [ ] **ECD-07** — **Saving never holds the user for photos**: the ✓ awaits only the card row, then leaves at once; photos upload in the background in parallel; a failure raises a global alert naming how many failed, and the photos can be re-added from the edit screen. **⛔ BLOCKER (long-spinner regression).**
- [ ] **ECD-08** — Recipients are scoped to the occasion's contact **plus their linked related names**; "Add a related contact" opens the contact's own form at Related names, and the newly linked person appears as a candidate on return.
- [ ] **ECD-09** — A candidate missing an email can have one added inline, saved onto that contact (sealed); a contact with multiple emails defaults to primary with a per-recipient picker showing the chosen label.
- [ ] **ECD-10** — The send-time picker is **whole hours** and opens scrolled to **noon**.
- [ ] **ECD-11** — The **plaintext-exception disclosure** shows at **create time only**.
- [ ] **ECD-12** — A scheduled card marks its occasion row with a filled envelope; tapping it re-opens to edit or cancel.
- [ ] **ECD-13** — **Each card sends once** on the next upcoming date, then deactivates (`active` cleared, `sentAt` stamped) — it does **not** recur annually. A meaningful edit re-arms it. The hint reads "Sends once on ⟨next date⟩".
- [ ] **ECD-14** — **Delivered email checks** (send a real card to Gmail, Apple Mail/iOS Mail, Outlook-Windows, and one webmail):
  - Subject punctuation: "🎂 Happy Birthday, Sam! — from Ben", never "Happy Birthday!, Sam".
  - **Condolence subjects never include the recipient's name.**
  - Photos render **inline at card width**, not as "Tap to Download" tiles (send-time downscale to ≤1280px).
  - No **"OBJ" boxes** (U+FFFC stripped at write and render time) — test by dictating the message with iOS dictation.
  - The Gmail hero emoji is not blurred/oversized (the Gmail-only shrink rule).
  - Animation plays in Apple Mail; Gmail/Outlook-Windows show the identical static card with solid bgcolor fallbacks; `prefers-reduced-motion` stills it.
  - The author receives the **CC copy**.
  - All user content is HTML-escaped (send a card with `<script>` and `&` in the message) and a plaintext alternative accompanies the HTML.
- [ ] **ECD-15** — A missed hourly tick (deploy/downtime) still sends the card that day at the first tick at or after the send hour.
- [ ] **ECD-16** — Without SMTP configured, every send is a logged **dry-run**, not a silent success.

---

## 11. Kitchen (Meals)

- [ ] **KIT-01** — Locked → `AddonLockedView`; purchased → content, with retained data and grocery markers restored.
- [ ] **KIT-02** — Recipe CRUD through the record store: title, description, source/sourceUrl/imageUrl, servings, prep/cook times, structured ingredients, ordered instructions with per-step ingredient links and timers, tags.
- [ ] **KIT-03** — Unsaved-changes guard on the recipe form.
- [ ] **KIT-04** — AI capture paths: **from-URL**, **from-photo**, **from-AI/description**, **generate**, **edit-with-ai**, **suggest-recipes** — each consent-gated (403 with AI off), annotated "sent to Anthropic", and correctly debited (`generation` 3 / `scan` 3).
- [ ] **KIT-05** — **Share a recipe** hands the fully rendered recipe to the OS share sheet (title, meta, description, ingredients, instructions, website link) — no server round-trip, and the recipient needs nothing installed.
- [ ] **KIT-06** — Meal planner: schedule a recipe onto a date with servings + notes; it appears on the calendar's Meals lane; edit and delete.
- [ ] **KIT-07** — Grocery list aggregates ingredients across the planned week correctly (duplicate ingredients merged, units handled); the AI tidy pass organizes it and a non-JSON model reply degrades gracefully.
- [ ] **KIT-08** — Shopping progress persists per week and is **household-shared** — check items on A's device, see them on B's.
- [ ] **KIT-09** — Moving a meal **across shopping weeks** invalidates the affected weeks' organized list while leaving checked items elsewhere intact.
- [ ] **KIT-10** — Grocery-shopping day markers render on the calendar from the cached device-local settings, even on a background/offline load.
- [ ] **KIT-11** — **Cooking mode** steps through instructions, runs timers, and keeps the screen usable (verify screen-lock behavior and backgrounding mid-timer).
- [ ] **KIT-12** — Meal planner settings screen round-trips its options.

---

## 12. Maintenance (items, tasks, chores)

- [ ] **MNT-01** — Maintenance locked → `AddonLockedView` (paid); Chores locked → the **free** "Add for free" variant. Data retained and restored on purchase/claim.
- [ ] **MNT-02** — Item add wizard → details step; unsaved-changes guard covers the **final details step only**, not the wizard.
- [ ] **MNT-03** — Item fields round-trip: name, category, property, service-pro link, manufacturer/model/serial, location, notes, custom fields, photo.
- [ ] **MNT-04** — **Manuals**: upload a PDF (encrypted per-file, `wrappedFileKey`), fetch-from-URL, auto-lookup (metered `manualParse`), extract-tasks (metered). A plain **upload** and **save-from-URL** debit **nothing**.
- [ ] **MNT-05** — `POST /items/from-photo` (photo scan) is metered as `scan` and consent-gated.
- [ ] **MNT-06** — Task fields: item/category binding, interval (`intervalValue`/`intervalUnit`), calendar/seasonal recurrence, mileage (`intervalKm`/`lastServiceKm`/`nextDueKm`), cost/duration estimates, priority, two **distinct** alerts, `alertAudience`/`alertUserIds`.
- [ ] **MNT-07** — Chore fields: recurrence, `assignedTo`, next due date, alerts.
- [ ] **MNT-08** — **"Assigned to" offers household members only** — never the wider contacts roster; sorted **you first** then alphabetically; a chore assigned to a non-member keeps that person visible but unpickable; the same list is what "Ask Calen" is offered.
- [ ] **MNT-09** — The **+** on the chores list opens the Add Chore chooser (by hand / from a template), which `replace`s itself so Back returns to the list.
- [ ] **MNT-10** — **Changing a chore's Repeat reseeds Next Due Date** from the new rule and **shows it in the field** (not applied silently at save). "Does not repeat" leaves the picked date alone, as does editing any non-repeat field. Holds from the Repeat screen, from "Ask Calen", and from an assistant draft.
- [ ] **MNT-11** — **Recurring chores and tasks repeat across the month grid** — a repeating chore appears on **every** occurrence, not just one day. **⛔ BLOCKER (merge-key regression).**
- [ ] **MNT-12** — Per-occurrence scoping (chores + tasks, mirroring events): tapping from a calendar cell passes that day; the detail and form show **that day**; a whole-series save shifts back onto the anchor.
- [ ] **MNT-13** — Delete offers *Delete This Chore/Task Only* (adds to `skipDates`) and *Delete All Future* (sets `until`, or deletes the record on the first occurrence).
- [ ] **MNT-14** — Save offers both scopes for occurrence-level fields; the **repeat rule** and (for tasks) the **mileage interval** are series-defining and offer *Save for Future* alone.
- [ ] **MNT-15** — **Moving the occurrence's date is occurrence-level** and offers both choices (the `occurrenceDateMoved` signal); a rule-derived reseed alone never raises it.
- [ ] **MNT-16** — A previously skipped day or an existing `until` must **not** make an unrelated edit read as a rule change; `months: []` vs absent is shape noise, not an edit.
- [ ] **MNT-17** — Being on the **first** occurrence does not suppress the sheet.
- [ ] **MNT-18** — A plain series save (a rename) **carries `skipDates`/`until` over** — it must not resurrect skipped days or un-end an ended series. **⛔ BLOCKER.**
- [ ] **MNT-19** — **Resume schedule** row appears only when something holds the series back, with a subtitle naming what ("Ended Aug 4 · 3 skipped ahead"). Confirming resumes from **today**: forward skips dropped, **the past left exactly as it looks** (past occurrences enumerated into `skipDates` as `until` lifts), upcoming days with a detached copy stay skipped, idempotent, nothing user-created deleted.
- [ ] **MNT-20** — An **ended** series leaves the Chores list and the Maintenance due/overdue lists but stays reachable in a collapsed **"Ended chores (N)" / "Ended tasks (N)"** group; an ended item-less task still has a home on the Maintenance screen; with every chore ended, an inline empty state shows above the group.
- [ ] **MNT-21** — An ended item's date row reads **"Ended ⟨date⟩"**, not "7 months overdue"; a series ending next month still reads normally.
- [ ] **MNT-22** — The date field reads **"Date"** when showing an occurrence and **"Next Due Date"** when the series is the subject, with the Hint naming the occurrence being edited.
- [ ] **MNT-23** — Skipping the anchor day of an `interval` series advances the anchor.
- [ ] **MNT-24** — Completion history stays with the truncated original after a fork; the "This also removes all completion history" warning appears on the one-time confirm and the first-occurrence sheet, and **not** on a later occurrence's sheet. Chores never carry it.
- [ ] **MNT-25** — **Every edit form ends in Delete** (Item/Task/Chore), running the same prompt as the detail screen's Delete, and exits **past** the detail screen underneath.
- [ ] **MNT-26** — Task completion: the client computes the next due date / mileage rollover and sends facts + re-sealed ciphertext; a malformed envelope 400s **without** leaving an orphaned ledger row; `GET /tasks/completions` shows the history, date-range filterable and household-scoped.
- [ ] **MNT-27** — **"Flag tasks due within"** (`reminderLeadDays`, default 7) is edited from the Maintenance home and applies to **every** member (verify on B).
- [ ] **MNT-28** — Templates: task catalog (incl. the seasonal winter-prep set) and chore catalog browse and add; a template is **reusable** (re-adding is allowed) and shows a non-blocking "In Use" hint.
- [ ] **MNT-29** — **Ask Calen form-assist** on task and chore forms fills title/instructions/assignee/due-date, the **icon**, both **alert timings**, and the **recurrence** — "make laundry day Saturdays" updates the repeat rule, not just the next due date. A field the form doesn't advertise can never be set.
- [ ] **MNT-30** — Odometer: log readings against a vehicle item, list them, delete one; mileage-based tasks recompute `nextDueKm`. **⚠️ RISK — end-to-end mileage recomputation is an open spec question.**

---

## 13. Trips

- [ ] **TRP-01** — Locked → `AddonLockedView`; purchased → content restored.
- [ ] **TRP-02** — Trip fields: name, destination (+ placeId/timezone), status, date range or `candidateRanges` while planning, notes, colour, budget, base currency.
- [ ] **TRP-03** — Starts/Ends on the trip, on a booking, and on a journey's Departs/Arrives follow the shared duration rule (§7.2), including the itinerary special case: a start **time** edit only moves the end when the pair had both clocks set.
- [ ] **TRP-04** — Trip items: title, start/end, location, address, confirmation, cost/currency, url, phone (E.164), notes, free-form details, encrypted attachments; `from-confirmation` parses a booking.
- [ ] **TRP-05** — A trip contributes only its **date range** (or candidate ranges) as a spanning overlay on the calendar; itinerary items never reach the calendar; nothing in trips repeats (no occurrence scoping).
- [ ] **TRP-06** — Trip timeline renders legs/items in order with travel legs.
- [ ] **TRP-07** — **Expenses & settlement**: household budgets, per-item shares/paid-by, the settlement view, recording settle payments and deleting one. Verify the who-owes-whom math by hand across three households. **⚠️ RISK — no automated coverage at all.**
- [ ] **TRP-08** — Multi-currency: items in a non-base currency roll into the settlement correctly.
- [ ] **TRP-09** — **Resource-key sharing**: an in-app collaborator receives the per-trip key and decrypts trip records; revoke → rotation → their access ends.
- [ ] **TRP-10** — **Decrypt-on-share**: a shared trip becomes plaintext server-side, steady-state writes strip ciphertext while shared, and un-sharing re-encrypts on the next edit.
- [ ] **TRP-11** — Invite outreach: account holders get a push + inbox with **no composer**; non-account recipients get the composed mail/SMS; not-yet-joined rows carry **Remind**.
- [ ] **TRP-12** — Accept/decline a trip invitation; `leave-share`; owner removes a collaborator.
- [ ] **TRP-13** — Encrypted trip attachments upload/download/delete; an unwrapped upload is rejected. **Known gap:** attachments on a shared trip across households are plaintext — confirm the behavior matches the documented gap and that no user-facing claim contradicts it.
- [ ] **TRP-14** — Unsaved-changes guard on the trip and trip-item forms; an **existing** trip's outside-sharing changes persist immediately and do **not** count as unsaved, while a new trip's pending invites do.
- [ ] **TRP-15** — The first-run empty state names the feature's purpose (bookings + splitting expenses with fellow travelers).
- [ ] **TRP-16** — A **booked trip spanning today** surfaces the destination-forecast card on the Weather screen; absent when there's no active trip, the add-on is locked, or the lookup fails.

---

## 14. People & contacts

- [ ] **PPL-01** — 3-tab roster (Family / Friends / Professionals) as an iOS-Contacts-style `SectionList`: initials avatar, **surname bolded** (structured `lastName` when present, exact for multi-word surnames), sticky letter headers, trailing "#" bucket.
- [ ] **PPL-02** — Sort by **first name (default) or last name** persists device-local; the section headers follow the chosen key.
- [ ] **PPL-03** — The **A–Z scrubber** jumps to a letter, snapping to the next non-empty section; hidden while searching or when empty.
- [ ] **PPL-04** — The floating search pill filters across name, relationship, address/city, business name, email, and **phone matched on digits only**; the scrubber and headers stay meaningful.
- [ ] **PPL-05** — The account holder's own self Person is **excluded from every tab** and edited from Account; other members' cards carry a **"Member"** chip.
- [ ] **PPL-06** — The **+** stays in the navigation header (transparent-white), adds into the active tab, or opens device import.
- [ ] **PPL-07** — Personal contacts have **First / Last** inputs; `name` recomposes on save. **Service** contacts and the self card keep a single name field. Legacy single-`name` records split sensibly on load and persist the structured fields on the next save.
- [ ] **PPL-08** — Multi-value fields (phones/emails/addresses/dates/urls/relatedNames): label picker with presets + **Add Custom Label** (the option list scrolls within a capped height and the last row — Add Custom Label — is fully tappable above the home indicator on the small device); red-minus remove; green-plus add; field-specific value editors.
- [ ] **PPL-09** — Labels store lowercase, display Title Case; a **custom label is never added to the picker's list**.
- [ ] **PPL-10** — Legacy single `phone`/`email`/`address`/`businessName` fold into arrays on read and the legacy singles are **cleared** on the next save.
- [ ] **PPL-11** — **Reciprocal related names**: linking a roster contact mirrors onto their card with the inverse label (symmetric stays, gendered collapses neutral, assistant ↔ manager).
- [ ] **PPL-12** — **Custom-label reciprocals**: a linked custom label shows the "Who ⟨X⟩ is to ⟨Y⟩" picker; the mirror carries the inverse **and** the saver's label as its own `reciprocalLabel`; typing a name by hand unlinks and clears it.
- [ ] **PPL-13** — Renaming the saver refreshes the linked contact's stale back-link name; relabeling propagates **only** when the saver changed the wanted mirror label (an unrelated re-save never clobbers an independently customized mirror); an already-current mirror emits no write.
- [ ] **PPL-14** — Deleting a linked contact strips dangling `personId` links on other cards; removing/unlinking a related row cascades to remove the back-link.
- [ ] **PPL-15** — A failed back-link write never fails the save.
- [ ] **PPL-16** — Addresses accept a full street address **or** just a city (`addressCity` lane, unrestricted region); service contacts use the `business` lane on their first address, and picking a business adds its Places phone.
- [ ] **PPL-17** — The person form uses the **picker-free `PhoneTextField`** (full row width); Account/event location/trip items use the country-picker `PhoneField`. Both emit E.164.
- [ ] **PPL-18** — **Occasion dates**: `birthday` is the first + default label, a new personal contact starts with an empty Birthday row, the form splits it back to `Person.birthday` on save, and `dates[]` never contains a birthday. There is **no** `other` catch-all preset. Each row's value carries a clear-✕ distinct from the row's red-minus.
- [ ] **PPL-19** — The contact detail view renders the birthday **inline as the first row of the dates group** (gift icon).
- [ ] **PPL-20** — "Show on Occasions calendar" switch lives in the Occasion dates section and takes effect everywhere (§OCC-04).
- [ ] **PPL-21** — **Self-Person seeding** runs at app boot and again the moment the key unlocks — so chore assignees and event invitee pickers always have at least "You". It no-ops while locked or when a self record exists, and it seals `type` **and** `accountId`.
- [ ] **PPL-22** — Editing a contact's occasion dates repaints **both** the Occasions list and the **month grid** immediately. **⛔ BLOCKER (chokepoint-invalidation class).**
- [ ] **PPL-23** — A saved contact is never invisible: every sealer uses the full `PERSON_ENC` subset, and fields the form doesn't show (`accountId`, `deviceContactId`) survive a re-seal.
- [ ] **PPL-24** — Unsaved-changes guard on the person form; the read-only "You" card never prompts.

### 14.2 Contact import

- [ ] **IMP-01** — **Nothing auto-imports** — granting contacts access only enables picking, stated up front and in the denied-state copy.
- [ ] **IMP-02** — The screen opens on **Direct**; AI-assisted is opt-in from the options sheet.
- [ ] **IMP-03** — The default contact type follows the **launching roster tab**, and is adjustable per contact in the Review-each form (all three types).
- [ ] **IMP-04** — Layout: the device-contact list fills the screen with only search + the selection row above it; configuration lives in the **"Import options"** sheet (a plain stack of switches — "Review contact info" on by default, "AI Assistant" off), each with an **ⓘ** info button (never an eye) revealing its hint independent of the switch state. No separate web-lookup toggle. The footer chip reads a static "Import options".
- [ ] **IMP-05** — Every contact row is **fully tappable** to toggle selection; there is no per-row type switch.
- [ ] **IMP-06** — All of a device contact's phones and emails carry through as labeled multi-values; the first of each is the primary.
- [ ] **IMP-07** — Imported phones are **canonicalized to E.164 at import**, so an imported contact's number resolves a household/trip/calendar invite by exact match. **⛔ BLOCKER (silent-non-match class).**
- [ ] **IMP-08** — **iOS limited contacts access**: the info banner offers **Choose more contacts** (re-presenting Apple's picker in-app on iOS 18+, preserving the in-progress selection) and **Full access in Settings**. A **first** import under limited access **auto-selects** the shown subset, one-shot (a later manual deselect sticks).
- [ ] **IMP-09** — The `denied` state offers **Open Settings**, not a dead end.
- [ ] **IMP-10** — Already-imported contacts carry an **"Imported"** badge; matching falls back from `deviceContactId` to shared phone (both canonicalized) / shared email / exact full name; re-selecting one triggers a duplicate confirm that never blocks the import.
- [ ] **IMP-11** — The picker **loads and decrypts the roster** even when reached before the People list has fetched (an offline/failed fetch degrades to cache). **Hide imported** is always shown and defaults **on**.
- [ ] **IMP-12** — **AI-assisted** classification sends **name and company only** (verify at the network edge if possible, otherwise via the spec's integration test); phone/email/birthday merge back server-side.
- [ ] **IMP-13** — Web-search enrichment of professionals is implied by the AI method (`enrich: true`), disclosed in the AI switch's hint, and scoped to `service` contacts only.
- [ ] **IMP-14** — AI-assisted is **hidden** when either `aiEnabled` or `aiUsePersonalInfo` is off, with an explanation and a fall back to Direct; `/classify` also 403s server-side.
- [ ] **IMP-15** — **Out of credits** forces Direct + Review-each, explaining why; `unlimited` admins are exempt; the gate is optimistic until billing resolves.
- [ ] **IMP-16** — **Review-each queue**: header title `Review N of M`, header check saves-and-advances (tinted the app primary here, deliberately), a **Skip** button only for a multi-contact queue ("Skip & finish" on the last), and a single-contact import shows no skip.
- [ ] **IMP-17** — A **Direct**-import review hides the "Ask Calen" panel; an **AI-assisted** review keeps it.
- [ ] **IMP-18** — vCard import (`POST /people/import`) parses FN/N names, folded lines, labeled multi-value TEL/EMAIL/URL, BDAY (dropping no-year dates), structured ADR, NOTE; each person is sealed and created through `/records`.
- [ ] **IMP-19** — A bulk import writes one record per contact but coalesces into a **single** calendar invalidation.

### 14.3 Export & share

- [ ] **EXP-01** — **"Also save to iPhone Contacts"** switch (default off) shows only when *creating* a brand-new Calen contact — not on edit, not in an import review, not on the self card. On save it writes to the device and stores `deviceContactId`.
- [ ] **EXP-02** — **"Add to iPhone Contacts"** on the detail view writes the contact; with `deviceContactId` already set it confirms before adding another copy.
- [ ] **EXP-03** — A denied write permission surfaces a note and **never blocks** the in-app save.
- [ ] **EXP-04** — **Share** builds a valid vCard 3.0 (structured N/FN, ORG/TITLE, labeled TEL/EMAIL/ADR/URL, BDAY, values escaped), hands it to the OS share sheet as `.vcf`, and the result imports cleanly into Apple Contacts. A name-only contact can still be shared.

---

## 15. AI assistant (Calen)

Spec: [ai-assistant.md](../specs/features/ai-assistant.md)

### 15.1 Chat mechanics (test on all four surfaces: calendar, chores, maintenance-plan, per-trip)

- [ ] **AI-01** — A turn streams via SSE and completes; the reply renders as plain text with markdown flattened.
- [ ] **AI-02** — **No markdown tables** — ask for availability/options in a tabular shape and confirm the model answers with labeled lines or a bulleted list, never raw pipes.
- [ ] **AI-03** — The calendar assistant is **terse** — a sentence or two, no preamble/filler/sign-offs — while still giving the recap-before-save and "nothing is saved until you tap" confirmations.
- [ ] **AI-04** — Follow-up chips arrive inline **under that turn's own bubble**; scrolling back, **every past turn keeps its own chips** and they stay tappable, acting on **that turn's** draft.
- [ ] **AI-05** — A used **direct-create** chip ("Save this to my calendar") renders **visible but disabled** with a check afterward and cannot double-create. **Form-opening** chips ("Edit in form", "Review & add chore") stay active.
- [ ] **AI-06** — The **working indicator** persists for the whole turn — below the last user message before text arrives, then below the partial reply — and only clears when the turn resolves.
- [ ] **AI-07** — Mid-turn the send button becomes **Stop**; tapping it interrupts and **keeps** whatever streamed as the reply. `stop` is a no-op when idle.
- [ ] **AI-08** — An **unanswered** user bubble (errored or stopped before any text) shows an inline **resend** icon; a delivered turn hides it, and an out-of-credits turn suppresses it (the buy-credits notice stands instead).
- [ ] **AI-09** — Submit **dismisses the keyboard** and the composer's text field visibly empties (both the state clear and the imperative ref clear).
- [ ] **AI-10** — **Scroll-aware keyboard**: scrolling up dismisses it; only a deliberate finger-down pull **past** the bottom (>24px into the bounce) summons it back — never screen open, auto-scroll, or a fling's momentum overshoot.
- [ ] **AI-11** — **Stick-to-bottom**: auto-follows only while parked at the bottom; scrolling up **freezes** the view while tokens keep arriving; the floating **jump-to-latest** chevron appears whenever scrolled up (hidden on the empty state) and re-engages following. A fresh user send always snaps to the bottom; the assistant's end-of-turn commit does not.
- [ ] **AI-12** — The composer stays live **while a turn streams** (type/dictate the next message; it waits for the reply).
- [ ] **AI-13** — **History**: conversations persist per user **and** per surface for 7 days (capped 50/surface, pruned on read and write); attachment base64 is stripped before persisting; signed out, nothing persists. **Nothing is stored server-side.**
- [ ] **AI-14** — Header actions: the **history clock** opens the Recent-chats sheet; **compose** starts a new chat (rotating the conversation id) and the previous one stays resumable.
- [ ] **AI-15** — The Recent-chats sheet is **unified across all four assistants**, newest first, each row tagged with its assistant's tinted tab icon and "Tab · 3h ago · N messages".
- [ ] **AI-16** — Resuming a chat **on the current surface** loads in place; a chat from **another** assistant hands off (target tab selected; a trip chat pre-selects its trip). Resuming restores the transcript and credit total and bumps the timestamp.
- [ ] **AI-17** — The sheet's **keyword search** filters live, AND-ing tokens across the title **and** every message, case-insensitively; the query resets when the sheet closes; the sheet is tall (~72% list, ≤92%) and its rows scroll.
- [ ] **AI-18** — **History cap**: only the last 20 messages go to the model, and only the **latest** user message carries raw attachment bytes (older attachments become a short text note).
- [ ] **AI-19** — Attach an image and a PDF to a turn and confirm the model reads them.

### 15.2 Voice dictation

- [ ] **AI-20** — Mic → on-device recognition; the live transcript streams into the field for review before sending. **Nothing sends until the user taps send.**
- [ ] **AI-21** — **Continuous mode**: a mid-thought pause does not end the session; the silence timeout (10s, re-armed on every result) auto-finalizes an abandoned one; the composer always receives the whole utterance since mic-press.
- [ ] **AI-22** — Dictation **augments, never replaces**: dictating into a half-typed message splices at the caret with correct spacing at both seams; a selected range is replaced.
- [ ] **AI-23** — In the speak-pause-tap-again flow (field not focused), words **append at the end**, never prepend at position 0.
- [ ] **AI-24** — Tapping **send while the mic is capturing** toggles dictation off and discards the in-flight utterance (no trailing final result re-populating the just-cleared field).
- [ ] **AI-25** — Mic/speech permission is requested on first use; denial shows a settings prompt, not a crash. `aiEnabled` off hard-gates the surface.
- [ ] **AI-26** — Dictation adds no cost of its own.

### 15.3 Tools, links & navigation

- [ ] **AI-27** — **Web search** runs inside a turn ("Searching the web…" activity hint), respects `max_uses: 3`, and resumes correctly across a `pause_turn`.
- [ ] **AI-28** — **Place links** (`[Name](place:Name, City)`) open the **native Google Maps app** when installed, else the `PlacePreview` modal WebView (title = the tapped name, header compass opens externally); closing resumes the conversation exactly where it was.
- [ ] **AI-29** — **Search links** (`[search "q"](search:q)`) open the query in the default browser. **Raw URLs never appear** in a reply.
- [ ] **AI-30** — A half-streamed trailing link marker never flashes raw markup mid-stream.
- [ ] **AI-31** — **`verify_place`**: ask for a restaurant recommendation and confirm a permanently-closed/not-found place is silently dropped, the returned name/address/phone are reused when pre-filling a form, and an API outage fails **open** ("unknown" → suggestions still appear). Verify it is **not** credit-charged. Activity hint reads "Checking if it's still open…".
- [ ] **AI-32** — A turn combining a **web search + a client tool** (verify_place, open_create_event_form) does not 400 (container id threading).
- [ ] **AI-33** — **Nav chips** (arrow) push the target **on top of** the assistant so the conversation is preserved beneath, with a working back affordance. `view_calendar` pushes a `fromAssistant` CalendarHome whose FAB slot shows the "‹ Calen" return pill (and iOS swipe-back).
- [ ] **AI-34** — **Setup chips** (gear) appear **reactively only** (when a task actually hits the gap), replace that turn's nav chip, and deep-link to the exact screen **and field** with a `SetupCallout` banner + field highlight. Test all six: `setup_ai_personal_info`, `setup_household`, `setup_home_address`, `setup_event_phone`, `setup_contact`, `setup_reminders`.
- [ ] **AI-35** — The chip payload carries **no personal data** — only a screen id and label.
- [ ] **AI-36** — **`open_create_event_form`** puts the place name + full street address in `location` and the business number in `phone` — never buried in `description`. Both "Save this to my calendar" and "Edit in form" preserve them onto the record.
- [ ] **AI-37** — On "Edit in form", the fields the assistant populated are **highlighted**, but date/time/all-day are **not**.
- [ ] **AI-38** — **`open_edit_event_form`** stages the edit and pins an "Open the event to edit" chip that opens the native form. The model must **not** claim the event was changed before the tap.
- [ ] **AI-39** — **`delete_event`**: several deletes in one turn ("clear my calendar next week") accumulate under a **single** "Delete from my calendar" chip; confirming deletes them all through the same `lib/eventDelete` logic (occurrence vs series); the chip retires so it can't double-delete; "Cancel, keep events" falls through to an ordinary send; only Activities/Appointments events are eligible.
- [ ] **AI-40** — **`get_availability`**: timed events are busy hour-blocks, trips are away days, all-day events are a **soft note that keeps the day free**, and tasks/chores/meals/grocery/occasions are **never** counted. The waking window is 08:00–22:00 in the household timezone.
- [ ] **AI-41** — `get_household_members` returns household + friends **by name only** plus professionals with business details and `phoneOnFile`/`emailOnFile` **flags** — never phone/email values.
- [ ] **AI-42** — `list_events` returns titles/dates/recurrence only; `get_event_details` returns one event's description/location on request.

### 15.4 Consent & data minimization — **⛔ privacy-critical**

- [ ] **AI-43** — `aiEnabled` **off** makes every AI surface unusable and blocks scans/extracts; server-side, every AI route 403s (verify at least one route with a direct request if possible).
- [ ] **AI-44** — Both toggles live in the **Artificial intelligence** card on Privacy & security, not on Credits.
- [ ] **AI-45** — Every AI surface shows the "sent to Anthropic" indicator.
- [ ] **AI-46** — `aiUsePersonalInfo` **off**: the calendar assistant omits the people roster, form-assist omits its contacts context, and AI-assisted contact import is hidden.
- [ ] **AI-47** — `aiUsePersonalInfo` **off** also **withholds the calendar records**: only title-stripped free/busy availability is sent; the record tools (`list_events`, `get_event_details`, `open_edit_event_form`, `delete_event`, `call_business`, `check_call_status`) are **absent from the tool list and refused if invoked**; the reduced system prompt is used; the assistant can still plan around free/busy, create new events, and use weather/web/navigation.
- [ ] **AI-48** — The **"what I can see" panel** reflects the reduced scope, and names the **general area** ("…never your street address") when `homeCity` is set.
- [ ] **AI-49** — The **street address is never sent** — only the coarse `homeCity`. Setting the address any way (autocomplete pick, GPS fill, typed-and-blurred) fills the area automatically; an idle focus/blur or re-picking the same place never re-geocodes or clobbers a hand-set area; the manual "Fill from home address" button re-derives on demand.
- [ ] **AI-50** — Friends & family are **name-only** in every payload — no birthdays, ages, addresses, relationships, or notes.
- [ ] **AI-51** — Payloads are **aliased** (no database ids) and **query-scoped** to a conversation-derived date window — a single question never ships the whole calendar.
- [ ] **AI-52** — Booking confirmation codes appear to the trip assistant as "on file" only.

### 15.5 Phone calls (Vapi) — **use a number you control**

- [ ] **AI-53** — Place a cancel/reschedule call from the Event Action screen; the agent **discloses it is an AI assistant** at the start.
- [ ] **AI-54** — The **flat call price** ("~N credits/min from your AI credits, billed by the second") shows above the CTA before the call.
- [ ] **AI-55** — **"Share my contact details if asked"** defaults **off**: with it off the prompt carries name only and no phone/email; with it on they ride as share-if-asked. The legacy `/calls/cancel-event` route never sends them.
- [ ] **AI-56** — No **recording** and no **transcript** survive the call (verify in the Vapi dashboard); the app shows status/outcome/summary only.
- [ ] **AI-57** — The **summary is PII-constrained** — outcome facts only, no names/numbers/emails/addresses/confirmation numbers; parties are "the business" and "the client". **⚠️ RISK — verify on a live call; the spec flags this as unverified since the transcript plan changed.**
- [ ] **AI-58** — **Do-not-call**: ask the agent (as the recipient) not to be called again → the number is suppressed **immediately** via the webhook, `dncCaptured` is set, and the Interaction view shows the explicit "asked not to be called again" notice.
- [ ] **AI-59** — The **backstop** path works when the webhook isn't wired (`doNotCallRequested` honored on the next lazy refresh).
- [ ] **AI-60** — A suppressed number **disables** the Event Action call button with a one-line reason; the chat `call_business` path surfaces the DNC error conversationally; the suppression is **platform-wide** (a second household is also blocked).
- [ ] **AI-61** — Admin add/release of DNC numbers works and is audited; only the HMAC + last4 are stored, never the raw number.
- [ ] **AI-62** — **Outcome resolution**: a confirmed cancellation shows the conclusion + View call details + **Dismiss** on the event view; the event stays dimmed/struck until deleted; **Dismiss acknowledges** and clears the marking everywhere (it does not delete the event).
- [ ] **AI-63** — A confirmed **reschedule** offers **Update event time** (opening the form — the time is not applied automatically) or Dismiss.
- [ ] **AI-64** — A call that **couldn't confirm** can be retried, and a cancel that couldn't confirm can be marked cancelled by hand.
- [ ] **AI-65** — Deleting the event from the Interaction view pops **past** the deleted event's detail/action/form screens.
- [ ] **AI-66** — The Invitations notice card carries **no inline action** — it opens the Interaction view on tap.
- [ ] **AI-67** — Call outcomes **never** surface on the assistant view (no recent-calls list, no unseen badge on the Calen icon).
- [ ] **AI-68** — Placing a call with an insufficient balance is refused **before** dialing (one-minute pre-check).

---

## 16. Notifications & reminders — **⛔ high-regression area**

Spec: [notifications.md](../specs/features/notifications.md)

### 16.1 On-device reminders

- [ ] **NTF-01** — Set an alert on an event **10 minutes out**, keep the app in the foreground → the notification arrives. **This trigger (reschedule on any `['calendar']` invalidation) is normative — without it an alert set in the same session never fires.** **⛔ BLOCKER.**
- [ ] **NTF-02** — The same with the app backgrounded, and with the app force-quit.
- [ ] **NTF-03** — The rolling window holds the soonest **60** reminders within **21 days**; a reminder further out appears once the window reaches it.
- [ ] **NTF-04** — `remindersEnabled` off cancels every scheduled reminder; back on re-schedules.
- [ ] **NTF-05** — **A recurring chore does not suppress the whole batch.** With ≥1 recurring chore *and* a near event alert scheduled, both fire — a single bad row must never abort the pass. **⛔ BLOCKER (this previously killed every reminder in the app).**
- [ ] **NTF-06** — A malformed reminder (invalid date, over-long title) costs only itself; a pass placing some reminders reports `ok`.
- [ ] **NTF-07** — **Bodies**: a timed event-anchored alert reads `Starts in 23 minutes` / `Starting now`; a **departure**-anchored one reads `Leave in 23 minutes` / `Leave now` (the drive subtracted back out); one event's two slots word themselves **independently**.
- [ ] **NTF-08** — Durations are exact — 90 minutes reads `1 hour 30 minutes`, never `2 hours`, and never a calendar word (`Starts in Tomorrow` must be impossible).
- [ ] **NTF-09** — Day-based reminders (all-day events, tasks, chores, occasions, holidays) read the bare interval — `Today` / `Tomorrow` / `N days`, with exact multiples of seven as `N weeks` — and carry **no** record-kind label and **no raw yyyy-mm-dd**.
- [ ] **NTF-10** — An event whose location was removed keeps its stale `'leave'` flag but falls back to `Starts in …`.
- [ ] **NTF-11** — **All-day alerts fire at the user's day-alert hour in the local zone.** Set an all-day event with "1 day before" and confirm it fires at 9am local — in `America/Los_Angeles`, `America/New_York`, **and** `Europe/Berlin`. **⛔ BLOCKER (it previously landed at 5am / 8am / 2pm).**
- [ ] **NTF-12** — Change `dayAlertTime` on the Reminders screen → day-based reminders reschedule to the new time (the on-device scheduler honors the full `HH:mm`; the server cron only the hour).
- [ ] **NTF-13** — A chore/task's per-item `reminderTime` overrides the account default for **both** its alerts; unset falls back.
- [ ] **NTF-14** — Occasion reminders use the calendar-level config; the Occasions Alerts switch mutes them; holiday reminders use the shared holiday config and are muted by each holiday calendar's Alerts switch.
- [ ] **NTF-15** — Both calendar-level configs **survive a sign-out** (account-backed); `offsets: []` stays a real "off" and does not revert to the defaults; a device holding a non-default config seeds an account that has none.
- [ ] **NTF-16** — **Timezone stickiness**: change the device timezone and **return to the foreground** (without relaunching) → `User.timezone` updates; a write is issued only when the zone actually changed. There is no user-facing timezone picker.
- [ ] **NTF-17** — Saving a home address derives `Household.timezone` from the location (validated IANA), client-side.
- [ ] **NTF-18** — The pass is **single-flight** — foreground + a data change at once must not double-schedule (no duplicate notifications).
- [ ] **NTF-19** — The `localReminders` duplicate-guard is claimed **only after** the OS accepts the batch, and released on a failed pass, so neither side goes silent.
- [ ] **NTF-20** — The run log (`hc_reminder_run_log`) records `ok`/`disabled`/`no-permission`/`error`, names the failing stage (`load`/`prefs`/`compute`/`cancel`/`schedule`), survives a relaunch, and emits a `console.warn` with the stack. Nothing renders it.
- [ ] **NTF-21** — The Reminders screen shows only the `denied` banner + **Open Settings** row — **no diagnostics/Delivery card** (it was removed pre-launch). **⛔ BLOCKER — confirm it is gone from the shipping build.**
- [ ] **NTF-22** — Notification permission denied → reminders degrade silently and the banner offers the fix.
- [ ] **NTF-23** — With **>60 reminders** in the window, the soonest ones win and later ones appear as the window advances.

### 16.2 Push

- [ ] **NTF-24** — The device registers its Expo token **after sign-in** and again on every foreground (the permission prompt never fires on the auth screens); a permission granted later in iOS Settings is picked up.
- [ ] **NTF-25** — Denied push degrades to the in-app Invitations inbox.
- [ ] **NTF-26** — **Tap routing**: `household_event_request`, `event_invitation`, `household_invite`, `calendar_invitation`, `trip_invitation` land on the **Invitations inbox**; `household_event_response` opens **that event's detail**; unknown types just open the app.
- [ ] **NTF-27** — **Cold-start** taps route correctly (the app was force-quit).
- [ ] **NTF-28** — Security alerts (factor/member/key/device changes) arrive as pushes carrying **no content**.
- [ ] **NTF-29** — Relay pushes for household invites/responses carry the client-chosen strings; the relay stores nothing and is rate-limited (30/min per IP).
- [ ] **NTF-30** — Sign-out stops the pushes (§AUTH-53).

---

## 17. Live household sync (needs two devices)

- [ ] **SYN-01** — **Foreground**: A creates/edits/deletes an event → it appears on **B's** open calendar without a manual refresh, within a few seconds.
- [ ] **SYN-02** — The poke socket reconnects with backoff after a network drop; every (re)connect schedules a revalidate.
- [ ] **SYN-03** — The socket is torn down on background and reopened on foreground.
- [ ] **SYN-04** — A revoked session's token is rejected on the socket.
- [ ] **SYN-05** — **Background**: with B's app backgrounded, A writes → the silent data-only push (`records_changed`, **no banner ever shown**) wakes B's app, the replica syncs, and on B's next foreground the calendar is already fresh (the dirty flag invalidates `['calendar']`).
- [ ] **SYN-06** — **Every foreground transition** schedules a revalidate regardless.
- [ ] **SYN-07** — A burst of writes coalesces: the 10s floor **parks one trailing pass** rather than dropping a poke; staleness is bounded.
- [ ] **SYN-08** — The **writer's own session** is excluded from the poke, but the writer's **other** devices are poked (sign in on a third device to verify).
- [ ] **SYN-09** — A revalidate that finds nothing changed ends **quietly** — no invalidate/refetch cycle (watch for a spinning grid or runaway network activity).
- [ ] **SYN-10** — Resource-scoped collaborators are not poked in v1 — C's device converges on the normal triggers (foreground/refresh), not instantly. Confirm this is acceptable and not read as a bug.
- [ ] **SYN-11** — A trip deleted server-side is **removed** from the replica by the reconcile pass, not left to age.
- [ ] **SYN-12** — The `remote-notification` background mode is present in the shipped build (silent pushes no-op without it — this needed an EAS rebuild).

---

## 18. Offline & data integrity

- [ ] **OFF-01** — Airplane mode, warm cache: the calendar, people, meals, tasks, and trips all paint from the **replica** immediately (cache-first) with no spinner.
- [ ] **OFF-02** — A **never-synced** device (fresh install / post-account-switch cursor reset) falls back to an inline load and shows **skeletons**, never an empty calendar that reads as "no events".
- [ ] **OFF-03** — Month grid first load shows **per-cell skeleton placeholders** shaped per density (not a floating spinner); the List layer shows `SkeletonList`, not a premature "Nothing scheduled.".
- [ ] **OFF-04** — **Holiday chips render on mount**, independent of the network-backed query.
- [ ] **OFF-05** — Offline **writes**: create an event offline → the error is clear and the draft is not lost; reconnect → confirm the intended end state (either it saved or it clearly didn't — nothing half-applied).
- [ ] **OFF-06** — **A write appears immediately and correctly on-device** — the replica row must decrypt to what it displays (never a stale render forcing the user to do the same action twice). **⛔ BLOCKER.**
- [ ] **OFF-07** — Kill the app mid-save; relaunch → no duplicate, no corrupt row.
- [ ] **OFF-08** — Sync a large household (≥1000 records) from scratch and time it; the UI stays responsive and nothing is dropped.
- [ ] **OFF-09** — Tombstones propagate: a delete on A removes the row on B, including after B was offline for the whole window.
- [ ] **OFF-10** — Airplane mode on the **AI** surfaces, the **paywall**, and **purchase** flows: each shows an actionable failure, never an infinite spinner.

---

## 19. Weather

- [ ] **WX-01** — The **location chip** above the hero is the only source picker (icon + current-source label + chevron); it sits **below** the transparent header band and is tappable from every entry path.
- [ ] **WX-02** — **My location** (default): first open triggers the iOS permission ask; the fix is fetched **client-direct** from open-meteo.
- [ ] **WX-03** — Permission **denied** → an actionable card with Open Settings + "Use home address". Native module **unavailable** → the reinstall note + "Use home address". Never a dead screen.
- [ ] **WX-04** — **Home** source uses the E2EE-aware address path.
- [ ] **WX-05** — **Another location**: the inline city autocomplete applies on **selecting a suggestion** (free text alone is never accepted); the place shows as the row's subtitle.
- [ ] **WX-06** — The chip renders **above** the loading/error branches so a broken source can always be switched away from.
- [ ] **WX-07** — **No home address** (home source) → the "Set home address" card navigating to Account with the field highlighted; while it shows, the **90-day outlook is hidden**. Other failures show a plain retry message instead.
- [ ] **WX-08** — Saving the address from there refreshes the Weather screen behind Account **without** re-showing its cached error.
- [ ] **WX-09** — **Forecast strip** in the month grid (lane 0, tinted with the Weather calendar's colour) shows in Details and Stacked, hides in Compact, splits across week rows, clips at month boundaries, and opens the Weather screen on tap.
- [ ] **WX-10** — **Passive weather never prompts** — the day-view rail, List glance, and assistant context use live location only when already granted, else home, else nothing.
- [ ] **WX-11** — Rain icons: the cloud is **identical** across light/moderate/heavy; only the streak count changes; no blue cloud peeks past the white one.
- [ ] **WX-12** — Thunderstorm: white cloud + blue drops + gold bolt; no gold/blue edge above or beside the cloud, and the bolt actually renders (the clipped-glyph width bug).
- [ ] **WX-13** — Rain quantities format via `formatMm` (one decimal under 1 mm, whole numbers above, hidden under 0.1 mm) on the hero meta line, the 7-day rows, and every hourly slot.
- [ ] **WX-14** — Geocoding falls back Nominatim → Photon client-side; the whole-chain failure surfaces the primary's message.

---

## 20. Feedback & support

- [ ] **FB-01** — Profile → **Help & feedback** is reachable by any authenticated user.
- [ ] **FB-02** — Type (question/bug/idea, default question), message (**required** — submit disabled when empty/whitespace), and an editable/clearable reply-to email defaulting to the account email.
- [ ] **FB-03** — **Diagnostics are shown before sending**: app version + build, platform, OS version, device model, the route the user came from, locale. Confirm they contain **no household content, secrets, or precise location**.
- [ ] **FB-04** — Rate limit (20/15 min) returns 429 with a readable message; a failed submit shows an inline error and **does not lose the draft**.
- [ ] **FB-05** — Leaving with an unsent message prompts the discard confirm; a successful send leaves without prompting and confirms.
- [ ] **FB-06** — The submission appears in the admin portal Feedback view newest-first with the reporter's email resolved; the status transitions `new → triaged → resolved` are audited and the nav badge counts `new`.

---

## 21. Permissions matrix

For each: **not-yet-asked → prompt → granted**, and **denied → the app's recovery path**. Never a crash, never a dead end.

- [ ] **PRM-01** — **Notifications** — requested post-sign-in (never on auth screens); denied → Reminders screen banner + Open Settings; granting later in iOS Settings is picked up on the next foreground.
- [ ] **PRM-02** — **Camera** — item/recipe/receipt/confirmation photo capture; usage string matches `app.json`.
- [ ] **PRM-03** — **Photo library** — attachments, e-card photos, recipe/item imports; test **limited** photo access too.
- [ ] **PRM-04** — **Contacts (read)** — import; **limited** access banner + Choose more contacts + Settings deep link (§IMP-08).
- [ ] **PRM-05** — **Contacts (write)** — "Save to iPhone Contacts"; denial surfaces a note and never blocks the in-app save.
- [ ] **PRM-06** — **Location (when in use)** — Weather "My location", "Use my current location" on Account, and the travel-time Current-location shortcut. Confirm it is **never** requested by a passive surface.
- [ ] **PRM-07** — **Face ID / Touch ID** — unlock, app lock, re-auth for password/email change; denial or unavailable hardware falls back to the password path.
- [ ] **PRM-08** — **Microphone + speech recognition** — dictation; on-device recognition only (the usage string promises voice isn't sent to Apple — confirm `requiresOnDeviceRecognition: true`).
- [ ] **PRM-09** — Every iOS usage string in `app.json` is accurate, user-legible, and matches what the app actually does. **⛔ BLOCKER (App Review).**
- [ ] **PRM-10** — Revoke each permission in iOS Settings **while the app is backgrounded**, then return — no crash, correct degraded state.

---

## 22. Accessibility

- [ ] **A11Y-01** — **VoiceOver** can complete the core journeys: sign in, create an event, set an alert, navigate the month grid, open a day, use the assistant, buy the unlock.
- [ ] **A11Y-02** — Every icon-only control has an `accessibilityLabel` — header buttons, the FAB, the Today/Calendars pill, the density switcher, the ⓘ disclosures, clear-✕ buttons, the jump-to-latest chevron.
- [ ] **A11Y-03** — Calendars rows expose `accessibilityRole:"switch"` with the correct checked state.
- [ ] **A11Y-04** — **Dynamic Type at the largest accessibility size**: no clipped labels, no unreachable buttons; specifically check the paywall CTA, the viewer restore screen, the Invitees zones, the event form rows, and the bottom sheets' last rows.
- [ ] **A11Y-05** — Tap targets are ≥44pt — including the ⓘ label rows, the link rows on the paywall (13px text needs its `paddingVertical`), and the Location card's ✕.
- [ ] **A11Y-06** — Colour contrast in **both** light and dark, especially the accent-tinted text on chips, bars, and calendar cells.
- [ ] **A11Y-07** — **Reduce Motion**: the bottom-sheet slide, the crossfade between calendar layers, and the e-card preview's bobbing art respect it.
- [ ] **A11Y-08** — State is never conveyed by colour alone (dimmed/struck cancelled events also carry the strike; the visibility circle also changes shape).
- [ ] **A11Y-09** — Keyboard/hardware-keyboard navigation on iPad if iPad ships.

---

## 23. Performance, stability & resource use

Seed a **heavy** household first: ≥1000 events (200 recurring), 500 contacts, 200 tasks/chores, 50 recipes, 20 trips, ≥50 attachments.

- [ ] **PERF-01** — **Cold start to first painted calendar** with a warm cache — target under ~2s, and the first frame carries the user's colours.
- [ ] **PERF-02** — Month grid scrolling stays at 60fps through 24+ months of window growth; extending an edge expands only the added months.
- [ ] **PERF-03** — Density switching is instant on a heavy month (§VW-05).
- [ ] **PERF-04** — The month/year jump sheet opens and dismisses instantly on a heavy calendar.
- [ ] **PERF-05** — Saving an event repaints in **one pass, one re-render**, with the previous frame held until the recompute lands.
- [ ] **PERF-06** — Day view swiping between days and the single↔multi switch stay smooth.
- [ ] **PERF-07** — Contacts roster scroll + scrubber jumps stay smooth at 500 contacts.
- [ ] **PERF-08** — A **long chat** (50+ turns with attachments) doesn't degrade scroll or blow memory; history pruning keeps the store bounded.
- [ ] **PERF-09** — Memory: no growth trend across 30 minutes of navigation; run Instruments for leaks on the month grid ⇄ day view ⇄ event form loop.
- [ ] **PERF-10** — Battery/network: no runaway polling. Watch for the invalidate → refetch → revalidate cycle and for the 15s viewer poll running when it shouldn't.
- [ ] **PERF-11** — Disk: the sqlite replica and attachment cache grow bounded; verify the app's storage footprint after the heavy pass.
- [ ] **PERF-12** — **No crashes** in a 60-minute exploratory session per device. Collect and triage any crash logs.
- [ ] **PERF-13** — Backgrounding for >30 minutes and returning restores state (no blank screens, no lost form drafts, correct re-lock behavior).
- [ ] **PERF-14** — Low-storage and low-power modes don't break sync or reminders.

---

## 24. Security & privacy verification

- [ ] **SEC-01** — **Screen security** (default on): screenshots/recording are blocked and the app-switcher shows the `PrivacyShield` cover, not content. Toggling it off re-enables screenshots. **⚠️ RISK — no automated coverage.**
- [ ] **SEC-02** — **App lock**: Never / 0 / 1 / 5 min settings each behave correctly after backgrounding; the unlock prompt is Face ID with a working fallback. **⚠️ RISK — no automated coverage.**
- [ ] **SEC-03** — The JWT lives in `expo-secure-store` and the device id in the keychain; neither appears in AsyncStorage or logs.
- [ ] **SEC-04** — No secrets, tokens, record content, or decrypted household data appear in console output in a **release** build.
- [ ] **SEC-05** — **Deep links**: the `householdcalendar` scheme cannot be used to reach a paywalled or locked screen with data; a malformed deep link is ignored.
- [ ] **SEC-06** — Server enforcement holds regardless of the client: a `view` collaborator's write 403s; a record POST claiming a foreign calendar scope 403s; a scope-less update body is gated by the **stored** scope.
- [ ] **SEC-07** — Rate limits on auth, key, and join endpoints return 429s the app handles gracefully.
- [ ] **SEC-08** — The public endpoint list is exactly as specified (§api-reference) — nothing else is unauthenticated.
- [ ] **SEC-09** — `POST /api/billing/webhook` rejects an unsigned/incorrectly-signed body.
- [ ] **SEC-10** — Confirm at the DB/admin level that a newly created record carries **no** plaintext content and **no** `userId` on an active household.
- [ ] **SEC-11** — The **deliberate plaintext exceptions** are exactly: outside-shared trips/calendars, non-account event invitations, AI phone-call essentials, occasion e-cards (text + photos), feedback, and the DNC hash list. Nothing else leaves encryption. **⛔ BLOCKER — audit before launch.**
- [ ] **SEC-12** — `docs/TRANSPARENCY.md` and `docs/CRYPTO-SPEC.md` §7 match reality (both still list the household name and `nextDueDate` as server-visible; both are now sealed). Reconcile before publishing them. **⛔ BLOCKER (truthfulness of a public privacy claim).**
- [ ] **SEC-13** — Run the pre-launch **E2EE prod residue** steps in [release.md](../specs/operations/release.md): re-seal the two grandfathered households from their owners' unlocked devices, `reDropPlaintext.js --commit` each, `dropContentCollections.js --commit`, delete the 4 zero-member orphan households, then re-run the residue audit clean. **⛔ BLOCKER.**
- [ ] **SEC-14** — Clipboard: the recovery code and safety codes copy correctly; nothing sensitive is written to the clipboard unprompted.
- [ ] **SEC-15** — Certificate/ATS: the app makes no plain-HTTP calls in the production build.
- [ ] **SEC-16** — Passkey RP id (`householdcalendar.com`) and the associated-domains file are served correctly so passkeys work in the production build — the TestFlight limitation must **not** persist to the App Store build. **⛔ BLOCKER.**

---

## 25. App Store review readiness

- [ ] **REV-01** — **Account deletion** is reachable in-app (Profile → Account → Delete account) — Guideline 5.1.1(v). ✅ via §2.7.
- [ ] **REV-02** — All digital purchases use **IAP only**; no external purchase links or alternative payment references anywhere in the app — Guideline 3.1.1.
- [ ] **REV-03** — **Restore Purchases** is present and functional on the paywall and the Add-ons screen — Guideline 3.1.1.
- [ ] **REV-04** — Subscription disclosure for the Calen AI plan states price, duration, and what it grants **adjacent to the CTA**; Terms of Use (EULA) and Privacy Policy links are present — Guideline 3.1.2.
- [ ] **REV-05** — The add-ons screen is titled **"Add-ons"**, never "App Store" — Guideline 5.2.5.
- [ ] **REV-06** — Sign-in is **not required** to browse nothing — confirm the app's gating is defensible: signup/login and household join are free; the hard paywall follows. If review pushes back, the free-viewer path is the answer; have it demonstrable.
- [ ] **REV-07** — A **demo account** with data, unlock, add-ons, and credits is prepared for App Review notes, plus instructions for the paywall, the AI features, and (if relevant) how to reach the viewer shell.
- [ ] **REV-08** — **Privacy nutrition labels** in App Store Connect match `app.json`'s `privacyManifests` and the actual collection (email, name, contacts, other user content; no tracking).
- [ ] **REV-09** — **Export compliance**: `ITSAppUsesNonExemptEncryption: false` is declared while the app performs end-to-end encryption. Confirm the exemption genuinely applies (standard encryption for the app's own data) or change the declaration and file the annual self-classification report. **⛔ BLOCKER — get this right.**
- [ ] **REV-10** — No **beta/TestFlight-only** language, debug menus, or diagnostics surfaces in the shipping build (§NTF-21).
- [ ] **REV-11** — App metadata: name, subtitle, description, keywords, screenshots (per required device size), promotional text, support URL, marketing URL, age rating, and the privacy policy URL are all present and accurate.
- [ ] **REV-12** — Screenshots do **not** show real personal data or contradict the shipped UI.
- [ ] **REV-13** — AI content: the app discloses that AI features send data to Anthropic; there is a report path for AI content (the moderation long-press) — Guideline 1.2 for UGC-adjacent AI.
- [ ] **REV-14** — The **AI phone-call** feature is described honestly in the metadata and the agent discloses it is an AI — check for any jurisdictional disclosure requirement.
- [ ] **REV-15** — iPad screenshots + behavior if `supportsTablet` stays true (§DEV-04).
- [ ] **REV-16** — Third-party notices/licenses are present if required.

---

## 26. Upgrade, migration & first-launch-after-update

- [ ] **UPG-01** — Install the **currently shipped TestFlight build**, use it (create data, set colours, schedule reminders, sign in), then install the release candidate **over** it. Everything survives: session, replica, prefs, chat history, scheduled reminders.
- [ ] **UPG-02** — A user whose calendar arrangement was **device-only** (pre-account-backed) has it seeded onto the account on the first launch of the new build, not lost.
- [ ] **UPG-03** — An account whose add-ons were **household-owned** has them after the backfill (§BILL-47) — verify a real customer-shaped account, not just a fresh one.
- [ ] **UPG-04** — Events damaged by the historical re-seal truncation are repaired by `repairCalendarLaneEvents` on the owner's first unlock (routing restored; the unrecoverable fields are documented as lost).
- [ ] **UPG-05** — Legacy alert values (off-grid all-day offsets, missing `alertAnchor`) still fire and render sensibly rather than falling back to a placeholder.
- [ ] **UPG-06** — Legacy contacts (single `name`, legacy single phone/email/address) display correctly and re-canonicalize on their next edit.
- [ ] **UPG-07** — Legacy e-card rows with `template: <kind>` resolve to the kind's default style.
- [ ] **UPG-08** — A legacy client's sign-in without `X-Device-Id` appends a session row rather than breaking.
- [ ] **UPG-09** — A stale cached `tokenRatesPer1M` (legacy blended number) neither crashes nor misprices mid-deploy.
- [ ] **UPG-10** — Rolling deploy: the app running the **old** client against the **new** server, and vice versa, for the duration of a store rollout — confirm no wire-contract break (`status.addons` is still `string[]`).

---

## 27. Release operations & sign-off

### 27.1 Pre-submission ops checklist

- [ ] **OPS-01** — Server env complete on Render: `MONGODB_URI`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `SMTP_*`, `EXPO_ACCESS_TOKEN`, `VAPI_API_KEY` + `VAPI_PHONE_NUMBER_ID`, `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_SECRET_API_KEY`, `PASSKEY_RP_ID` + `PASSKEY_ORIGINS`, `CORS_ORIGINS`, `GOOGLE_PLACES_API_KEY`, `DNC_HASH_SECRET`, `PUBLIC_BASE_URL`, and `UPLOAD_DIR` on a **persistent volume**. **⛔ BLOCKER.**
- [ ] **OPS-02** — RevenueCat: products, entitlements (**`app_unlock`**, **`calen_ai`**, **`addon_*`**), and the offerings (`current`, `credits`, `addons`, `ai_plan`) all exist and match the catalog. **Note: `mobile/RELEASE.md` still names the retired `premium`/`unlimited` entitlements — update it and verify the real config.** **⛔ BLOCKER.**
- [ ] **OPS-03** — The RC webhook points at the production API and its shared secret matches.
- [ ] **OPS-04** — App Store Connect products are **Ready to Submit** / approved, with localized prices, and the subscription group + review screenshot are set.
- [ ] **OPS-05** — `mobile/eas.json` production env is correct (API URL, passkey RP id, RC keys) and no dev/localhost value ships (§ENV-02).
- [ ] **OPS-06** — `scripts/backfillUserAddons.js` run (dry-run reviewed, mode chosen) **before** deploying the per-user add-on code.
- [ ] **OPS-07** — The E2EE prod residue steps are complete and the audit is clean (§SEC-13).
- [ ] **OPS-08** — Mongo is a **replica set** (Atlas) so the record-change stream works; confirm the poke bus doesn't silently degrade to local-only in production.
- [ ] **OPS-09** — Backups: a verified restore of the production database has been performed at least once.
- [ ] **OPS-10** — Monitoring/alerting on the API (error rate, 5xx, webhook failures, email queue depth, credit-ledger anomalies) and a crash-reporting path for the app.
- [ ] **OPS-11** — Email: SMTP verified (not dry-run), SPF/DKIM/DMARC pass for `no-reply@householdcalendar.com`, and a test of each implemented template lands in Gmail's inbox (not spam).
- [ ] **OPS-12** — The email reconcile cron is running (every 10 min) and the outbox drains.
- [ ] **OPS-13** — The daily reminder cron runs hourly and correctly **skips** E2EE households and devices claiming local reminders.
- [ ] **OPS-14** — Support readiness: a monitored support inbox, the admin portal accessible, and a documented runbook for "user lost every factor", "purchase didn't land", "reminders not firing", and "shared calendar is empty".
- [ ] **OPS-15** — Legal pages live and reachable from the app: Terms of Use (EULA), Privacy Policy, and the transparency doc.
- [ ] **OPS-16** — A rollback plan: how to pull the build, how to revert the API, and what is **not** revertible (the add-on backfill, the plaintext drop).
- [ ] **OPS-17** — Release notes prepared per [docs/release-notes-style.md](release-notes-style.md) (plain text, ≤~1200 chars, no emoji/markdown).

### 27.2 Areas with no automated coverage — plan extra manual time

| Area | Why | Section |
|---|---|---|
| Screen security & app lock | No tests at all | §SEC-01, SEC-02 |
| Guardian recovery server routes | No integration suite (mongodb-memory-server can't boot in the sandbox) | §E2E-17…21 |
| Trip budget & settlement math | No coverage | §TRP-07, TRP-08 |
| Store purchase paths | Sandbox-only, on-device | §5 |
| Push delivery end-to-end | Tests cover registration/validation, not transport | §16.2 |
| Reminder delivery end-to-end | On-device only, and the test affordance was removed | §16.1 |
| Vapi call outcome + summary constraints | Live-call only; explicitly flagged unverified | §AI-57 |
| ICS feed refresh cadence/failure | Open spec question | §SUB-02 |
| Mileage due recomputation | Open spec question | §MNT-30 |
| Cross-household trip attachments | Known design gap | §TRP-13 |

### 27.3 Bug severity & exit criteria

**Severity:**
- **S1 — Blocker.** Data loss or corruption, a lockout with no recovery, a privacy/E2EE violation, a payment taken without entitlement, a crash on a core path, or an App Review rejection cause. *Zero open at sign-off.*
- **S2 — Critical.** A core feature unusable or badly wrong on a common path with no reasonable workaround. *Zero open at sign-off.*
- **S3 — Major.** A feature wrong on a less-common path, or a workaround exists. *Triaged; each one explicitly accepted or fixed.*
- **S4 — Minor / polish.** Cosmetic, copy, or spacing. *Logged for a follow-up release.*

**Exit criteria — all must be true:**

- [ ] **EXIT-01** — Every **⛔ BLOCKER** case above passes.
- [ ] **EXIT-02** — Zero open S1/S2 defects.
- [ ] **EXIT-03** — The full plan has been executed on the primary device and the smoke subset on every device in the matrix, with results recorded (pass / fail / not-applicable + why).
- [ ] **EXIT-04** — Automated gates green on the exact commit being submitted (§AUTO).
- [ ] **EXIT-05** — Every behavior change found during testing has its spec updated and `last-verified` bumped in the same commit (the repo's spec-first rule).
- [ ] **EXIT-06** — Ops checklist §27.1 complete.
- [ ] **EXIT-07** — Two-device, two-household, and viewer-account journeys each completed end-to-end at least once on the final build.
- [ ] **EXIT-08** — A 24-hour soak on a real device: reminders fire on schedule, the e-card sends at its hour, sync stays live, and the app is still signed in and responsive the next morning.
- [ ] **EXIT-09** — Sign-off recorded by the release owner, with any accepted S3 defects listed by id.

---

## Appendix A — Regression suite (previously-fixed, high-cost bugs)

Every one of these shipped and was reported. Re-run them on the final build; they
are the cheapest, highest-yield cases in this document.

- [ ] **REG-01** — Reminders silently stopped entirely (a recurring chore's `Date`-shaped `nextDueDate` threw and killed the whole pass) → §NTF-05.
- [ ] **REG-02** — All-day alerts fired at the wrong local hour → §NTF-11.
- [ ] **REG-03** — The **All day** switch sprang back on → §CAL-51.
- [ ] **REG-04** — A timed event's date walked forward one day per edit west of UTC → §CAL-13.
- [ ] **REG-05** — End Repeat drifted a day forward on every edit → §CAL-18.
- [ ] **REG-06** — A repeat-rule-only change saved with **no** prompt → §CAL-27.
- [ ] **REG-07** — Every edit resurrected deleted occurrences → §CAL-37.
- [ ] **REG-08** — A scoped save left the detail screen showing the unedited event → §CAL-33.
- [ ] **REG-09** — A custom "2 hours before" alert re-read as "1 hr 37 min before leaving" → §CAL-43.
- [ ] **REG-10** — Clearing the first alert stranded the second behind a hidden row → §CAL-41.
- [ ] **REG-11** — The custom-alert Hours tab landed on 23 hours → §CAL-47.
- [ ] **REG-12** — Picking "Custom…" showed nothing and froze the form (a second Modal during the first's dismissal) → §CAL-46 + every BottomSheet-opens-a-sheet path.
- [ ] **REG-13** — The Location search returned nothing for a street address → §CAL-58.
- [ ] **REG-14** — The Location card's map looked like the event view's but did nothing → §CAL-61.
- [ ] **REG-15** — The guest-list toggle was a silent no-op → §CAL-89.
- [ ] **REG-16** — Accepting a sealed cross-household invite always failed → §CAL-90.
- [ ] **REG-17** — An outside-shared calendar came up **empty for the collaborator** (re-seal dropped 14 sealed fields incl. `calendarType`) → §CAL-C9.
- [ ] **REG-18** — The owner's own shared-calendar events vanished after sign-out/sign-in → §CAL-C7.
- [ ] **REG-19** — A newly accepted collaborator waited forever because the owner had signed out and back in → §VIEW-04 / §CAL-C8.
- [ ] **REG-20** — Calendar colours/order/hidden/deleted/muted reverted on every sign-in → §CMG-09.
- [ ] **REG-21** — The calendar painted in default colours for a second before recolouring → §ONB-06.
- [ ] **REG-22** — A free viewer signing in was told "No shared calendars yet" (stale prefs cache from the previous account) → §AUTH-52 / §VIEW-01.
- [ ] **REG-23** — An owner signing in after a viewer session had Occasions/Chores/Meals zeroed (stale add-on cache) → §AUTH-52 / §BILL-42.
- [ ] **REG-24** — A brand-new invitee's first registration stranded them on the restore-access screen → §VIEW-02.
- [ ] **REG-25** — Sign-out → sign-in on the same launch hung the splash forever → §AUTH-54.
- [ ] **REG-26** — A leaver/removed member kept the old household's data readable on their phone → §E2E-15.
- [ ] **REG-27** — Joining wedged **both** replicas' sync cursors → §E2E-14.
- [ ] **REG-28** — A sole member's "leave" orphaned every record → §HH-20.
- [ ] **REG-29** — Leaving a household silently stripped paid add-ons → §BILL-46.
- [ ] **REG-30** — A repeating chore appeared on exactly one day of the month grid → §MNT-11.
- [ ] **REG-31** — A plain chore rename resurrected every skipped day / un-ended the series → §MNT-18.
- [ ] **REG-32** — An ended maintenance task read as permanently overdue → §MNT-21.
- [ ] **REG-33** — Moving a chore's occurrence date silently re-anchored the whole series → §MNT-15.
- [ ] **REG-34** — Editing a contact's occasion dates left the month grid stale → §PPL-22.
- [ ] **REG-35** — A contact saved with a partial sealer became invisible in every tab → §PPL-23.
- [ ] **REG-36** — Imported phone numbers never matched invites (not canonicalized) → §IMP-07.
- [ ] **REG-37** — Chat over-billed cache reads ~33× (50–70 credits a turn) → §BILL-17.
- [ ] **REG-38** — Plain manual upload / save-from-URL debited 40 credits for zero AI → §BILL-20.
- [ ] **REG-39** — The AI plan poll froze a stale pre-credit balance → §BILL-28.
- [ ] **REG-40** — The e-card ✓ held the user through multi-MB photo uploads → §ECD-07.
- [ ] **REG-41** — E-card subject read "Congratulations!, Alan" → §ECD-14.
- [ ] **REG-42** — E-card photos arrived as "Tap to Download" tiles in Apple Mail → §ECD-14.
- [ ] **REG-43** — Dictated e-card text rendered "OBJ" boxes → §ECD-14.
- [ ] **REG-44** — The past edge ran away and swept the header month backwards → §VW-10.
- [ ] **REG-45** — Switching density rebuilt the whole grid mid-animation → §VW-05.
- [ ] **REG-46** — The assistant's edit/delete tools silently did nothing on mobile while the model claimed success → §AI-38, §AI-39.
- [ ] **REG-47** — The event-invitee suggestion dropdown opened behind the keyboard → §CAL-C4.
- [ ] **REG-48** — Holiday/occasion alerts set in a session were gone at the next sign-in → §NTF-15.
- [ ] **REG-49** — A password reset left a locked viewer with no route back but paying $4.99 → §AUTH-28, §VIEW-15…27.
- [ ] **REG-50** — The re-key data-loss warning told a pure viewer their "1 item" would be destroyed → §E2E-08.

---

## Appendix B — Result log template

| ID | Device / OS | Build | Tester | Date | Result | Defect |
|---|---|---|---|---|---|---|
| | | | | | pass / fail / n-a | |

Record **every** case, including not-applicable ones with the reason — a plan
with silent gaps is indistinguishable from a plan that passed.
