---
title: Households & sharing
status: current
last-verified: 55bfc65 (2026-07-29)
code:
  - mobile/src/screens/profile/HouseholdScreen.tsx
  - server/src/routes/household.js
  - server/src/routes/keys.js
  - server/src/services/{householdKey,keyEnvelope,securityAlerts,e2eePolicy}.js
  - server/src/services/notify.js
  - server/src/models/{Household,HouseholdInvitation,JoinRequest,HouseholdKeyEnvelope,ResourceKeyEnvelope}.js
  - mobile/src/lib/safetyNumbers.ts
  - mobile/src/lib/shareInvite.ts
tests:
  - server/src/test/householdInvitations.integration.test.js
  - server/src/test/householdKey.integration.test.js
  - server/src/test/householdLeave.integration.test.js
  - server/src/test/keyHygiene.integration.test.js
  - server/src/test/securityAlerts.integration.test.js
  - server/src/services/householdKey.test.js
  - server/src/services/keyEnvelope.test.js
  - mobile/src/lib/__tests__/safetyNumbers.test.ts
---

# Households & sharing

## Purpose

A household is the unit of shared, encrypted data — every content record belongs
to one. This spec covers membership, invitations, approve-on-device join, the
household key (HDK) lifecycle, member removal + rotation, and safety-number
verification. The cryptographic mechanics are in
[platform/crypto-e2ee.md](../platform/crypto-e2ee.md); this is the product view.

## Behavior (normative)

### Membership & roles

- Every user has exactly one `householdId`. `Household` has an owner; the owner
  is the only member who can remove others and is the authority for key
  rotation.
- The household **`name` is encrypted content** (Signal-parity C2): it is sealed
  into the household-settings blob (`Household.enc`, alongside `homeAddress`) and
  the server nulls the plaintext at/after the drop, so admin/support identify
  households by **id**, not name. It is stripped server-side on writes to an
  `e2eeActive` household (`services/e2eePolicy.stripSealedContent`). Plaintext
  routing that necessarily stays server-visible: membership graph, owner, key
  version, plan/billing.

  > Reconcile: `docs/TRANSPARENCY.md` and `docs/CRYPTO-SPEC.md` §7 still list the
  > household name as server-visible (conservative/pre-C2 wording, and prod
  > households dropped before the re-seal backfill may still carry it). The
  > sealed design is the code truth; the user-facing docs need updating once the
  > prod re-drop is confirmed complete.

### Invitations & joining

- An owner/member invites by email or phone → `POST /household/invitations`
  (`HouseholdInvitation`). Invitations are **discovery only**: no key material is
  ever in the email or link.
- **Notification channels.** Outreach is **device-composed** — the server sends
  no invite email or text. `POST /household/invitations` only creates the
  discovery record and returns `userExists`; the inviter's device then composes
  the message from its own account: `mailto:` for an email invite, `sms:` for a
  phone invite (mobile `lib/shareInvite` → `composeShareEmail` / `composeShareSms`,
  driven from `HouseholdScreen`). This keeps the invitee's address off the server
  and off any transactional-mail path, and gives the message the deliverability
  of a person-to-person email. The message is a **nudge only** (open the app to
  accept) — consistent with invites being discovery-only, carrying no key
  material or functional token.
- **Push for existing accounts.** When the invited address already belongs to an
  account, the server *additionally* sends a push to that user's registered
  devices (`notify.pushToUser`, fire-and-forget, best-effort — no-ops if they
  have no token or denied permission). This is the one channel the server does
  send, since it needs the recipient's device tokens. The `HouseholdInvitation`
  row is created regardless, so the invite also appears in the recipient's in-app
  inbox (`GET /household/invitations/mine`).
- **Invite from contacts (mobile):** the invite field on `HouseholdScreen`
  autocompletes over the **in-app contacts roster** (the decrypted People
  records — Family/Friends/Professionals — via `peopleApi.list` + on-device
  decrypt), matching the typed text against a contact's name, email, or phone.
  Tapping a suggestion invites that contact's primary email (else a normalized
  phone) through the same `POST /household/invitations` path — no retyping.
  Suggestions exclude current members, people with a pending/accepted invite, and
  the signed-in user. The source is the in-app roster, not the device address
  book; typing a raw email/phone for someone not on file still works.
- The invitee sees it via `GET /household/invitations/mine` and accepts
  (`POST /household/invitations/:id/accept`, rate-limited) — which creates a
  `JoinRequest`, **not** an instant join.
- **Approve-on-device:** an existing member reviews pending requests
  (`GET /household/join-requests`), **verifies the joiner's safety number**
  out-of-band, and approves (`.../approve`) — only then is the current HDK sealed
  to the joiner's public key. Reject and cancel paths exist
  (`.../reject`, `DELETE /household/join-requests/mine`).
- `POST /household/leave` and `POST /household/members/:userId/remove`
  (owner-only) move a member to a fresh solo household, activated born-encrypted
  right away (mint HDK → `activateBornEncryptedHousehold`). Leaving hands the
  shared data to the members who remain and drops the leaver into a clean space.
- **Sole member = no-op.** `leave` only applies when the household is **shared**.
  A sole member has no one to leave and nothing to hand over — their household
  *is* their own data — so `POST /household/leave` returns the existing household
  unchanged and creates nothing. The client hides the leave action (surfaced as
  **"Leave household"**) unless `members.length > 1`. This closes a data-loss
  bug: for a sole member the old path minted an empty household and ran
  `handleDeparture`'s empty-household branch, which deletes the household and its
  **only** key envelope while the encrypted records stay behind — orphaning every
  record with no key left to decrypt it.
- **Reap invariant.** `handleDeparture` never deletes a memberless household's
  key envelope while any `Record` still references that household; key material
  is destroyed only once the ciphertext that needs it is gone.

### Key lifecycle

- The owner lazily mints **HDK v1** on first unlock. Members read/rotate via
  `GET /household/key`, `POST /household/key`, `GET /household/member-keys`.
- **Removal → rotation:** removing a member flags rotation; the next member
  unlock mints HDK v(N+1) via `POST /household/key/rotate` (compare-and-set on
  the version, new-version envelopes for every remaining member). Old versions
  are kept for historical reads, then retired (`POST /household/key/retire`,
  `e2ee/old-versions`, `reseal-all`/`reseal-complete`) once nothing references
  them — a removed member's keys then open nothing.
- **Born-encrypted enforcement:** `e2eePolicy` blocks plaintext content writes;
  `POST /household/e2ee/activate` marks the household active; `e2ee/readiness`,
  `e2ee/stragglers` + `e2ee/seal`, and `e2ee/client-version` support the
  migration/consistency tooling. Activation is **automatic** — every household
  activates on the next owner-key unlock (`lib/e2ee maybeActivateBornEncrypted`),
  so the client no longer shows a manual "Turn on encryption now" setup card.
  HouseholdScreen shows an encryption-status badge that reflects the ACTUAL
  `e2eeActive` state — "End-to-end encrypted" once active, "Finishing encryption
  setup…" (with a reassuring hint) while activation is still pending. It is never
  hard-coded to "encrypted": activation is automatic but can stall, and a badge
  that always claimed success would hide a stuck household from its owner.

### Security alerts & verification

- Members are notified (`services/securityAlerts.js`) when a factor is added/
  removed, a member joins/leaves, the key rotates, or a new device signs in.
- **Safety numbers** (`mobile/src/lib/safetyNumbers.ts`) are a human-comparable
  digest of a member's identity public key, verified from HouseholdScreen; state
  is device-local (`unverified` / `verified` / `changed`). HouseholdScreen shows a
  per-member status, lets you compare and mark verified, and flags a **`changed`**
  member (key differs from the one this device last verified) so re-verification
  is prompted after a key change.

### Cross-household sharing

- Sharing a **calendar** or **trip** with someone in another household uses
  per-resource keys (`ResourceKeyEnvelope`, managed under
  `/household`-adjacent and `/trips/:id/keys`, `/calendars/:key/keys`), so a
  collaborator reads just that resource without holding the HDK. See
  [calendar.md](calendar.md) and [trips.md](trips.md).

## Data & API surface

- **Models:** `Household`, `HouseholdInvitation`, `JoinRequest`,
  `HouseholdKeyEnvelope` (HDK sealed per member × version), `ResourceKeyEnvelope`.
- **Endpoints:** `server/src/routes/household.js` (membership, invitations,
  join-requests, key lifecycle, e2ee activation/readiness) and
  `server/src/routes/keys.js` (identity factors + public keys — see
  [auth-identity.md](auth-identity.md)).
- **Client:** `HouseholdScreen` (members, invite, remove, safety numbers, an
  always-on "end-to-end encrypted" indicator, and the "Create new household"
  leave action).

## Encryption boundary

The **membership graph** (who is in which household, join/leave timing) is
server-visible by necessity. The household **name and home address are sealed**
(C2). See [platform/crypto-e2ee.md](../platform/crypto-e2ee.md) and
[operations/transparency.md](../operations/transparency.md).

## Verification

- Invite → accept → approve grants membership (and accept alone does NOT);
  duplicate-invite guard, decline/revoke paths, email-only claim at registration
  — `householdInvitations.integration.test.js`.
- HDK lifecycle: owner-only idempotent v1 mint, wrap-on-approve, member-keys
  listing, removal → solo household + rotation flag, full-coverage rotation,
  partial-coverage refusal, compare-and-set race — `householdKey.integration.test.js`
  (envelope mechanics unit-tested in `services/{householdKey,keyEnvelope}.test.js`).
- Old-version retirement refuses until drained; periodic rotation flags only
  stale households — `keyHygiene.integration.test.js`.
- Security-alert audit events for enrollment and factor add/remove —
  `securityAlerts.integration.test.js`.
- Safety numbers (client-side): real-fingerprint lifecycle — unverified →
  verified sticks to a fingerprint, a key change flips to `changed` until
  re-verified at the new number, clear resets, self excluded —
  `mobile/src/lib/__tests__/safetyNumbers.test.ts`.

## Open questions

- Document exact role capabilities (member vs owner) for each mutating endpoint.
- Confirm the periodic (90-day) rotation trigger path end-to-end.
