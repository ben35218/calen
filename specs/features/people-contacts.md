---
title: People & contacts
status: current
last-verified: 55bfc65+ (2026-07-28); contacts hold Apple-style multi-value labeled fields (phones/emails/addresses/dates/urls/relatedNames) + jobTitle/company, migrated from the legacy single fields on read (2026-07-27); phone fields use shared PhoneField (country picker + as-you-type), stored E.164 (2026-07-27); import handles iOS limited-contacts access + hide-imported filter (2026-07-27); import config moved to an options bottom sheet so the contact list is the hero (2026-07-27); out-of-credits forces Direct + Review each import (2026-07-27); import rows fully tappable, per-row Family/Friend switch removed (2026-07-27); contact address accepts a city via addressCity autocomplete (2026-07-27); labeled `dates[]` (anniversary/marriage/death/custom) now surface on the Occasions calendar alongside `birthday` (2026-07-28); `occasionsHidden` per-contact exclusion toggle by the Dates section (2026-07-28); linked related names auto-mirror onto the other contact with the inverse label, client-side add-only (2026-07-28); person-form phone rows use picker-free `PhoneTextField` (type local number, or leading +country-code for international; no country selector), still stored E.164 (2026-07-28); contacts gain Apple-style structured `firstName`/`lastName` (personal contacts edit two inputs; `name` is the composed source of truth; legacy names split on read; service/self keep a single name field; imports carry structured names) (2026-07-28); the contact add/edit form guards against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29)
code:
  - mobile/src/screens/profile/PeopleScreen.tsx
  - mobile/src/screens/profile/PersonDetailScreen.tsx
  - mobile/src/screens/profile/PersonFormScreen.tsx
  - mobile/src/screens/profile/ContactImportScreen.tsx
  - mobile/src/components/MultiValueField.tsx
  - mobile/src/lib/personFields.ts
  - mobile/src/lib/encSubsets.ts
  - server/src/routes/people.js
  - server/src/models/Person.js
tests:
  - server/src/test/people.integration.test.js
  - mobile/src/lib/__tests__/personFields.test.ts
---

# People & contacts

## Purpose

The household's people directory — family, friends, contacts, service pros —
plus the shared self "You" card. Occasions (birthdays plus labeled contact dates)
surface on the calendar. Contacts can be imported directly from the device or
with AI assistance.

## Behavior (normative)

- **Unsaved-changes guard:** the contact (Person) add/edit form prompts an
  Apple-style "Discard Changes?" sheet before leaving with unsaved edits (header
  ✕ / back / swipe-back / Android back), via the shared `useUnsavedChangesGuard`
  hook — a successful save/delete (or a review-queue skip/advance) exits without
  prompting; the read-only self ("You") card never prompts. See
  [calendar.md](calendar.md) and [mobile/CLAUDE.md](../../mobile/CLAUDE.md).

### People

- A `Person` has a name, `type`, relationship, `birthday`, notes, `jobTitle`,
  `company`, and **Apple-Contacts-style multi-value labeled fields**: `phones`,
  `emails`, `addresses`, `dates`, `urls`, and `relatedNames`. (Structured-name
  details in the next bullet.)
- **Structured names (Apple First / Last).** `name` is the **canonical composed
  display name** — the single source of truth for the roster, sorting, e-cards,
  related-name mirrors, initials, and surname bolding. Personal contacts
  (family/friend) additionally carry **`firstName` / `lastName`** structured
  components, edited as **two inputs** ("First name" / "Last name") in the person
  form; `name` is **recomposed** from them on save (`composeName` =
  `[firstName, lastName]` trimmed & space-joined). **Service** (business)
  contacts and the read-only **self** card keep a **single name field** (a
  business like "Joe's Plumbing" doesn't split), so their first/last stay empty.
  Legacy records hold only `name`: `normalizePerson` **splits** it for the form
  (first whitespace token → first name, the remainder → last name) so old
  contacts pre-fill sensibly, and the next save persists the structured fields.
  `firstName`/`lastName` are sealed content in the `PERSON_ENC` subset. The AI
  form assistant still fills a single "name" — the form routes it into the
  first/last inputs (split) or the single field (service). Device/vCard imports
  carry structured names through when available (expo-contacts `firstName`/
  `lastName`; vCard `N` given/family), else the form splits the display name.
  The roster **bolds the surname** using the structured `lastName` when present
  (exact, handles multi-word surnames), falling back to the last token.
- **Multi-value labeled fields.** Each labeled value
  is `{ label, value }`; a related name additionally carries an optional
  `personId` linking it to another roster contact. Labels come from a **label
  picker** (bottom sheet of presets per field type — mobile/home/work,
  anniversary/other, spouse/parent/… — plus **Add Custom Label**; the option
  list scrolls within a capped height so longer vocabularies like the related
  labels fit small screens instead of overflowing the sheet), and each field
  is edited through the shared `MultiValueField` control (a red-minus remove per
  row, a green-plus "add" row; the value editor is field-specific — `PhoneField`
  for phones, `DateField` for dates, `PlacesAutocomplete` for addresses, plain
  input otherwise).
- **Multi-value migration (E2EE-safe):** contacts are encrypted, so the server
  can't rewrite old rows. `lib/personFields.normalizePerson` folds the **legacy
  single** `phone`/`email`/`address`/`businessName` fields into single-entry
  arrays (and `businessName`→`company`) **on read**, so records predating the
  cutover still display; `denormalizeForSave` writes the arrays and **clears the
  legacy singles** on the next save. Both the arrays and the legacy singles stay
  in the `PERSON_ENC` subset so the clear (set-to-`undefined`) actually drops them
  from the sealed blob.
- **Reciprocal related names:** saving a person whose related name is **linked
  to a roster contact** (`personId`) mirrors the connection onto that contact —
  a `{ label, value: saver's name, personId: saver's id }` entry with the
  **inverse label**: symmetric labels mirror as themselves (spouse/partner/
  friend/sibling), gendered ones collapse to the neutral inverse because the
  other card's gender is unknown (mother/father/parent → child; child/son/
  daughter → parent; brother/sister → sibling; grandparent kinds ↔ grandchild
  kinds), assistant ↔ manager, and custom/unknown labels fall back to `other`
  (`personFields.inverseRelatedLabel`). The mirror is **client-side**
  (contacts are sealed; the server never sees relationship data) and
  **add-only**: a contact that already links back is never relabeled, removing
  a related name never cascades a removal, and a failed back-link write never
  fails the save (best-effort, retried naturally on the next save). Unlinked
  (free-text) related names are not mirrored. `sibling` joined the preset
  labels alongside brother/sister.
- Addresses accept a **full street address _or_ just a city** — the autocomplete
  (`type='addressCity'`, Places proxy) suggests precise addresses and localities
  so a contact whose exact home is unknown can be located to the city; the value
  is stored as free text (no region filter — contacts may live anywhere).
  Service/pro contacts use the `business` autocomplete on their first address
  (name or address) and, on selecting a business, its Places phone number is
  added as a phone. `company` (labeled "Business name" for service contacts)
  supersedes the old service-only `businessName`. In the **person form** phones
  are entered via the picker-free `PhoneTextField` — no country selector; the
  user types a local number (formatted for the device region as they type) or a
  leading `+<country code>` for an international one — so the number takes the
  full row width. Elsewhere (Account, event location, trip items) phones use the
  shared `PhoneField` with its country picker (flag/dial code + as-you-type). Both
  store canonical **E.164**.
- **Dates** (`dates`) are labeled `YYYY-MM-DD` values whose **label carries the
  occasion kind**: `anniversary`, `marriage`, and `death` are recognised kinds;
  any other label is a `custom` occasion under that label. Together with the
  dedicated `birthday` field, these surface on the **Occasions** calendar as
  read-only annually-recurring events (see
  [calendar.md](calendar.md#occasions-calendar-free-opt-in-add-on-id-birthdays);
  `shared/calendar` `occasionKindFromLabel`). `birthday` stays its own field.
  `occasionsHidden` (sealed, default false) **excludes** a contact from the
  Occasions calendar — a "Show on Occasions calendar" switch in the
  **Occasion dates** section of the person's card.
  A person may link to a device contact (`deviceContactId`) and, for members, to
  an `accountId`.
  (The former interests/hobbies field was removed 2026-07-27 — it had no AI
  role after data minimization and no longer exists on the form, model, or
  classify schema. Notes are a plain human-facing field; AI never sees them,
  so the form labels them "Notes", not "Notes for AI". The AI form assistant
  fills the scalar fields plus the **primary** (first) phone/email only.)
- The self "You" card is a household-shared `Person` representing the account
  holder (`User.personId`), edited from the People page — there is no separate
  "About you" screen. It is identified by its sealed `accountId` matching the
  signed-in user.
- **Self-Person seeding (mandatory E2EE):** the server can no longer create
  readable content, so `Person.ensureSelf` no-ops once the household is
  `e2eeActive` and the **client** seeds the encrypted "You" record (the P1
  ensureSelf pattern). Seeding runs **at app boot**, and again the moment the key
  unlocks — not only when the People page is opened — so every person-assignment
  UI (chores, event invitees, …) always has at least "You" to pick. It no-ops
  while locked, on a not-yet-`e2eeActive` household, or once a self-record
  already exists. Because the opaque store keeps no content columns, the seed
  MUST seal both `type` (`'family'`) and `accountId` into `enc` via the shared
  `PERSON_ENC` subset; a partial subset that drops them leaves the card
  unrecognizable as "You" and ungrouped in the roster.
- People are content records (CRUD via the opaque `/records` store); the
  `people` router is **import/AI only**.
- **Every person sealer uses the shared `PERSON_ENC` subset**
  (`lib/encSubsets.ts`) — the store keeps no content columns, so a partial
  sealer silently loses fields; in particular a subset missing `type` makes the
  saved contact invisible (the roster tabs bucket by decrypted `type`). On
  edit, the decrypted existing record is spread under the form payload before
  sealing so fields the form doesn't show (`accountId`, `deviceContactId`)
  survive the re-seal. `PeopleScreen` reaps the fallout of the pre-fix sealer:
  a decrypted, non-`accountId` Person with no valid `type` is unreachable from
  every tab and can only have come from that bug, so it is tombstoned on load
  (one-shot per mount).

### Roster presentation

- The People page is a **3-tab contacts roster**: **Family** (`type: 'family'`),
  **Friends** (`type: 'friend'`), and **Professionals** (`type: 'service'`). The
  active tab's contacts render as an **iOS-Contacts-style alphabetical list**
  (`SectionList`, not a `ScrollView.map`): each row is an **initials avatar** +
  the contact's name with the **surname bolded** (single-token names render
  plain); rows group under **sticky letter section headers**, sorted and
  section-keyed by name, with a trailing **"#"** bucket for names that don't
  start with a letter.
- A **right-edge A–Z scrubber** jumps the list to a letter, snapping to the
  nearest following section when that exact letter is empty. It is hidden while
  searching or when the roster is empty.
- A **floating search pill** (bottom-centered, above the safe-area inset)
  filters the active tab's contacts as you type. Matching is across every
  human-facing field — **name, relationship ("how you know them"), address/city,
  business name, and email** (case-insensitive substring) — plus **phone**,
  which is matched on **digits only** (both sides stripped of formatting) since
  it is stored as canonical E.164. The scrubber and letter headers stay
  meaningful because search only narrows the current tab.
- The self **"You"** card pins to the **top of the Family tab** (outside the
  lettered sections) and opens the Account screen; household members carry a
  **"Member"** chip. The **"+"** add action stays in the **navigation header**
  (transparent-white `HeaderIconButton`, per mobile/CLAUDE.md's non-accented
  header rule) and adds into the active tab or opens device import — it is not
  duplicated as a floating button.

### Occasions

- A person's `birthday` plus their labeled `dates[]` (anniversary/marriage/death/
  custom) drive read-only, annually-recurring events on the **Occasions**
  calendar. Alert timing is a single calendar-level setting (default: noon on the
  day + two weeks before), and any occasion can schedule a mailed **e-card** to
  selected contacts. See [calendar.md](calendar.md#occasions-calendar-free-opt-in-add-on-id-birthdays).

### Contact import

- **Direct import:** pick device contacts and create People
  (`ContactImportScreen`). All of a device contact's phone numbers and emails are
  carried through as labeled multi-value entries (the label comes from the device
  entry, e.g. mobile/home/work); the first of each stays the primary the AI
  classifier sees. Each contact row is **fully tappable** to toggle selection (not
  just the checkbox). The picker has **no per-row type switch** —
  the roster has three types (Family / Friends / Professionals), so a two-way
  Family/Friend toggle was misleading; a Direct import defaults to `friend` and
  the type is set in the **Review-each** form's Type field (all three options) or
  adjusted later on the person.
- **Layout:** the device-contact list is the primary content and fills the
  screen; only a search field and the selection row (select-all · hide-imported ·
  count) sit above it. The set-once import configuration — **method**
  (AI-assisted / Direct), **apply mode** (Review each / Import all), the
  **web-lookup** toggle, and their privacy explanations — lives in an **"Import
  options" bottom sheet** opened from a compact summary chip in the footer next
  to the primary action, rather than as always-visible controls and prose above
  the list.
- **Limited device access (iOS):** iOS may grant *limited* contacts access (a
  user-picked subset); `getContactsAsync` then only ever returns that subset, so
  the screen must not treat "granted" as "all". When the permission's
  `accessPrivileges` is `limited`, `ContactImportScreen` shows an info banner
  offering **Choose more contacts** — `Contacts.presentAccessPickerAsync()` on
  iOS 18+ re-presents Apple's picker in-app, then re-reads the address book
  (preserving any in-progress selection/tags) — and a **Full access in Settings**
  deep-link (`Linking.openSettings()`) for older iOS or a permanent widening.
  The `denied` state likewise offers an **Open Settings** action rather than a
  dead-end message.
- **Re-import & duplicates:** the picker never hides already-imported contacts;
  each carries an **"Imported"** badge and re-selecting one triggers a
  duplicate-confirm dialog before it is imported again. An optional **Hide
  imported** filter (shown only when at least one listed contact is already
  imported) narrows the list to new contacts when re-importing after widening
  access.
- **AI-assisted:** `POST /people/classify` categorizes contacts. The model sees
  each contact's **name and company only**; phone/email/birthday merge back
  server-side from the request, unseen by the model. **Web-search enrichment of
  businesses/pros is opt-in per import** (`enrich: true` + the "Look up
  professionals on the web" toggle, default off). `POST /people/import` parses
  an uploaded vCard file into contact candidates; the client seals and creates
  each person through `/records` (the plaintext `POST /people/bulk` create was
  retired with C3b). AI paths are consent-gated — see
  [ai-assistant.md](ai-assistant.md). Because classification necessarily ships
  contact names/companies to the model, `ContactImportScreen` offers the
  **AI-assisted** method only when **both** `aiEnabled` **and**
  `aiUsePersonalInfo` are on; with either off it hides that option, explains why,
  and falls back to Direct import (server-side, `/classify` also 403s via
  `requireAiEnabled`).
- **Review-each queue:** with **Review each**, selected contacts are stepped
  through the person form one at a time (header title `Review N of M`); the header
  check saves-and-advances. A **skip** action (ghost `Button` — "Skip this
  contact", or "Skip & finish" on the last) appears only for a **multi-contact**
  queue; a single-contact import shows no skip button (the header check saves,
  Back cancels, like any add/edit form).
- **Out of AI credits forces Direct + Review each.** Classification spends
  credits, so an empty balance (`!billing.unlimited && creditBalance <= 0`, the
  app's standard credit gate; `unlimited` admins are exempt) makes AI-assisted
  import unavailable exactly like a consent opt-out — the screen auto-corrects
  the method to **Direct** and locks the apply mode to **Review each** (each
  contact is confirmed in the person form by hand rather than batch-saved),
  explaining that the reason is an exhausted balance. The gate is optimistic
  until `useBilling` resolves.

## Data & API surface

- **Model:** `Person` (content record, sealed in the opaque store; `birthday`
  encrypted, with calendar date-filtering relocated client-side). Multi-value
  fields (`phones`/`emails`/`addresses`/`dates`/`urls` as `{label,value}`,
  `relatedNames` adding `personId`) + `jobTitle`/`company` are subdocs on the
  Mongoose schema and members of the `PERSON_ENC` sealed subset; the legacy
  single fields remain for back-compat.
- **Endpoints:** `people.js` (`POST /import`, `POST /classify`); CRUD via `/records`.
- **Client:** `screens/profile/{People,PersonDetail,PersonForm,ContactImport}Screen`;
  multi-value editing via `components/MultiValueField` (+ its label picker) with
  `lib/personFields` owning the label vocabulary and the read-time fold /
  save-time clear; self-Person seeding in `lib/selfPerson.ts` (`ensureSelfPerson`),
  driven at boot by `hooks/useSelfPersonSeed` (mounted in `RootNavigator`) with
  `PeopleScreen` as a fallback caller.

## Encryption boundary

Person details (including birthdays and addresses) are sealed content records.

> **Known gap:** the automatic bulk import path has historically been
> plaintext-only — confirm whether it now seals like the interactive path, and
> pin the answer here + in [platform/data-model.md](../platform/data-model.md).

## Verification

- vCard import parsing (FN / N-fallback names, folded lines, **labeled
  multi-value TEL/EMAIL/URL** with TYPE→label normalization + a legacy single
  primary, BDAY normalization incl. dropping no-year dates, structured ADR, NOTE)
  and its missing-file / no-contacts rejections — `people.integration.test.js`.
- Classify minimization: the model receives names + companies only (captured at
  the network edge); phone/email/birthday merge back server-side; unknown keys
  are dropped and unknown types coerce to `friend`; web-search enrichment runs
  only with `enrich: true` and only for `service` contacts —
  `people.integration.test.js`.
- Reciprocal related names: the inverse-label map (symmetric / gendered-neutral /
  assistant↔manager / custom→`other`) and the add-only back-link builder (skips
  unlinked entries, unknown ids, self-links, already-linked contacts; dedups per
  target) — `mobile/src/lib/__tests__/personFields.test.ts`.
- The consent gates on `/classify` (403 with AI off) are verified in
  [ai-assistant.md](ai-assistant.md)'s `aiPrivacy.integration.test.js`.
- Person CRUD/visibility rides the opaque record store — verified under
  [platform/data-model.md](../platform/data-model.md); self-Person seeding is a
  client behavior (no server write path to test).

## Open questions

- The bulk-import encryption follow-up above.
