---
title: Guardian recovery (dual-control)
status: current
last-verified: 909fb0f+ (2026-08-19); **the requester now finds out the moment their guardian approves** — the approval push (`POST /keys/guardian/approve`) was untyped (no `data`), so a tap just opened the app, a foreground arrival surfaced nothing, and the requester learned of approval only through the recover screen's 2.5s poll while that screen stayed mounted; the push is now typed `guardian_recovery_approved` (a tap routes at the recover screen, which resumes the persisted request into PIN entry), the pop-up lane gained the requester-side `guardianApproved` kind ("Recovery Approved", **Enter PIN / Not Now**, presented apart from and before every other alert, once per request, skipped when the recover screen is already up — mechanics in notifications.md), requester-side state is derived by `getRecoveryProgress()` (resume the keychain slot + one poll — there is no server list), `pollGuardianRecovery` now tolerates the two-poller burn-on-delivery race (a 404 after the handoff was already claimed re-checks the local stash instead of clearing the slot), and Privacy & Security gained a requester-side recovery banner above the encryption hero (waiting → "Recovery in progress…", approved → success-tinted "enter your PIN", both routed at the recover screen) plus the previously-declared-but-unread `focus: 'recovery'` scroll target (the Recovery-methods section); 3cfa750+ (2026-08-13); **the feature gets discovered: a one-time pop-up nudge once arming becomes possible** — a solo user literally can't arm a guardian, so once the household has another member and no guardian is armed, the pop-up lane's security-nudge channel (mechanics in notifications.md) prompts ONCE per device per user ("Add a Recovery Guardian", Set Up / Not Now, routed at the setup screen) on an app open from the second open on; worded as a capability and deliberately NOT naming the newest member (the joiner may be exactly who the user shouldn't hand recovery power to — the trust model requires someone you'd trust to see your data), outranked by the passkey nudge and by any invitation pop-up on the same open (2026-08-13); 3cd3b36+ (2026-08-12); **an approval no longer dies with the requester's app state** — the ephemeral secret + requestId lived only in module memory and the recover screen ALWAYS started a fresh request on mount, so the shared-device flow (sign out → guardian signs in → approves → sign back in) or an app kill during the wait orphaned the approval unrecoverably (the new request's poll waited forever, the sealed payload sat unclaimable until TTL sweep); the pending request now persists to the keychain per user, the screen resumes it before starting fresh, and the sealed handoff is persisted the moment polling claims it (burn-on-delivery makes the device copy the only copy); same day: **the guardian now finds out** — the request push is typed `guardian_recovery_request` and guardian requests joined the app-open/foreground pop-up lane (presented apart from ordinary invitations, routed at the approve screen; see notifications.md); the approve card's copy was rewritten ("They're locked out … you'll be shown a security code to compare") with real spacing before Review & approve; earlier same day: guardian audit events (`guardian_armed` / `guardian_disarmed` / `guardian_approved`) added to the `AUDIT_EVENTS` enum — arming a guardian 500'd on enum validation because keys.js wrote events the AuditLog model never allowed
code:
  - shared/crypto/src/core.ts                        # createGuardianEnvelope / unsealGuardianOuter / resealGuardianInner / recoverWithGuardian
  - server/src/routes/keys.js                        # /keys/guardian* endpoints (blind store + relay)
  - server/src/models/{User,GuardianRecoveryRequest}.js  # the outer envelope (on User) + the relay slot
  - mobile/src/lib/guardianRecovery.ts               # arm / request / poll / finish / approve
  - mobile/src/screens/profile/GuardianRecoveryScreen.tsx  # setup / recover / approve UI
tests:
  - shared/crypto/src/core.test.ts                   # guardian envelope: both legs required; wrong PIN/device/guardian rejected
  - mobile/src/lib/__tests__/guardianRecovery.test.ts # arm → request → approve → PIN finish over a blind relay
  - server/src/test/guardianRecovery.integration.test.js # server lifecycle: membership checks, audit rows, burn-on-delivery
---

# Guardian recovery (dual-control)

## Purpose

Let a user nominate a household member as an **optional recovery backstop** for
their end-to-end-encrypted account, so losing every personal unlock factor
(password, passkey, recovery code) no longer means permanent lockout. Recovery
takes a deliberate **two-person step** — the guardian's cooperation *and* a
4-digit PIN only the user holds ("dual control") — so it can't happen by accident
or by the guardian alone in the moment. It is opt-in, never weakens an account
that doesn't enrol it, and rests on an explicit trust assumption: you pick
someone you'd already trust to see your data (they share the household key
anyway). It is a *convenience* backstop, not a guarantee against a dishonest
guardian — see the trust note below.

This complements — it does not replace — the lighter path already implied by the
key hierarchy: because household members share the HDK, a user who loses their
factors can re-enrol a fresh identity key and have any member **re-seal the
current HDK** to it, recovering access to *current shared* household data. See
[households-sharing.md](households-sharing.md). Guardian recovery additionally
restores the user's *own identity key* (and therefore anything sealed only to
them, and their place in safety-number continuity) under a stronger,
member-can't-read guarantee.

## Why dual-control (and its explicit trust assumption)

At the crypto layer, **whoever holds a key that decrypts your data can decrypt
your data.** A plain "guardian holds your key" escrow therefore softens the core
promise from *"only me"* to *"me and my guardian"* — the app hiding the data is
policy, not cryptography. Guardian recovery accepts that softening **by design**:
you nominate a household member you *trust with your data*, and the recovery
secret is locked under **two locks**:

- the **guardian's** identity key (the member you nominate), and
- a **4-digit guardian PIN** the user sets when arming recovery (distinct from
  the account password).

**Product decision (2026-07-20): the PIN is 4 digits.** With Argon2id it is a
meaningful speed bump for the *online, relayed* path and makes recovery a
deliberate **two-person act** — the guardian alone, an accidental tap, a coerced
guardian, or anyone who only observes the server relay cannot complete it without
the user also supplying the PIN. It is **not** a barrier against a *determined
malicious* guardian: holding the sealed `inner` they can brute-force 10⁴
combinations offline. That residual is accepted deliberately — the guardian is
someone the user already trusts with shared household data. Users who want a
harder guarantee use a different recovery method (recovery code / passkey), which
remain the primary backstops. See Security properties below.

## Cryptographic construction (normative)

Arming recovery, on the user's unlocked device:

1. Let `sk` be the user's identity **private** key (the root that unwraps their
   HDK envelope → all their data).
2. Derive a user KEK from the **4-digit** guardian PIN:
   `K_user = Argon2id(pin, salt)` with a fresh random `salt`, at the **highest**
   Argon2id cost the client can bear (a speed bump only — see the trust note; a
   4-digit space is small enough that offline brute-force by whoever holds
   `inner` is feasible regardless of KDF cost).
3. **Inner lock (user):** `inner = secretbox(sk, K_user)`.
4. **Outer lock (guardian):** `outer = crypto_box_seal(inner, guardianPubKey)`
   — the same anonymous sealed-box primitive as HDK envelopes and device-link.
5. Upload a **`GuardianRecoveryEnvelope`** `{ userId, guardianUserId,
   guardianKeyFingerprint, salt, outer, createdAt }`. It MUST NOT live in
   `wrappedPrivateKey[]` (that array's invariant is "any one factor opens it";
   this envelope is deliberately *not* single-party openable).

The server only ever stores/relays `outer` (and later the re-sealed `inner`) as
opaque bytes. It never sees `sk`, `inner`, `K_user`, or the PIN.

Recovering, when the user has lost every factor (fresh device, signed in but
vault-locked):

1. The recovering device (signed in, vault locked) mints a one-shot **ephemeral**
   keypair and opens a relay slot (`POST /keys/guardian/request`); the guardian
   gets a security-alert push + an in-app prompt.
2. **Guardian leg (needs guardian key only):** the guardian's device fetches the
   requester's `outer` + ephemeral public key (`GET /keys/guardian/requests`),
   opens `outer` with its private key → `inner`, and **re-seals** `inner` to the
   ephemeral key (`POST /keys/guardian/approve`). It **cannot** read `sk`:
   `inner` is still `secretbox(sk, K_user)` and the guardian has no PIN. The
   guardian verifies the requester's **safety number** out-of-band first.
3. **User leg (needs PIN only):** the requesting device polls, unseals to
   `inner` with the ephemeral private key, the user enters the **PIN**, and
   `secretbox_open(inner, K_user)` → `sk`.
4. The device now holds the **original** `sk`, so the identity public key is
   unchanged and the existing HDK envelope still opens — **no re-key or HDK
   re-seal is needed**. The client simply enrols **fresh factors** (new password
   / recovery code, re-add a passkey) via the existing `PUT /keys/factors`, so
   the account isn't left single-factor. (`importLinkedKeyPair` reuses the same
   "adopt a keypair, cache to biometrics, unwrap HDK" path as device-link.)

Neither leg alone yields `sk`: the guardian never has `K_user`; the user never
has `inner` without the guardian. ✔ dual control.

> **Simplification vs. the original design:** because guardian recovery restores
> the *same* identity key, the `POST /keys/reenroll` endpoint the draft listed as
> a prerequisite is **not** needed here. (It is still the prerequisite for the
> separate "mint a new key + household re-seal" path in
> [households-sharing.md](households-sharing.md).)

## Behavior (normative)

- Arming a guardian MUST require the user's vault to be **unlocked** (needs `sk`
  in hand) and MUST require setting a **4-digit** guardian PIN with a confirm
  step. The client SHOULD reject trivial PINs (e.g. `0000`, `1234`, repeated or
  sequential digits).
- The guardian MUST be a **current household member** at arm time; the client
  MUST show and have the user verify the guardian's safety number first.
- A recovery attempt MUST alert the **user** (all their devices) and be
  rate-limited; the guardian's approval MUST show the requester's safety number
  for out-of-band verification.
- A recovery request MUST reach the **guardian** two ways: a push notification
  (typed `guardian_recovery_request` so a foreground arrival still surfaces),
  and the in-app pop-up lane (`useInviteAlerts`) — on app open / foreground /
  that push landing, a never-prompted pending request raises the iOS-style
  alert ("«name» is locked out of their account and asked for your help
  getting back in.", **Review Request / Not Now**) routed at the Guardian
  recovery approve screen. Guardian requests present **apart from** ordinary
  invitations (never folded into the "N new invitations" count — it's a
  security approval, and requests expire in 30 min) and prompt once per
  request; a re-request after expiry mints a new `requestId` and prompts
  afresh. Pop-up mechanics owned by
  [notifications.md](notifications.md).
- The guardian's approval MUST reach the **requester** the same two ways: the
  approval push is typed `guardian_recovery_approved` (a tap routes at the
  recover screen, which resumes the persisted request and asks for the PIN),
  and the pop-up lane raises "Recovery Approved" ("«guardian» approved your
  recovery request. Enter your recovery PIN to unlock your data on this
  device.", **Enter PIN / Not Now**) on app open / foreground / that push
  landing — presented apart from and **before** every other alert (the user is
  locked out and one PIN away from their data), prompted once per request, and
  skipped when the recover screen is already showing the PIN field. There is
  no server list for requester-side state: the lane resumes the keychain slot
  and polls once (`getRecoveryProgress` in `lib/guardianRecovery.ts`), which
  claims and persists the sealed handoff exactly like the recover screen's own
  poll. Concurrent pollers are safe by construction: a poll that 404s on the
  burned relay slot re-checks the locally stashed handoff before declaring the
  request expired (the loser of the burn-on-delivery race must not clear a
  claimed recovery).
- **Privacy & Security surfaces the requester's in-flight recovery** (locked
  vault only — an unlocked vault has nothing left to recover): a banner above
  the encryption hero, "Recovery in progress — waiting for your guardian to
  approve" while pending and a success-tinted "Your guardian approved your
  recovery — enter your PIN to unlock your data" once approved, both routed at
  the recover screen. The "Recover with your household guardian" link inside
  the locked hero remains, but reaching the PIN step no longer depends on
  finding it.
- Disarming MUST delete `User.guardianRecovery` and cancel in-flight requests
  (implemented). Removing the guardian from the household MUST prevent recovery
  through them — currently enforced at **request time** (`POST
  /keys/guardian/request` refuses a non-member guardian); active envelope cleanup
  on member removal is a known gap (see Open questions).
- An in-flight recovery MUST survive the requesting device losing its app
  state: approval takes as long as reaching the guardian takes, and on a
  shared device the requester signs out so the guardian can sign in and
  approve — only the request's ephemeral secret can open that approval, so
  losing it orphans the approval unrecoverably. The client persists the
  pending request (`requestId`, fingerprint, expiry, ephemeral keypair) to
  the keychain per user (`hc_guardian_recovery_<userId>`,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY, no biometric gate — resume runs silently on
  a locked account; survives sign-out, which wipes replica/prefs but not the
  keychain), and the recover screen resumes it before ever starting a fresh
  request (a fresh start would mint a new ephemeral key and orphan the old
  approval). The sealed handoff joins the slot the moment polling claims it —
  the server burns its copy on delivery, so from then on the device copy is
  the only one and PIN entry works fully offline. Everything persisted stays
  PIN-locked (the same 10⁴ offline residual the guardian already holds).
  Cleared on finish; an expired unapproved slot self-clears on resume.
- Recovery restores the same identity key, so the client MUST enrol fresh factors
  afterward (new password / recovery code) so the account isn't left relying on
  the guardian alone. The recover UI prompts for this on success.
- The whole feature MUST be opt-in; an un-armed account behaves exactly as today
  ("lose every factor → unrecoverable").
- **Discovery:** the feature is surfaced by a **one-time** pop-up nudge the
  moment arming becomes *possible* — the household has ≥1 other member (a solo
  user can't arm a guardian, so the entry point in Privacy & Security is
  undiscoverable exactly until then) and no guardian is armed. The nudge is
  worded as a capability ("choose someone you trust…") and MUST NOT name or
  preselect the newest member: the person who just joined may be exactly who
  the user should not hand recovery power to, and the trust model above
  requires a deliberate choice. **Set Up** routes at the setup screen (which
  enforces the unlocked-vault + PIN + safety-number ceremony as usual); **Not
  Now** is a real answer — prompted once per device per user, with the
  Recovery-methods badge as the durable surface. Pop-up mechanics (second-open
  floor, one nudge per open, passkey nudge and invitations outrank it) are
  owned by [notifications.md](notifications.md) "Security nudges".

## Data & API surface

- **Models:**
  - `User.guardianRecovery` subdoc — `{ guardianUserId, guardianFingerprint,
    outer, armedAt }`. `outer` is content-blind to the server; cleared on disarm.
  - `GuardianRecoveryRequest` — the transient relay slot (`requestId`, recovering
    `userId`, `guardianUserId`, `ephemeralPublicKey`, `fingerprint`,
    `sealedPayload`, `status`, TTL-swept `expiresAt`). Mirrors `DeviceLink` but is
    cross-user.
- **Endpoints (`/api/keys`, all `requireAuth`):**
  - `GET /keys/guardian` — the caller's own status (drives the Recovery row).
  - `PUT /keys/guardian` — arm/replace (guardian must be an enrolled household
    member; fires a security alert).
  - `DELETE /keys/guardian` — disarm (also deletes in-flight requests).
  - `POST /keys/guardian/request` — recovering device opens a slot; rate-limited
    (5 / 10 min); rejects if the guardian has left the household; alerts guardian.
  - `GET /keys/guardian/requests` — guardian lists pending requests + the
    requester's `outer` + ephemeral key.
  - `POST /keys/guardian/approve` — guardian posts the re-sealed `inner`; alerts
    the requester (push typed `guardian_recovery_approved`, carrying the
    `requestId`).
  - `GET /keys/guardian/request/:requestId` — requester polls; burned on delivery.
- **Audit trail:** arm, disarm, and approve each write an `AuditLog` row —
  `guardian_armed` / `guardian_disarmed` / `guardian_approved` (all in the
  `AUDIT_EVENTS` enum). Meta carries the guardian's `userId` only — never the
  PIN, envelope, or key material.
  - No `POST /keys/reenroll` — recovery restores the same key, so existing
    `PUT /keys/factors` re-enrols fresh factors (see the flow note above).
- **Client:** `GuardianRecoveryScreen` with `mode: setup | recover | approve`;
  entry points in **Privacy & Security** — a "Household guardian" row in Recovery
  methods (status badge), a "Recover with your household guardian" link in the
  locked-state hero, an approval banner when the caller is someone's guardian
  and has a pending request, and the requester-side in-flight-recovery banner
  above the hero (waiting / enter-your-PIN, see Behavior). `lib/guardianRecovery.ts`
  orchestrates; no camera/QR (the ephemeral key rides the authenticated relay,
  verified out-of-band by the fingerprint).

## Encryption boundary

`sk`, `inner`, `K_user`, and the guardian PIN are **never** server-visible; the
server stores `outer` and relays the re-sealed handoff as opaque bytes — the same
posture as `HouseholdKeyEnvelope` and device-link. Server-visible: that an
envelope exists, which member is the guardian, and that a recovery was requested
(for alerts/rate-limits). Cross-link [platform/crypto-e2ee.md](../platform/crypto-e2ee.md).

## Security properties & caveats

- **A malicious guardian can brute-force the 4-digit PIN offline.** Once they
  unseal `outer` they hold `inner = secretbox(sk, K_user)`; 10⁴ candidates is
  trivially searchable regardless of Argon2id cost. **This is an accepted
  residual, not a mitigated one** — the guardian is by definition someone the
  user trusts with their data (they already share the HDK). Users who need
  resistance to a *dishonest* guardian must not rely on this method; the recovery
  code and passkey are the member-independent backstops.
- **What the PIN _does_ protect** (the honest threat model): it forces the user's
  active participation, so recovery cannot be completed by (a) the guardian
  acting alone or by accident, (b) a coerced guardian without the user present,
  or (c) anyone observing only the **server relay** (which carries just the
  sealed `outer` and the re-sealed `inner`). The client MUST also **online
  rate-limit** recovery attempts per envelope and alert the user on each, so the
  relayed path can't be hammered.
- **In-app copy MUST set the expectation:** "Only pick someone you'd trust to see
  your data" — the PIN is a second step, not a wall against a guardian who
  chooses to break in.
- **No new exposure of shared data:** the guardian is already a household member
  and can already read shared HDK content — guardian recovery adds no read
  access to that; it only adds a *recovery* capability for the user's identity
  key, gated by the PIN.
- **MITM (fingerprint is load-bearing):** unlike device-link's QR, the
  ephemeral public key here travels through the authenticated **server relay**.
  A hostile server could substitute its own ephemeral key so the guardian
  re-seals `inner` to *it* — then brute-force the 4-digit PIN offline. The
  defence is the **out-of-band fingerprint check**: the recovering screen and
  the guardian's approval both show the ephemeral key's safety number, and the
  guardian MUST confirm it matches what the user reads over a trusted channel
  (call/in person) before approving. A substituted key yields a different
  fingerprint → the guardian declines. This must be stated plainly in the
  approval UI (it is, in `GuardianRecoveryScreen` ApproveMode).

## Verification

- The dual-control construction — arming produces an envelope neither party
  opens alone; the guardian leg re-seals without reading `sk`; the user leg
  needs the PIN; wrong PIN / wrong device / wrong guardian all fail —
  `shared/crypto/src/core.test.ts`.
- The client flow end-to-end over a blind relay (arm on the user's device →
  request from a locked device → guardian approve → wrong PIN fails without
  burning the slot → right PIN recovers the exact original key; locked-vault
  guard rails) — `mobile/src/lib/__tests__/guardianRecovery.test.ts` (real
  crypto; the API is an in-memory relay holding only opaque strings).
- The server `/keys/guardian*` relay endpoints have **no integration suite
  yet** — a known defect tracked in Open questions (arm → request → approve →
  finish + removed-guardian rejection).

## Out of scope

- **Threshold (Shamir) guardians** — no single member holds even `outer`; a
  stronger variant to consider later if one-guardian trust is unacceptable.
- **Plain household re-seal recovery** (re-admit a re-enrolled member to current
  shared data) — lives in [households-sharing.md](households-sharing.md); it is
  the lighter, no-PIN path and shares the `POST /keys/reenroll` prerequisite.
- Operator/legal recovery — none; there is still no backdoor.

## Open questions

- **Server integration tests pending.** The crypto core is unit-tested
  (`shared/crypto/src/core.test.ts` — both legs required; wrong PIN/device/
  guardian rejected). The `/keys/guardian*` routes have no integration test yet
  (the sandbox's mongodb-memory-server can't boot here); add one covering
  arm → request → approve → finish and the removed-guardian rejection.
- **Guardian-removal cleanup is passive, not active.** Removing the guardian from
  the household doesn't yet delete `User.guardianRecovery`; instead
  `POST /keys/guardian/request` refuses when the guardian is no longer a member
  (defence-in-depth). Consider an active clear in the member-removal path so the
  Recovery row doesn't show a stale "On".
- **Multiple guardians (non-threshold):** allow arming >1 independent guardian
  for availability, accepting that any one of them + the PIN can recover?
- *Resolved:* PIN length (4 digits); no `/keys/reenroll` needed for this path
  (same-key recovery). Optional future hardening — a rate-limited **server-held
  pepper** (iCloud-escrow style) — would make even a 4-digit PIN
  offline-infeasible, at the cost of adding the server to the trust path;
  deferred under the trusted-guardian assumption.
