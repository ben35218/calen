---
title: Cryptography & E2EE
status: current
last-verified: 909fb0f+ (2026-08-19); **unlocks refresh the usernameless passkey sign-in hint cache** — every unlock that holds the factor list (password / recovery / passkey / PRF-output) now pushes each passkey factor's `{credentialId, prfSalt}` into the device-local `lib/passkeyHints` cache (and `addPasskeyFactor` seeds the new credential's), public metadata only; this is what lets the usernameless passkey sign-in evaluate the PRF in the sign-in gesture itself instead of double-prompting (normative in features/auth-identity.md "Passkey"; pinned in e2ee.test.ts) (2026-08-19); 3cfa750+ (2026-08-14); **the solo "start fresh" purge spares resource-sealed records** — `POST /keys/rekey`'s no-peers purge ran `Record.deleteMany({ householdId })`, which also destroyed records sealed under RESOURCE keys (`enc.ks` 'cal'/'trip') that outside collaborators still hold live member `ResourceKeyEnvelope`s for — data other people could read, deleted as "dead ciphertext". The purge now uses the same `'enc.ks': { $nin: ['cal', 'trip'] }` exclusion as the carry-over filter and the envelope-retirement pass; only HDK-sealed rows and the `recipient: 'household'` resource envelopes (genuinely wrapped under the dead HDK) die, collaborators' member envelopes and their `scope.resource` sync lane survive (regression in rekeyRecovery.integration.test.js) (2026-08-14); 3cd3b36+ (2026-08-12); **re-key now settles the household ("start fresh")** — `POST /keys/rekey` no longer leaves the caller's household stranded on a dead HDK: after the envelope purge the server checks who ELSE holds a `HouseholdKeyEnvelope` (the same test now drives the 409's `recoverableByHousehold`, replacing raw member count). Peers exist → `keyRotationPending` is flagged so the next unlocked member's lazy rotation wraps v(N+1) to the caller's new key (previously nothing triggered this and a re-keyed member stayed `pending` forever); no peers (solo) → the permanently unreadable Records are erased, household envelopes + household-wrapped resource keys dropped, and `currentKeyVersion` reset to 0 (`hdk_reset` audited, `householdReset` in the response) so the ordinary owner mint issues a fresh HDK and the account can SAVE again — the post-password-reset dead end this closes. Client: `rekeyIdentity` fires the household-changed teardown (replica/cursor/pref wipe) on success, and Privacy & Security's locked box gained the full-user entry point ("No way back in? Start fresh with a new key" → confirm → optional password prompt → re-key), which the free-viewer shell alone had (2026-08-12); c2d18c0+ (2026-08-04); **joining a household moves no ciphertext** — the record AAD binds `householdId`, so a joiner's existing records stay sealed to the household they left and only a device still holding THAT household's envelope can re-seal them across (the server holds no key and cannot). `lib/e2ee` gained the two helpers that make the carry-over possible — `unwrapForeignHDKs` (unwrap a left household's envelopes with our identity key) and `openForeignRecord` (open a row against an explicitly-passed householdId + key instead of the session globals, which now point at the destination); resource-sealed rows are excluded, since keying off `scope.resource` is exactly what already lets them cross households. Product flow in features/households-sharing.md → "Join carry-over" (2026-08-04); 9282d82+ (2026-08-02); **re-key no longer prompts for a password it already has** — new memory-only `sessionPassword` in mobile/src/lib/e2ee.ts (`rememberSessionPassword` / `hasSessionPassword`, cleared by `lock()`, so sign-out and the re-key itself drop it; never persisted, never in the keychain), fed by the two paths that verify a password server-side and STILL end up locked (`resetPassword` in store/auth, `ensureEnrolledOnLogin`'s failed-unlock branch), and `rekeyIdentity(password: string | null)` falls back to it — throwing when neither exists rather than minting an identity with no password factor. The password remains load-bearing (it is what `createPasswordFactor` seals the new private half under, and dropping it would leave a recovery-code-only identity that re-locks on the next relaunch); what changed is only WHO supplies it. Documented tradeoff: a re-key no longer re-authenticates the holder of an already-unlocked phone (2026-08-02); 55bfc65+ (2026-07-28); added scheduled occasion e-cards to the deliberate plaintext exceptions (2026-07-28); e-card exception extended to attached card photos (plaintext files in the upload store) (2026-07-28); file attachments always seal on-device before upload — removed the plaintext-upload fallback that handed RN's FormData a raw picked URI (some iOS photo URIs uploaded an empty part → server "No file uploaded"); upload now ensures the household key is loaded, encrypts, and refuses with an unlock prompt if locked (2026-07-29); `alertHousehold` gained an `excludeUserId` option (skip the just-approved joiner from the household-wide "new member" alert) (2026-07-29); documented the recovery-code confirmation gate (dual-stored until `recoverySetupAt`) and the soft re-surface of a freshly minted one-time code on the next unlock when recovery is still unconfirmed — the recovery from force-quitting the modal before saving the code (71f3baf, 2026-07-30); **`POST /keys/rekey`** added — the narrow, audited exception to "keys are never replaced": a new identity keypair for an account that can no longer open its old one, recovering ACCESS (what a calendar owner can re-share) and never DATA (anything sealed to the abandoned identity stays sealed). Guarded by a `409 confirm_data_loss` when the caller's household holds records, it deletes the caller's dead HDK/resource envelopes, clears `recoverySetupAt` + any armed guardian, and stamps every calendar collaboration `keyChangedAt` so the owner's automatic re-wrap is SUPPRESSED until they approve — closing the mailbox-takeover → reset → re-key path into someone else's calendar (9282d82+, 2026-08-02)
code:
  - shared/crypto/src/core.ts
  - shared/crypto/src/enrollment.ts
  - server/src/services/{householdKey,keyEnvelope,e2eePolicy,securityAlerts}.js
  - mobile/src/lib/e2ee.ts
  - server/src/models/{Record,HouseholdKeyEnvelope,ResourceKeyEnvelope}.js
tests:
  - shared/crypto/src/core.test.ts
  - shared/crypto/src/deviceLink.test.ts
  - shared/crypto/src/enrollment.test.js
  - server/src/test/e2eeMandate.integration.test.js
  - server/src/test/authorHiding.integration.test.js
  - server/src/test/drop.integration.test.js
  - server/src/test/reDrop.integration.test.js
  - server/src/services/e2eePolicy.test.js
  - server/src/test/rekeyRecovery.integration.test.js
  - mobile/src/lib/__tests__/e2ee.test.ts
  - mobile/src/screens/viewer/__tests__/ViewerUnlockScreen.test.tsx
---

# Cryptography & E2EE

This is the system-level view of end-to-end encryption: how keys, records, and
membership fit together. The **formal primitive-level specification** —
algorithms, envelope byte layout, AAD, work factors — is
[`docs/CRYPTO-SPEC.md`](../../docs/CRYPTO-SPEC.md), the auditable spec for the
`shared/crypto` package. This spec should not restate primitives; it explains the
model and points there.

## Invariant

Every household's content is **born encrypted**: sealed on the device with keys
the servers never hold, before upload. E2EE is **mandatory** — there is no
plaintext-content lane and no opt-out (`server/src/services/e2eePolicy.js`
rejects a content write without ciphertext; `POST /household/e2ee/activate`
marks a household born-encrypted). There is **no server-side admin override or
recovery backdoor**. Losing every personal unlock factor is recoverable only by
client-held means: another household member re-seals the HDK to a fresh identity
key, or — if the user opted in beforehand — a nominated guardian assists a
dual-control recovery ([features/guardian-recovery.md](../features/guardian-recovery.md)).
Absent those, the data is unrecoverable, by design.

### Re-key: recovering ACCESS without recovering DATA

The one exception to "keys are never replaced", and it is deliberately narrow:
`POST /keys/rekey` mints a **new identity keypair** for an account that can no
longer open its old one, wrapped under the caller's current password plus a
fresh one-time recovery code. It recovers **access to what others can re-share**,
never data: everything sealed to the abandoned identity stays sealed forever, so
the paragraph above still holds — there is no override and no backdoor.

It exists for the **free viewer** ([features/billing-plans.md](../features/billing-plans.md)
"Free viewer mode"): someone a calendar was shared with, who reset a forgotten
password. `POST /auth/reset` changes only the login password, so their identity
key — and with it the CalendarKey envelope their shared events are sealed to —
stays shut. Re-wrapping to their *existing* public key would achieve nothing
(the lost half is the private one), so the only route back is a new identity for
the owner to wrap to. A viewer loses nothing by taking it: the events belong to
the calendar's owner.

It is also the **"start fresh"** path for a full user in the same spot — reset
password, no passkey, recovery code lost. For them the point isn't what others
can re-share but that the account can *encrypt and save again at all*: without
re-keying they are locked out of writing forever, since every write must seal
under an HDK their dead identity can't unwrap. The entry point is the locked
box on Privacy & Security ("No way back in? Start fresh with a new key" —
confirm dialog, then the account password if the session isn't already holding
a verified one, then the data-loss confirm below). What happens to the
household's existing data is the "settled, not stranded" rule below; a fresh
one-time recovery code surfaces through the mandatory app-root modal either
way.

Rules, all enforced server-side:

- **The data-loss guard.** With any un-tombstoned `Record` in the caller's
  household, the endpoint answers `409 confirm_data_loss` (carrying
  `recordCount` and whether the household has other members who could re-seal)
  until the client repeats the call with `confirmDataLoss: true`. Re-keying is
  never a silent side effect of asking for access.
- **It grants nothing by itself.** The caller's `HouseholdKeyEnvelope` and
  member `ResourceKeyEnvelope` rows are deleted (they are undecryptable noise),
  and every calendar collaboration is stamped `keyChangedAt`. That stamp
  **suppresses the owner's automatic wrap-on-approve pass** — without it, the
  deletion would drop the caller straight back into `missingMembers` and the
  owner's next unlock would re-grant silently, making *take over the mailbox →
  reset the password → re-key* a way to inherit someone else's calendar. Access
  returns only via the request → approve pair in
  [features/households-sharing.md](../features/households-sharing.md).
- **The household is settled, not stranded.** The caller's copy of the HDK died
  with the old identity, so after the envelope purge the server looks at who
  else still holds one (`HouseholdKeyEnvelope` rows other than the caller's —
  membership rows alone don't count, a never-enrolled member can re-seal
  nothing; the same test now drives the 409's `recoverableByHousehold`):
  - **Someone does** → the data survives them. The household is flagged
    `keyRotationPending`, exactly as a departure does, so the next unlocked
    member's lazy-rotation pass wraps HDK v(N+1) to every enrolled member —
    the caller's new key included. That flag is what re-admits an *existing*
    member; without it the caller sat `pending` indefinitely, waiting for a
    rotation nothing would trigger.
  - **Nobody does** → every **HDK-sealed** record is sealed under a key that no
    longer exists anywhere. Keeping that ciphertext — and a `currentKeyVersion`
    pointing at it — would strand the account: the v1 mint is guarded to
    version 0, so the session would unlock but never save again. The caller has
    already confirmed the loss, so the dead records are erased, the household's
    envelopes and household-wrapped resource keys dropped, and
    `currentKeyVersion` reset to 0 (`hdk_reset` audited, `householdReset: true`
    in the response). The client's ordinary `ensureHouseholdKey` then mints a
    fresh HDK v1 and the account starts clean. Orphaned attachment files fall
    to the upload store's sweep. `e2eeActive` is untouched — the household
    stays born-encrypted.
    - **The purge spares resource-sealed rows.** A record with `enc.ks`
      `'cal'`/`'trip'` seals under its own CalendarKey/TripKey, **not** the
      dead HDK, and outside collaborators still hold live
      `recipient: 'member'` `ResourceKeyEnvelope` rows for it — deleting it
      would destroy data other people can read. The purge therefore uses the
      same `'enc.ks': { $nin: ['cal', 'trip'] }` exclusion as the join
      carry-over filter and the envelope-retirement pass, deletes only the
      `recipient: 'household'` resource envelopes (those *are* dead — wrapped
      under the dead HDK), and leaves collaborators' member envelopes intact,
      so their `scope.resource` list/sync lane keeps working across the
      owner's reset.
- **The device forgets what the key forgot.** After a successful re-key the
  client fires the same household-changed teardown a join/leave does (replica +
  cursors + pref caches wiped, refilled once keys are ready): the decrypted
  replica rows must not outlive the key that produced them, and server-side
  they were either purged or are pending a member's re-wrap.
- **Recovery is unconfirmed again.** `recoverySetupAt` is cleared and any armed
  guardian dropped (it was armed against the old identity and can never open the
  new one), so the mandatory recovery-code modal re-runs and the born-encrypted
  gate below re-applies.
- **It is loud.** `key_rekeyed` is audited and the household is alerted that the
  member's safety number changed — the event safety numbers exist for.

**The password is the wrapping key, not a checkpoint.** Client-side,
`rekeyIdentity` → `enroll(password)` → `crypto.createPasswordFactor` seals the
new private half under that password, and the resulting envelope IS the password
factor every later unlock opens. It therefore cannot be dropped to save a tap:
an identity minted without one carries only the recovery-code factor, so the
viewer gets their calendar back and is locked out again on the next relaunch
with a password that opens nothing — the very dead end the flow exists to end.

What it does NOT have to be is *typed on the recovery screen*. Both paths that
verify a password server-side and still end up locked — `POST /auth/reset` (the
reset changes the login password and re-wraps nothing) and
`ensureEnrolledOnLogin`'s failed-unlock branch — hand it to
`rememberSessionPassword`, and `rekeyIdentity(null)` uses that. Making someone
retype a password the app is already holding, on the screen they reached
*because* they lost access, is friction with no security value: the server has
just verified it, and the identity private key sitting in memory beside it is
strictly more sensitive. The hold is **memory only** — never persisted, never
written to the keychain, and dropped by `lock()`, which both sign-out and
`rekeyIdentity` itself call. When nothing is held (a later relaunch restores the
token but no password was typed), the client falls back to asking; with neither,
`rekeyIdentity` throws rather than minting an identity nobody can open. The
tradeoff accepted here is explicit: re-keying no longer re-authenticates the
person holding an already-unlocked phone.

### Recovery-code confirmation gate

Because loss of every factor is unrecoverable, a new household is **not dropped to
encrypted-only immediately**. It stays **dual-stored** (ciphertext plus the
server's plaintext fallback) until the account confirms a durable non-password
recovery factor — the recovery code saved (re-entry confirmed) or a passkey
enrolled, recorded as `recoverySetupAt`. Born-encrypted activation
(`maybeActivateBornEncrypted`) re-checks this on **every unlock** and only drops
the plaintext once recovery is confirmed. So a user who force-quits the
recovery-code modal before saving the code is never stranded: nothing was dropped,
their password still unlocks, and the plaintext fallback remains until they
confirm.

The one-time recovery code lives only in memory (`pendingRecoveryCode`) and is
never stored server-side, so it can never be re-displayed. If the account unlocks
still needing recovery setup, the app **re-surfaces the one-time modal with a
freshly minted code** (`maybeResurfaceRecovery` — invalidating the unsaved prior
code), at most once per session. This is the soft recovery from a force-quit: the
user simply sees the modal again next launch instead of hunting through Privacy &
data to mint one. No plaintext recovery code is ever written to disk to enable
this.

## Key hierarchy (one paragraph)

A per-user **X25519 identity keypair** has its private key stored server-side
only as ciphertext, wrapped **independently by each enrolled factor** (any one
opens it): a **password** (Argon2id KEK), a **passkey** (WebAuthn-PRF KEK), and a
one-time **recovery code** (KEK). Adding/removing a factor never re-keys anything
else. Any unlock that holds the factor list also refreshes the device-local
cache of each passkey credential's `{credentialId, prfSalt}`
(`lib/passkeyHints`) — public metadata only, no key material — which is what
lets the usernameless passkey sign-in evaluate the PRF in the sign-in gesture
itself (normative in
[features/auth-identity.md](../features/auth-identity.md) "Passkey"). A user can also enrol **additional devices**: an existing device seals the
identity key to the new device's transient key over the `/keys/link/*` relay
(`DeviceLink`) — key material never rides through the server as plaintext, and a
new device triggers a security alert. A per-**household** symmetric key (**HDK**,
versioned) is sealed to each member's public key (`crypto_box_seal` →
`HouseholdKeyEnvelope`) and encrypts the household's records; per-file content
keys are wrapped by the HDK. **File attachments (event/receipt/manual/trip) are
sealed on-device before upload with no plaintext lane**: the client reads the
picked file's bytes, encrypts them under a fresh per-file key, and uploads only
the ciphertext (`application/octet-stream`) + the wrapped key — never the raw
picked file. Uploading requires the unlocked session key; if it isn't loaded the
upload is refused with an unlock prompt rather than falling back to plaintext.
Shared calendars/trips get their own resource keys —
a **CalendarKey** (D1) or **TripKey** (D2), wrapped in a `ResourceKeyEnvelope` —
so a cross-household collaborator can read just that resource without the HDK; a
record sealed under one carries a `ks`/`scope` discriminator so a reader picks
the right key without consulting membership. See
[features/auth-identity.md](../features/auth-identity.md) (factors + device link),
[features/guardian-recovery.md](../features/guardian-recovery.md) (guardian
recovery) and [features/households-sharing.md](../features/households-sharing.md)
(HDK lifecycle).

## Records are opaque

Content is stored in one content-blind collection
([`Record`](../../server/src/models/Record.js)). The **v2 envelope** moved the
collection type out of the AAD and into the sealed payload, so the server can't
tell an event from a recipe — it sees only routing metadata (`householdId`, key
version, ciphertext, optional resource `scope`, tombstone, timestamps). On
collections in `e2eePolicy`'s author-hidden set the server also strips the author
`userId`, so a record isn't attributable to a specific member. Full
field-by-field boundary in [data-model.md](data-model.md); read/write API in
[api-reference.md](api-reference.md).

## Membership, rotation, retirement

- **Join** is approve-on-device: the joiner's public-key fingerprint (safety
  number) is verified out-of-band, then an existing member seals the current HDK
  to the joiner. Invitation emails are discovery-only — no key material rides in
  email or links.
- **Rotation** on member removal (and every `KEY_ROTATION_INTERVAL_DAYS`,
  default 90): a member mints HDK v(N+1), seals it to every remaining member;
  a compare-and-set on the version prevents racing rotations. Clients eagerly
  re-seal old-version records; once nothing references an old version its
  envelopes are deleted (**retirement**), so a removed member's keys open nothing.
- **Joining does not move a member's data — re-sealing does.** The record AAD
  binds `householdId`, so a record sealed in one household cannot be read in
  another even by a member of both: changing membership changes no ciphertext.
  A joiner's existing records therefore stay sealed to the household they left,
  and only a device still holding *that* household's envelope can decrypt and
  re-seal them across. The server cannot: it holds no key. `lib/e2ee` exposes
  exactly two helpers for this — `unwrapForeignHDKs` (unwrap a left household's
  envelopes with our identity key) and `openForeignRecord` (open a row against an
  explicitly-passed `householdId` + key, rather than the session globals, which
  now point at the destination). Resource-sealed rows are out of scope: they key
  off `scope.resource`, not `householdId`, which is precisely what lets them cross
  households already. The product flow is in
  [households-sharing](../features/households-sharing.md) → "Join carry-over".
- **Safety numbers** are device-local and reset on key change; members get
  **security alerts** (`services/securityAlerts.js`) on factor/membership/key/
  device changes. `alertHousehold` accepts an `excludeUserId` to skip one member
  (used so a just-approved joiner gets their own welcome notification, not the
  household-wide "new member" alert about themselves — see
  [households-sharing](../features/households-sharing.md)).

## Server enforces vs. cryptography enforces

Cryptography enforces content confidentiality, record-slot integrity, and
household read access (HDK possession). The server enforces write authorization,
scoping, and quotas via the plaintext routing fields — and it can withhold
service or serve stale ciphertext, but the client's safety-number and
key-version checks surface that. A valid legal request yields exactly the
server-visible set, nothing more. See [operations/transparency.md](../operations/transparency.md).

## Deliberate plaintext exceptions

Content leaves encryption **only** where a chosen feature requires it: things
**shared outside** the household (trips/calendars — the collaborator lacks the
HDK), **event invitations** to non-account contacts (a readable event snapshot for
the email + `.ics`), **AI phone calls** (the event essentials needed to place
the call), and **scheduled occasion e-cards** (the recipient emails, the card
message + framing lines, and any **attached card photos** — text stored
plaintext in the `ECard` collection, photo files stored plaintext in the shared
disk upload store — so the server can deliver the card by email on the
occasion's date while the app is closed, like an email invitation; the form
warns before saving).
Each is documented in the relevant feature spec and in
[operations/transparency.md](../operations/transparency.md).

## Verification

- Primitives and envelopes (identity wrap per factor, HDK seal/unseal, resource
  keys, guardian envelope, device-link handoff) —
  `shared/crypto/src/{core,deviceLink}.test.ts`, `enrollment.test.js`.
- The born-encrypted mandate: write-guard rejects plaintext content, activation
  flips and stays enforced, ciphertext + routing only in steady state —
  `e2eeMandate.integration.test.js` (+ `services/e2eePolicy.test.js` units).
- Author hiding on e2eeActive creates; cross-household isolation; spoofed
  `householdId` rejected — `authorHiding.integration.test.js`.
- The drop journey (seal → readiness → dry-run → commit → post-drop API) and the
  re-drop of newer plaintext columns — `drop.integration.test.js`,
  `reDrop.integration.test.js`.
- The mobile crypto boundary (`lib/e2ee.ts`) — enrollment/recovery-code unlock,
  HDK envelope unwrap after lock, lazy rotation keeping old versions readable,
  opaque/tagged record round-trips, resource-key mint/wrap/collaborator-unwrap
  — `mobile/src/lib/__tests__/e2ee.test.ts` (real `@household/crypto` core over
  the web/libsodium adapter; only the API relay is faked).
- Join carry-over at the crypto boundary: after moving households a record left
  behind stops opening through the ordinary path, `unwrapForeignHDKs` +
  `openForeignRecord` recover it against its original `householdId`, re-sealing
  makes it an ordinary record in the new household, the wrong `householdId` opens
  nothing (the AAD really does bind it), and a resource-scoped row is refused —
  `mobile/src/lib/__tests__/e2ee.test.ts`.
- The opaque record store's field-level boundary is verified under
  [data-model.md](data-model.md); HDK lifecycle under
  [features/households-sharing.md](../features/households-sharing.md).

## Open questions

- **Reconcile `docs/CRYPTO-SPEC.md` §7 + `docs/TRANSPARENCY.md`.** Both still
  list the **household name** and **`nextDueDate`** as server-visible. Both are
  now **sealed** (C2 and D4 respectively — confirmed in `Household.js` /
  `dropReadiness.DROP_FIELDS`). The user-facing docs are stale (conservative,
  and prod households dropped before the re-seal backfill may still carry the
  plaintext); update them once the prod re-drop is confirmed complete.
- E3 (third-party audit) is the only remaining Signal-parity item — an ops/comms
  engagement, not code.
- E2 open-source action: publish `shared/crypto` + `CRYPTO-SPEC.md` so the
  claims are independently inspectable.
