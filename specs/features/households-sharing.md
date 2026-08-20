---
title: Households & sharing
status: current
last-verified: 909fb0f+ (2026-08-19); `matchRoster` now backs the event-invitee field too (EventInviteesScreen kept a private copy resolving each contact to its primary email; every invite field resolves addresses identically now) — one row per reachable address there as well, staged until the Invitees ✓ / the event's save (2026-08-19); 3cfa750+ (2026-08-14); the solo "start fresh" erase now spares resource-sealed rows — `POST /keys/rekey`'s no-peers purge deleted every Record in the household, including `enc.ks` 'cal'/'trip' rows sealed under resource keys that outside collaborators still hold member envelopes for; the purge now excludes them (same `$nin` filter as carry-over / envelope retirement) and collaborators' member `ResourceKeyEnvelope`s + `scope.resource` sync survive the owner's reset; normative detail in platform/crypto-e2ee.md "Re-key" (2026-08-14); 1d42ed2+ (2026-08-12); join carry-over moves rows but performs no dedupe; the one duplicate a join genuinely creates — a cross-household event invitation's copy landing beside the organizer's original — is now reconciled by its own pass immediately after carry-over, normative in calendar.md (2026-08-12); 3cd3b36+ (2026-08-12); key lifecycle gained the re-key settlement — a member's re-key flags the same lazy rotation a removal does (that rotation is what re-admits their new identity), and a solo re-key is the one path that moves `currentKeyVersion` back to 0 (dead records erased, fresh v1 mint); normative rules in platform/crypto-e2ee.md "Re-key" (2026-08-12); joining a household never writes to Contacts — the invite field uses the roster only to resolve an address and discards the contact id, and a joiner's carried-over self Contact carries an `accountId`, which every Contacts surface now excludes (see contacts.md); an existing member's roster is unchanged by someone joining (2026-08-12); 3cd3b36+ (2026-08-12); the share/invite contacts autocomplete (`matchRoster`) now offers **one row per reachable address** — every email then every canonical-E.164 phone on a matched card, labelled (`work · dee@work.com`) and channel-iconed — instead of silently resolving each contact to its primary email else primary phone; and a taken address (member / outstanding invite / yourself) now drops the WHOLE contact rather than falling through to their next address, which is what made an existing household member surface in the dropdown under a phone number while a non-member surfaced under an email. HouseholdScreen also folds the signed-in user's saved `Settings.phone` into its taken set so the Contacts self card can't be offered by number. Caps: 5 contacts / 6 rows, a contact listed whole or not at all (2026-08-12); 3cd3b36+ (2026-08-11); HouseholdScreen's initial load follows the app-wide shimmer-skeleton rule (mobile/CLAUDE.md's loading table) — member rows load as `SkeletonList`; the invite submit, per-member remove, and waiting-for-approval spinners are action/wait states and stay spinners, and the "Generating your security code…" text placeholder is unchanged (2026-08-11); **join carry-over** — approving a join moved membership but left the joiner's DATA behind: under C4 their records keep the old `householdId` and lose the plaintext `userId`, so they matched neither branch of the read scope and stayed sealed under a key the destination household doesn't hold. The joiner's unlocked device now merges them (`lib/joinCarryover` from `maintainKeyHygiene`, before the other key-hygiene passes): `GET /household/carryover` serves the stranded rows plus the old household's envelopes (authorized by envelope-holding, not membership), the device decrypts under the old HDK and re-seals under the new one, `PUT /household/carryover/:id` re-stamps the row IN PLACE (same `_id`, so attachments/invitations survive), and `POST /household/carryover/complete` drains the tombstones and reaps the emptied household + its key material. Resource-scoped (D1/D2) rows are excluded — they already route by `scope.resource` — and keep their household alive. Add-ons need no carry-over at all: ownership moved to `User.addons` (union across members for the household-wide effect), so purchases travel with the buyer through join, leave, and removal — see billing-plans.md. **A household change now also evicts the device's household-scoped caches**: `ensureHouseholdKey` raises `subscribeHouseholdChanged` when the household moves under a live session (never on the first read after sign-in) and the app root wipes the replica, resets the record cursor with it, and clears the calendar-prefs + owned-add-on caches. That is a privacy fix — the replica is a FLAT store of decrypted rows with no `householdId` column and sync only removes rows on tombstones the departed household will never send, so a leaver kept its calendar/meals/tasks readable on their phone indefinitely while the leave dialog promised the opposite; the cursor reset is equally required in the JOIN direction, since the joined household's records are all older than the stale high-water mark. Paired client fix: `lib/records.syncRecords` no longer parks its cursor on an undecryptable row from ANOTHER household (served by the scope's `userId ∈ scopeIds` branch) — that wedged both members' replicas at the moment of the join, which is why a joined household could show each member only their own data (2026-08-04); 9282d82+ (2026-08-03); `GET /calendars` now serializes the CALLER'S OWN re-key seat stamps (`keyChangedAt` / `accessRequestedAt`) onto each calendar — never anyone else's, the `collaborators` array is still stripped — so the requester can see their own pending access request; without it the viewer shell's "Request sent" screen was local component state that a sign-out erased, dropping the user onto a blank calendar with no sign the request existed (2026-08-03); df8c7f3+ (2026-07-31); the invite-from-contacts autocomplete was extracted to the shared `hooks/useRosterSuggestions` (pure `matchRoster` + the decrypted-roster query) and now also backs the calendar outside-share field — HouseholdScreen behavior unchanged; its local RevealWrap moved to `components/ui.RevealWrap` (2026-07-30); membership visibility pass — removal now files a persisted `HouseholdNotice` (`GET/POST /household/notices`) so the removed user gets an in-app explanation in the Invitations inbox; a pending invite to another household now also shows on `HouseholdScreen` (Accept/Decline card); the joiner sees their OWN safety code while awaiting approval and the approver prompt points there (2026-07-29); phone invites now canonicalize the typed number to E.164 (`classifyRecipient` → `toE164FromTyped`) so a locally-typed number matches the recipient's saved account phone (2026-07-29); the approve-on-device safety code is now rendered by a shared `components/SecurityCode` (centered monospace group-grid that never splits a group across a line, one-tap copy) on both the joiner's waiting card and the approver surfaces (2026-07-29); rejecting a join request now refreshes the inviter's sent-invitations list so the retired (declined) invite is revoked from the member card immediately (2026-07-29); approving a join request now notifies the joiner (dedicated `alertUser` push + a persisted `HouseholdNotice` `kind:'approved'` in their inbox) and excludes them from the household-wide "new member" alert; `HouseholdNotice.formerHouseholdId` generalized to `householdId` (2026-07-29); removal now also pushes the removed user directly (`alertUser`), and the floating Invitations button badge now counts membership notices + pending join-requests (was missing them) so it mirrors the inbox "New" tab (2026-07-29); outreach is now composer-only-for-non-accounts across ALL four sharing flows (household/trip/calendar/event) — an account-holder recipient gets the server push + in-app inbox with NO composer opening (household reads `userExists` off its POST; trips/calendars/events check `GET /invitations/lookup`, now accepting `phone` for existence-only lookups, failing open on error), the event `event_invitation` server email is retired (device-composed .ics-link email for non-account invitees via `sendInvitations` + `useEmailComposer`; recipient push added to `POST /invitations`), and every pending-invite row gained a paper-plane Remind action that re-opens the composer on demand regardless of account status (2026-07-29); `HouseholdScreen` accepts a **`promptInvite`** route param — a Calen assistant "Set up your household" setup chip (`setup_household`, see ai-assistant.md) deep-links here when the user wanted to share/assign but has no other members, showing a `SetupCallout` above the invite section (df8c7f3+, 2026-07-31); the Invitations inbox's entry point moved out of the calendar's floating chrome into **Profile** — a badged Invitations row (in the **"Personal"** group, second after Account's conventional identity lead: every feed behind the inbox is per-user — invites are addressed to the individual, and members never see each other's inboxes — while the household-scoped join-requests-to-approve keep their shared surface on HouseholdScreen), with the pending count also overlaid on the calendar's profile avatar (the E2EE-locked "!" takes precedence) so the badge trail leads avatar → Profile row → inbox; the floating `InvitationsButton` was deleted and its "New"-tab counting rules extracted to `hooks/useInvitationsCount` (unchanged: pending event/calendar/trip/household invites + join requests + undismissed membership notices + unacknowledged call outcomes) (df8c7f3+, 2026-07-31); **re-key access requests** — a collaborator who lost every unlock factor and re-keyed is held out of `missingMembers` AND the mint/rotate collaborator list until the owner approves: `POST /calendars/:key/access-request` queues them (pushing the owner, who is otherwise never told), `GET /calendars/keys/pending` returns them under `reapprovals` with their NEW `identityPublicKey`, and `POST /calendars/:key/keys/approve` is the only path that writes a wrap for a suppressed collaborator (server-enforced in `writeMemberWraps`, so a stale client can't complete an unseen re-grant). Accepting an invitation carries the suppression across the collaborator re-seat — the viewer shell auto-accepts on every focus, which would otherwise clear it (9282d82+, 2026-08-02); the Household name field capitalizes each word (`autoCapitalize="words"`, proper-noun rule in mobile/CLAUDE.md) (2026-08-10)
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
  - mobile/src/lib/joinCarryover.ts
  - mobile/src/lib/records.ts
  - mobile/src/lib/dropMigration.ts
  - mobile/src/lib/safetyNumbers.ts
  - mobile/src/lib/shareInvite.ts
  - mobile/src/hooks/useRosterSuggestions.ts
  - mobile/src/components/EmailAppSheet.tsx
tests:
  - server/src/test/householdInvitations.integration.test.js
  - server/src/test/householdKey.integration.test.js
  - server/src/test/householdLeave.integration.test.js
  - server/src/test/householdCarryover.integration.test.js
  - mobile/src/lib/__tests__/records.test.ts
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
  autocompletes over the **in-app contacts roster** (the decrypted Contacts
  records — Family/Friends/Professionals — via `contactsApi.list` + on-device
  decrypt), matching the typed text against a contact's name, email, or phone.
  Tapping a suggestion invites that address through the same
  `POST /household/invitations` path — no retyping. The source is the in-app
  roster, not the device address book; typing a raw email/phone for someone not
  on file still works.
  - **One row per reachable address, not one per contact.** A matched card lists
    *every* address it can be invited at — each email, then each phone —
    labelled with its contact-card label (`work · dee@work.com`,
    `mobile · (555) 123-4567`) and iconed by channel (envelope / message
    bubble). The sender picks the address; the field never silently decides for
    them. Phones are canonical E.164 (matching the account-phone form, above),
    shown prettified; an address repeated on the card collapses to one row.
  - **A taken address removes the whole CONTACT.** The caller's taken set
    (current members, pending/accepted invites, the signed-in user and their
    saved phone) is matched against every address on a card, and one hit drops
    the card entirely. Anything else reads as the bug it was: a member whose
    email was taken fell through to their *phone*, so an existing member showed
    up in the dropdown under a phone number while a non-member showed up under
    an email — and inviting it either bounced off `resolveShareTarget`'s
    "already in your household" or filed an invitation nothing could ever
    resolve.
  - Capped at 5 contacts and 6 rows; a contact is listed whole or not at all
    (the first match always lists in full, even if it alone exceeds the row cap).

  The roster query + matching live in the shared `hooks/useRosterSuggestions`
  (`matchRoster`), and back **every** invite field: the **calendar outside-share
  field** (AddCalendarScreen, which *stages* instead of sending) and the **event
  invitee field** (EventInviteesScreen, which stages until the ✓ / the event's
  save); details for both in [calendar](calendar.md). Each caller keeps its own
  taken set and send/stage semantics, and nothing else — an invite field that
  re-rolls the matching is drift, and was: the event picker kept a private copy
  that resolved each contact to its primary email, so a contact's other
  addresses were unreachable from the dropdown.
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
  contact's own inbox. Both approver surfaces refresh the sent list on reject
  (`HouseholdScreen` refetches; `InvitationsScreen` invalidates
  `['householdInvitations','sent']`) so the invite drops off the card
  immediately rather than lingering as "Accepted — approve them below". Re-inviting
  the same contact reopens the declined row.
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
- **A household change evicts the device's caches.** Joining, leaving, or being
  removed fires `subscribeHouseholdChanged` (raised by `ensureHouseholdKey` when
  the household moves under a live session — never on the first read after
  sign-in), and the app root runs the household-scoped half of the sign-out
  teardown: wipe the replica, reset the record-sync cursor with it, and reset the
  calendar-prefs and owned-add-on caches. The identity half is untouched — the
  user is still signed in and their per-user unlock is unaffected.

  This is a **privacy** requirement, not only a correctness one. The replica is a
  flat store of decrypted rows with **no `householdId` column**, and record sync
  removes a row only on a tombstone — which the household just left will never
  send again. Without the wipe, a departing or removed member keeps that
  household's calendar, meals, and tasks readable on their device indefinitely,
  while the leave dialog promises *"anything shared here stays with the other
  members."* Server-side the eviction is already complete (`handleDeparture`
  deletes their key envelope and flags rotation, and the carry-over below is gated
  on holding an envelope, so leaving can never pull the household's data out with
  them); this is the device half of it. Resetting the cursor alongside the replica
  is mandatory in the join direction too: the records of the household just joined
  are all older than the stale high-water mark and would otherwise never land.

### Join carry-over (a joiner's data follows them)

**Joining a household never writes to anyone's Contacts.** Membership and the
contacts roster are separate systems; the invite field uses the roster only as an
autocomplete source to resolve an email or phone, and discards the contact id. A
joiner's own self Contact travels with them under the carry-over below, but it
carries an `accountId` and is therefore excluded from every Contacts surface for
every member — so an existing member's roster is byte-for-byte unaffected by
someone joining, and never gains a duplicate, detail-less card for a person they
already had a contact for. See [contacts.md](contacts.md#roster-presentation).

Approving a join changes `User.householdId` and nothing else. **A member's records
do not travel with that flip**, and this is a crypto fact, not an oversight: under
C4 an `e2eeActive` household stamps its own `householdId` on every record and drops
the plaintext `userId`, so after the move the joiner's records match neither branch
of the read scope and are sealed under an HDK the destination household doesn't
hold. The server cannot fix this — it never holds a key, so it cannot re-seal.

- **The joiner's unlocked device performs the merge**, from `maintainKeyHygiene` on
  every unlock (`mobile/src/lib/joinCarryover.ts`). It runs **before** the other
  key-hygiene passes, which all work in current-household key versions and would
  otherwise skip the stranded rows entirely.
- **Authorization is envelope-holding, not membership.** `GET /household/carryover`
  serves records from any household the caller still holds a `HouseholdKeyEnvelope`
  for but is no longer a member of, together with that household's envelopes. This
  discloses nothing: the caller already possesses the key that opens them. A caller
  without the envelope gets nothing and is refused on write (403).
- **Records MOVE, keeping their `_id`.** `PUT /household/carryover/:id` takes the
  re-sealed blob and re-stamps `householdId` in place, so attachments, invitations,
  and every other reference by event/task id survive the merge. It is idempotent
  (`moved: false` for a row already carried over) and resumable — a row that fails
  is simply retried on the next unlock.
- **Resource-scoped records (`enc.ks` `cal`/`trip`) are excluded.** They route to
  collaborators in *any* household by `scope.resource`, so they are already
  reachable after the move; re-stamping one would corrupt the owner-side rotation
  accounting. A household still holding them is therefore never reaped.
- **Drain then reap.** `POST /household/carryover/complete` deletes the emptied
  household's tombstones (content-free, and the only thing left blocking the
  `handleDeparture` reap invariant) and retires the household with its key
  material — but only once it has no members and no live records.
- **Cross-household invitations are reconciled after the move, not by it.**
  Carry-over moves rows; it does not merge them, and it deliberately performs no
  content-based dedupe (the server is content-blind, and nothing in the app
  matches events on title/time). The one duplicate a join genuinely creates is an
  event the two people had already shared *across* households: the recipient's
  independent copy lands beside the organizer's original. That is resolved by its
  own pass, keyed on the `EventInvitation` row's exact `eventId` /
  `acceptedEventId` link — normative in
  [calendar.md](calendar.md#invitees--sharing) ("When the two households merge").
  It runs from `maintainKeyHygiene` immediately **after** carry-over, because the
  copy it resolves is one carry-over has just moved.
- **Add-ons need no carry-over.** Ownership is per user (`User.addons`) and takes
  effect as the union across household members, so a joiner's purchases travel
  with them automatically and are not surrendered to the household they leave.
  See [billing-plans.md](billing-plans.md).

**Sync must not block on a foreign row.** The record scope's `userId ∈ scopeIds`
branch serves *both* households' devices any stranded record that still carries a
plaintext `userId`, sealed under a key neither session holds. The replica's cursor
normally parks on an undecryptable row (correctly — "the key isn't ready yet"), but
for a foreign row that is permanent: the cursor wedges and **every** later row,
including the device's own, stops reconciling. Both members then see only what
their replica cached before the join — the household looks merged while neither
calendar ever converges. So `lib/records.syncRecords` classifies a live row from
another household (and not on the D1/D2 resource lane) as permanently unreadable
and skips it without blocking, exactly like a reaped tombstone. Rows in our *own*
household still block, or the original key-not-ready data-loss regression returns.

### Key lifecycle

- The owner lazily mints **HDK v1** on first unlock. Members read/rotate via
  `GET /household/key`, `POST /household/key`, `GET /household/member-keys`.
- **Removal → rotation:** removing a member flags rotation; the next member
  unlock mints HDK v(N+1) via `POST /household/key/rotate` (compare-and-set on
  the version, new-version envelopes for every remaining member). Old versions
  are kept for historical reads, then retired (`POST /household/key/retire`,
  `e2ee/old-versions`, `reseal-all`/`reseal-complete`) once nothing references
  them — a removed member's keys then open nothing. A member's **re-key**
  (lost every factor) flags the same rotation, which is what re-admits their
  new identity — see [crypto-e2ee](../platform/crypto-e2ee.md) "Re-key".
- **Start fresh (the one way the version moves backwards):** a re-key in a
  household where nobody else holds an envelope erases the now-unopenable
  records and resets `currentKeyVersion` to 0, so the ordinary owner mint
  issues a fresh HDK v1 and the account can save again. The erase reaches only
  **HDK-sealed** rows: a resource-sealed record (`enc.ks` `'cal'`/`'trip'`)
  seals under its own CalendarKey/TripKey that outside collaborators still
  hold, so it — and their member `ResourceKeyEnvelope`s — survive the reset
  and keep syncing over `scope.resource`. Normative rules in
  [crypto-e2ee](../platform/crypto-e2ee.md) "Re-key".
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
  `keyChangedAt`. While set, that contact is excluded from `missingMembers`
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
  new key belongs to the same contact. `POST /calendars/:key/keys/approve` is the
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
  join-requests, notices, key lifecycle, e2ee activation/readiness, join
  carry-over) and `server/src/routes/keys.js` (identity factors + public keys —
  see [auth-identity.md](auth-identity.md)).
  - Carry-over: `GET /household/carryover` (stranded records + the old
    household's envelopes), `PUT /household/carryover/:id` (re-stamp one
    re-sealed record), `POST /household/carryover/complete` (drain + reap).
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
- Join carry-over: a joiner's records are stranded by the move and listed for
  carry-over; the move re-stamps in place (same `_id`, no duplicate) and the other
  member's sync then returns it; a repeat move is a no-op; a caller without the
  old household's envelope is refused (403) and sees an empty listing; the caller's
  current household is never listed; resource-scoped rows are excluded and block
  the reap; purchased add-ons follow the joiner —
  `householdCarryover.integration.test.js`.
- Foreign-row sync safety (client-side): a live row from another household is
  skipped WITHOUT parking the cursor, so the feed can't wedge at the moment of a
  join; a row in our own household still blocks (key-not-ready); a D1/D2
  resource-scoped row stays retryable; nothing is foreign before we know our own
  household — `mobile/src/lib/__tests__/records.test.ts`.
- Security-alert audit events for enrollment and factor add/remove —
  `securityAlerts.integration.test.js`.
- Safety numbers (client-side): real-fingerprint lifecycle — unverified →
  verified sticks to a fingerprint, a key change flips to `changed` until
  re-verified at the new number, clear resets, self excluded —
  `mobile/src/lib/__tests__/safetyNumbers.test.ts`.

## Open questions

- Document exact role capabilities (member vs owner) for each mutating endpoint.
- Confirm the periodic (90-day) rotation trigger path end-to-end.
