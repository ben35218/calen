---
title: Households & sharing
status: current
last-verified: 9282d82+ (2026-08-03); `GET /calendars` now serializes the CALLER'S OWN re-key seat stamps (`keyChangedAt` / `accessRequestedAt`) onto each calendar — never anyone else's, the `collaborators` array is still stripped — so the requester can see their own pending access request; without it the viewer shell's "Request sent" screen was local component state that a sign-out erased, dropping the user onto a blank calendar with no sign the request existed (2026-08-03); df8c7f3+ (2026-07-31); the invite-from-contacts autocomplete was extracted to the shared `hooks/useRosterSuggestions` (pure `matchRoster` + the decrypted-roster query) and now also backs the calendar outside-share field — HouseholdScreen behavior unchanged; its local RevealWrap moved to `components/ui.RevealWrap` (2026-07-30); membership visibility pass — removal now files a persisted `HouseholdNotice` (`GET/POST /household/notices`) so the removed user gets an in-app explanation in the Invitations inbox; a pending invite to another household now also shows on `HouseholdScreen` (Accept/Decline card); the joiner sees their OWN safety code while awaiting approval and the approver prompt points there (2026-07-29); phone invites now canonicalize the typed number to E.164 (`classifyRecipient` → `toE164FromTyped`) so a locally-typed number matches the recipient's saved account phone (2026-07-29); the approve-on-device safety code is now rendered by a shared `components/SecurityCode` (centered monospace group-grid that never splits a group across a line, one-tap copy) on both the joiner's waiting card and the approver surfaces (2026-07-29); rejecting a join request now refreshes the inviter's sent-invitations list so the retired (declined) invite is revoked from the member card immediately (2026-07-29); approving a join request now notifies the joiner (dedicated `alertUser` push + a persisted `HouseholdNotice` `kind:'approved'` in their inbox) and excludes them from the household-wide "new member" alert; `HouseholdNotice.formerHouseholdId` generalized to `householdId` (2026-07-29); removal now also pushes the removed user directly (`alertUser`), and the floating Invitations button badge now counts membership notices + pending join-requests (was missing them) so it mirrors the inbox "New" tab (2026-07-29); outreach is now composer-only-for-non-accounts across ALL four sharing flows (household/trip/calendar/event) — an account-holder recipient gets the server push + in-app inbox with NO composer opening (household reads `userExists` off its POST; trips/calendars/events check `GET /invitations/lookup`, now accepting `phone` for existence-only lookups, failing open on error), the event `event_invitation` server email is retired (device-composed .ics-link email for non-account invitees via `sendInvitations` + `useEmailComposer`; recipient push added to `POST /invitations`), and every pending-invite row gained a paper-plane Remind action that re-opens the composer on demand regardless of account status (2026-07-29); `HouseholdScreen` accepts a **`promptInvite`** route param — a Calen assistant "Set up your household" setup chip (`setup_household`, see ai-assistant.md) deep-links here when the user wanted to share/assign but has no other members, showing a `SetupCallout` above the invite section (df8c7f3+, 2026-07-31); the Invitations inbox's entry point moved out of the calendar's floating chrome into **Profile** — a badged Invitations row (in the **"Personal"** group, second after Account's conventional identity lead: every feed behind the inbox is per-user — invites are addressed to the individual, and members never see each other's inboxes — while the household-scoped join-requests-to-approve keep their shared surface on HouseholdScreen), with the pending count also overlaid on the calendar's profile avatar (the E2EE-locked "!" takes precedence) so the badge trail leads avatar → Profile row → inbox; the floating `InvitationsButton` was deleted and its "New"-tab counting rules extracted to `hooks/useInvitationsCount` (unchanged: pending event/calendar/trip/household invites + join requests + undismissed membership notices + unacknowledged call outcomes) (df8c7f3+, 2026-07-31); **re-key access requests** — a collaborator who lost every unlock factor and re-keyed is held out of `missingMembers` AND the mint/rotate collaborator list until the owner approves: `POST /calendars/:key/access-request` queues them (pushing the owner, who is otherwise never told), `GET /calendars/keys/pending` returns them under `reapprovals` with their NEW `identityPublicKey`, and `POST /calendars/:key/keys/approve` is the only path that writes a wrap for a suppressed collaborator (server-enforced in `writeMemberWraps`, so a stale client can't complete an unseen re-grant). Accepting an invitation carries the suppression across the collaborator re-seat — the viewer shell auto-accepts on every focus, which would otherwise clear it (9282d82+, 2026-08-02)
code:
  - mobile/src/screens/profile/HouseholdScreen.tsx
  - mobile/src/screens/calendar/InvitationsScreen.tsx
  - mobile/src/hooks/useInvitationsCount.ts
  - mobile/src/components/SecurityCode.tsx
  - server/src/routes/household.js
  - server/src/routes/keys.js
  - server/src/services/{householdKey,keyEnvelope,securityAlerts,e2eePolicy}.js
  - server/src/services/notify.js
  - server/src/models/{Household,HouseholdInvitation,JoinRequest,HouseholdKeyEnvelope,ResourceKeyEnvelope,HouseholdNotice}.js
  - mobile/src/lib/safetyNumbers.ts
  - mobile/src/lib/shareInvite.ts
  - mobile/src/hooks/useRosterSuggestions.ts
  - mobile/src/components/EmailAppSheet.tsx
tests:
  - server/src/test/householdInvitations.integration.test.js
  - server/src/test/householdKey.integration.test.js
  - server/src/test/householdLeave.integration.test.js
  - server/src/test/keyHygiene.integration.test.js
  - server/src/test/securityAlerts.integration.test.js
  - server/src/services/householdKey.test.js
  - server/src/services/keyEnvelope.test.js
  - mobile/src/lib/__tests__/safetyNumbers.test.ts
  - mobile/src/lib/__tests__/shareInvite.test.ts
  - mobile/src/hooks/__tests__/useRosterSuggestions.test.ts
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
  the message from its own account: the user's **own mail app** for an email
  invite, `sms:` for a phone invite (mobile `lib/shareInvite` +
  `components/EmailAppSheet`, driven from `HouseholdScreen`). This keeps the invitee's address off the server
  and off any transactional-mail path, and gives the message the deliverability
  of a person-to-person email. The message is a **nudge only** (open the app to
  accept) — consistent with invites being discovery-only, carrying no key
  material or functional token.
- **Composer only for non-account recipients (all sharing flows).** A recipient
  who already has a Calen account gets **no device-composed outreach on
  invite**: the server push (below) + the durable in-app Invitations inbox
  replace it, so the inviter's screen just confirms ("it's in their Invitations
  inbox and their devices were notified") without opening any composer. The
  composer opens only when the recipient is NOT on Calen — the one case where
  email/SMS is the only channel that can reach them. The mental model: *Calen
  never sends email on your behalf; a composer opening means the person isn't
  on Calen yet.* How each flow knows: household invites read `userExists` off
  their own POST response; trip/calendar shares (and event invites) check
  `GET /invitations/lookup` (email or phone → `{ userExists }`) before
  composing, failing OPEN (compose anyway) if the lookup errors. This policy
  covers **all four** sharing flows — household, trip, calendar, and
  cross-household **event** invitations (whose server-sent
  `event_invitation` email was retired the same day — see
  [email-lifecycle](email-lifecycle.md) and [calendar](calendar.md)).
- **Remind (the escape hatch).** Every pending-invite row carries a Remind
  action (paper-plane icon) that opens the composer **on demand, regardless of
  account status** — covering the account holder whose push was denied/lost and
  who hasn't opened the app. Household: the sent-invites list on
  `HouseholdScreen` (pending rows only). Trip: not-yet-joined recipient rows on
  the trip form. Calendar: outside-share rows on `AddCalendarScreen`. Events:
  pending email rows on `EventInviteesScreen` (the SMS twin — the resend-text
  button — predates this).
- **Mail-app chooser (email invites).** A bare `mailto:` always lands in the
  device's ONE default mail app (Apple Mail unless changed in iOS Settings),
  stranding Gmail/Outlook-only users — so email composition routes through
  `useEmailComposer` (mobile `components/EmailAppSheet`), shared by the
  Household, Trip, and Calendar sharing flows:
  - `lib/shareInvite.detectMailApps()` probes the known clients' URL schemes
    (Apple Mail via `message://`, Gmail, Outlook, Spark, Yahoo Mail, Proton
    Mail, Fastmail — each declared in `app.json` →
    `ios.infoPlist.LSApplicationQueriesSchemes`). iOS only: on Android the
    probe returns empty and the flow keeps `mailto:`, whose OS chooser already
    disambiguates.
  - **0 apps detected** → plain `mailto:` (the system default). **1 app** → its
    composer opens directly, no sheet. **2+ apps** → a "Send invite with"
    bottom sheet lists the detected apps plus a **Copy invite message** row
    (clipboard fallback for undetectable clients, e.g. web-only Gmail).
  - Each app opens via its **own compose deep link** (e.g.
    `googlegmail://co?to=…&subject=…&body=…`) so the recipient/subject/body
    prefill is preserved — the reason a generic share sheet is NOT used (share
    extensions accept no To: address). All paths send the identical message
    (`inviteEmailContent`).
  - The first pick is **remembered silently** (`hc_invite_mail_app`,
    device-local AsyncStorage) and future invites open that app directly; the
    preference is surfaced as an "Email app" row on Profile → Account (only
    when 2+ apps are installed), where it can be changed or reset to
    ask-each-time (row ownership: [auth-identity](auth-identity.md)). A
    remembered app that's since been uninstalled falls back to the chooser.
  - Dismissing the sheet composes nothing and is not an error — the invitation
    row already exists server-side; the screens' note text already tells the
    inviter the message still needs sending.
- **Push for existing accounts.** When the invited address already belongs to an
  account, the server *additionally* sends a push to that user's registered
  devices (`notify.pushToUser`, fire-and-forget, best-effort — no-ops if they
  have no token or denied permission). This is the one channel the server does
  send, since it needs the recipient's device tokens. The `HouseholdInvitation`
  row is created regardless, so the invite also appears in the recipient's in-app
  inbox (`GET /household/invitations/mine`).
- **Phone-address matching (canonical E.164).** A phone invite resolves to an
  account — for the push, the `userExists` flag, and the in-app inbox — only when
  its number equals the recipient's saved `User.phone` (`resolveShareTarget`,
  `addressedToUser`, and the lazy-claim in `/invitations/mine`). Account phone
  fields persist **canonical E.164** (the `PhoneField` contract), so the invite
  input must emit the *same* form or a locally-typed number silently never
  matches. `classifyRecipient` (mobile `lib/shareInvite`) therefore canonicalizes
  a phone recipient via `toE164FromTyped` (device-country calling code applied
  when none is typed) rather than the loose `normalizePhone` (which kept only
  `+`+digits and so left a national number without its country code). Emails are
  lowercased; both address forms are matched exactly after normalization.
- **Invite from contacts (mobile):** the invite field on `HouseholdScreen`
  autocompletes over the **in-app contacts roster** (the decrypted People
  records — Family/Friends/Professionals — via `peopleApi.list` + on-device
  decrypt), matching the typed text against a contact's name, email, or phone.
  Tapping a suggestion invites that contact's primary email (else a normalized
  phone) through the same `POST /household/invitations` path — no retyping.
  Suggestions exclude current members, people with a pending/accepted invite, and
  the signed-in user. The source is the in-app roster, not the device address
  book; typing a raw email/phone for someone not on file still works.
  The roster query + matching live in the shared `hooks/useRosterSuggestions`
  (`matchRoster`: name/email/phone-digit match, resolved to primary email else
  canonical E.164 phone, capped at 5, excluding a caller-supplied taken set) —
  also backing the **calendar outside-share field** (AddCalendarScreen, which
  *stages* instead of sending; details in [calendar](calendar.md)). Each caller
  keeps its own taken set and send/stage semantics.
- The invitee sees it via `GET /household/invitations/mine` and accepts
  (`POST /household/invitations/:id/accept`, rate-limited) — which creates a
  `JoinRequest`, **not** an instant join. A pending invitation surfaces in **two**
  places for the invitee: the Invitations inbox *and* the top of `HouseholdScreen`
  (a "You've been invited" card with the same Accept/Decline), so an outstanding
  invite is visible from where they manage membership, not just the inbox.
- **Approve-on-device:** an existing member reviews pending requests
  (`GET /household/join-requests`), **verifies the joiner's safety number**
  out-of-band, and approves (`.../approve`) — only then is the current HDK sealed
  to the joiner's public key. Reject and cancel paths exist
  (`.../reject`, `DELETE /household/join-requests/mine`).
- **Approval notifies the joiner.** On approve, the joiner is told they're in
  **two ways**, mirroring how the invite reached them: a dedicated push
  (`alertUser` → "You're in! …"), and a persisted `HouseholdNotice`
  (`kind: 'approved'`, carrying the approver's first name — never the sealed
  household name) that shows in their Invitations inbox until dismissed. This is
  needed because approval **deletes** the invitation row, so without the notice
  the acceptance would leave no in-app trace. The joiner is **excluded** from the
  household-wide "New household member" security alert (`alertHousehold`'s
  `excludeUserId`) so they don't also receive that member-facing notice about
  themselves.
- **Reject retires the invitation.** `.../reject` marks the join request
  `rejected` **and retires the invitation it answered** to `declined`, so the
  invite is revoked from the inviter's member card (the sent-invitations list on
  `HouseholdScreen` hides `declined`) and shows as "Declined" in the rejected
  person's own inbox. Both approver surfaces refresh the sent list on reject
  (`HouseholdScreen` refetches; `InvitationsScreen` invalidates
  `['householdInvitations','sent']`) so the invite drops off the card
  immediately rather than lingering as "Accepted — approve them below". Re-inviting
  the same person reopens the declined row.
- **Both sides see the safety code.** The code the approver compares is the
  single-key fingerprint (`publicKeyFingerprint`) of the joiner's identity key.
  So the joiner can read out their *own* code, `HouseholdScreen`'s "Waiting for
  approval" card shows it (fingerprint of `myIdentityPublicKey`), and the
  approver's prompt (both surfaces) points there ("matches the one they see on
  their own Household screen"). This closes the gap where the approver was told
  to compare a code the joiner had nowhere to find.
- **Safety-code presentation.** The dashed 4-char-group fingerprint is rendered
  by one shared component, `components/SecurityCode`, everywhere it appears (the
  joiner's waiting card and both approver surfaces), so the two sides always look
  identical for comparison. It lays the groups out as a centered monospace grid
  that wraps by whole groups — never splitting one across a line as inline text
  did — with a one-tap copy (the joiner's own code is copyable; the approver's
  comparison view is not). Same code-display pattern as the recovery-code modal.
- **Where the approver sees requests.** Pending join requests surface in **two**
  places for any member of the target household: the "Requests to join" card on
  `HouseholdScreen`, and — so the approval isn't buried in Settings — the
  **Invitations inbox** (`InvitationsScreen`, "New" tab), rendered as an
  Approve/Reject card alongside the joiner's security code. Both call the same
  `GET /household/join-requests` → verify safety number → `.../approve` (HDK
  wrapped on-device via `wrapHDKForJoiner`) / `.../reject` flow; the inbox polls
  every 5s so a request that arrives while it's open appears without a refresh.
  Approved/rejected requests drop off both surfaces (the server returns pending
  only). This mirrors the invitee's own side, which already appears in the inbox
  via `GET /household/invitations/mine`.
- `POST /household/leave` and `POST /household/members/:userId/remove`
  (owner-only) move a member to a fresh solo household, activated born-encrypted
  right away (mint HDK → `activateBornEncryptedHousehold`). Leaving hands the
  shared data to the members who remain and drops the leaver into a clean space.
- **Membership notices (`HouseholdNotice`).** Two membership events file a
  persisted per-user notice, surfaced in the Invitations inbox ("New" until
  dismissed via `POST /household/notices/:id/ack`, listed by
  `GET /household/notices`), each carrying only the actor's first name (never the
  sealed household name): `kind: 'removed'` (an owner removed this user — see the
  remove path below) and `kind: 'approved'` (a member approved this user's join —
  see approve-on-device above). The persisted record matters because in both
  cases the transient signal is gone by the time the user looks: the removed user
  has been moved out of the household the security-alert push targets, and the
  approved user's invitation row is deleted on approval.
  - **Each also pushes the affected user directly** via `alertUser` (removed:
    "Removed from a household …"; approved: "You're in! …"), since the
    household-wide `alertHousehold` can't reach them — the removed user is no
    longer in that household, and the approved user is excluded from the
    member-facing "new member" alert.
  - **Badge coverage.** Both notice kinds count toward the Invitations "new"
    badge (`hooks/useInvitationsCount` — shown on the calendar's profile avatar
    and on Profile's Invitations row) while undismissed — that badge must
    mirror the inbox's "New" filter exactly, which also includes pending
    join-requests-to-approve and unacknowledged call-outcome notices, not just
    the four invitation types.
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

### Re-key access requests (owner approval)

A collaborator who lost every unlock factor and re-keyed
([platform/crypto-e2ee.md](../platform/crypto-e2ee.md) "Re-key") holds a new
identity key and no CalendarKey envelope. Their access returns **only** through
an explicit owner approval — never automatically, because a re-key is exactly
what a mailbox takeover would produce, and the owner's device is the only party
that can judge it.

- **Suppression.** Every collaborator seat the re-key touched carries
  `keyChangedAt`. While set, that person is excluded from `missingMembers`
  **and** from the `collaborators` list `GET /calendars/keys/pending` returns —
  both, because the mint/rotate arms seal to the whole collaborator list, so
  excluding them from only the steady-state arm would re-grant on the next
  rotation. `writeMemberWraps` enforces the same rule server-side: a stale or
  hostile client that posts the wrap anyway is refused, so the gate is never
  merely advisory.
- **Requesting.** `POST /calendars/:key/access-request` stamps
  `reapprovalRequestedAt` and pushes the owner. The nudge matters: accepting a
  share notifies the owner of nothing today, and the wrap needs their unlocked
  device, so without it the requester waits on someone who was never told.
- **Approving.** The request surfaces under `reapprovals` on
  `GET /calendars/keys/pending`, carrying the requester's **new**
  `identityPublicKey` so the owner compares its safety number before granting —
  the same out-of-band check as a join request, and the only evidence that the
  new key belongs to the same person. `POST /calendars/:key/keys/approve` is the
  sole path that writes a wrap for a suppressed collaborator; it clears both
  flags **after** the envelope lands, so a failed write leaves the request
  standing rather than silently dropping it. There is no "reject" — doing
  nothing already grants nothing.
- **The requester can see their own wait.** `GET /calendars` serializes the
  caller's **own** seat stamps (`keyChangedAt`, `accessRequestedAt`) onto each
  calendar — and only their own: the `collaborators` array itself is still
  stripped, so this discloses nothing about anyone else. It exists because the
  requester's side of this exchange is otherwise invisible to them: the viewer
  shell's "Request sent" screen was local component state, so a sign-out dropped
  them onto a blank calendar with no sign the request had ever been made. These
  stamps are the durable record of the wait, and clearing them on approve is
  what tells the client the wait is over (see
  [billing-plans.md](billing-plans.md) "Free viewer mode").
- **Accepting an invitation preserves the suppression.** The collaborator
  re-seat on accept carries `keyChangedAt`/`reapprovalRequestedAt` across its
  pull/push. Accepting is the *collaborator's* action, and the viewer shell
  auto-accepts pending shares on every focus — so without this a re-keyed
  account would clear its own suppression without anyone tapping anything.
- **Surfaced** in the owner's `InvitationsScreen` inbox (and its badge count),
  beside household join requests.

## Data & API surface

- **Models:** `Household`, `HouseholdInvitation`, `JoinRequest`,
  `HouseholdKeyEnvelope` (HDK sealed per member × version), `ResourceKeyEnvelope`,
  `HouseholdNotice` (per-user membership notice, e.g. removal).
- **Endpoints:** `server/src/routes/household.js` (membership, invitations,
  join-requests, notices, key lifecycle, e2ee activation/readiness) and
  `server/src/routes/keys.js` (identity factors + public keys — see
  [auth-identity.md](auth-identity.md)).
- **Client:** `HouseholdScreen` (members, invite, remove, safety numbers, own
  safety code while awaiting approval, incoming-invite card, an always-on
  "end-to-end encrypted" indicator, and the "Create new household" leave action)
  and `InvitationsScreen` (join-request approvals + removal notices in the inbox).

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
