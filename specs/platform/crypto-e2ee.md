---
title: Cryptography & E2EE
status: current
last-verified: 55bfc65+ (2026-07-28); added scheduled occasion e-cards to the deliberate plaintext exceptions (2026-07-28); e-card exception extended to attached card photos (plaintext files in the upload store) (2026-07-28); file attachments always seal on-device before upload — removed the plaintext-upload fallback that handed RN's FormData a raw picked URI (some iOS photo URIs uploaded an empty part → server "No file uploaded"); upload now ensures the household key is loaded, encrypts, and refuses with an unlock prompt if locked (2026-07-29); `alertHousehold` gained an `excludeUserId` option (skip the just-approved joiner from the household-wide "new member" alert) (2026-07-29); documented the recovery-code confirmation gate (dual-stored until `recoverySetupAt`) and the soft re-surface of a freshly minted one-time code on the next unlock when recovery is still unconfirmed — the recovery from force-quitting the modal before saving the code (71f3baf, 2026-07-30)
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
  - mobile/src/lib/__tests__/e2ee.test.ts
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
else. A user can also enrol **additional devices**: an existing device seals the
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
HDK), **event invitations** to non-account people (a readable event snapshot for
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
