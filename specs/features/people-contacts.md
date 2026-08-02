---
title: People & contacts
status: current
last-verified: 55bfc65+ (2026-07-28); contacts hold Apple-style multi-value labeled fields (phones/emails/addresses/dates/urls/relatedNames) + jobTitle/company, migrated from the legacy single fields on read (2026-07-27); phone fields use shared PhoneField (country picker + as-you-type), stored E.164 (2026-07-27); import handles iOS limited-contacts access + hide-imported filter (2026-07-27); import config moved to an options bottom sheet so the contact list is the hero (2026-07-27); out-of-credits forces Direct + Review each import (2026-07-27); import rows fully tappable, per-row Family/Friend switch removed (2026-07-27); contact address accepts a city via addressCity autocomplete (2026-07-27); labeled `dates[]` (anniversary/marriage/death/custom) now surface on the Occasions calendar alongside `birthday` (2026-07-28); `occasionsHidden` per-contact exclusion toggle by the Dates section (2026-07-28); linked related names auto-mirror onto the other contact with the inverse label, client-side add-only (2026-07-28); person-form phone rows use picker-free `PhoneTextField` (type local number, or leading +country-code for international; no country selector), still stored E.164 (2026-07-28); contacts gain Apple-style structured `firstName`/`lastName` (personal contacts edit two inputs; `name` is the composed source of truth; legacy names split on read; service/self keep a single name field; imports carry structured names) (2026-07-28); the contact add/edit form guards against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29); contact phones are canonicalized to E.164 at import + save (`lib/phone.canonicalizePhoneForStorage`, shared by `denormalizeForSave` and `ContactImportScreen`) so a saved contact number matches the account phone format and can resolve invites by exact match (2026-07-29); the person form's `focus` param gained **`'phone'`** (alongside `'dates'`) — a Calen assistant "Add this contact" setup chip (`setup_contact`, see ai-assistant.md) deep-links here scrolled to the Phone section with a `SetupCallout` explaining why, so the user can add a number Calen can call/text (df8c7f3+, 2026-07-31); the account holder's own self Person is no longer shown in the People roster (the pinned "You" card was removed — the user doesn't appear among their own contacts; the self card is edited from Account); the birthday is now merged into the person form's Occasion dates card as its **first date row** (label `birthday`, first/default date label; still stored in the dedicated `Person.birthday` field — split out of `dates[]` on save so the engine/e-cards/import are unaffected), each occasion-date row gained a clear-✕ on its value, date labels dropped the `other` preset (a non-kind date uses a custom label), and the label-picker bottom sheet pads past the safe-area inset so "Add Custom Label" is visible by default on short lists (df8c7f3+, 2026-07-31); the roster can be sorted by first or last name (device-local toggle, default first); contact field labels display Title Case (stored lowercase, display-only); device import now defaults to **Direct** with clear "nothing is imported automatically — you pick" copy up front, auto-selects all shown contacts under iOS *limited* access on a first import, and seeds the default contact type from the launching roster tab; a **Direct**-import review hides the "Ask Calen" form-assist panel (details came from the phone) and tints its header save check the app primary for contrast on the light header (a deliberate, review-import-only deviation from the transparent-white non-accented header rule); reciprocal related-name mirroring is still add-only for the label but now refreshes a linked contact's stale mirrored **name** when the saver renames themselves; and a contact can be written to the device address book on the user's request — opt-in "Also save to iPhone Contacts" when creating one, and "Add to iPhone Contacts" on the detail view (df8c7f3+, 2026-07-31); reciprocal related-name mirroring now also **propagates a relabel** (e.g. spouse → partner) to the linked contact — not just a rename — but only when the saver changed their own label (so an independently-customized mirror is preserved), and **deleting a linked contact clears the dangling related-name links** on the other cards (df8c7f3+, 2026-08-02); the contact detail view's quick-action row gained a **Share** action that exports the contact as a vCard 3.0 (`lib/vcard`) to the OS share sheet (`expo-sharing`) — a local, user-initiated export outside the E2EE boundary (df8c7f3+, 2026-08-02); a linked related name with a **custom** label gained a reciprocal-label control ("Who this contact is to them") so the user sets what this contact is called on the other card (e.g. daughter-in-law ↔ father-in-law) — stored as `reciprocalLabel`, mirrored symmetrically onto the linked contact (df8c7f3+, 2026-08-02); the redundant `marriage` date-label preset was dropped from `DATE_LABELS` so `anniversary` is the sole selectable wedding label (the shared engine still recognises a legacy `marriage` label on pre-existing contacts), and the label-picker bottom sheet now only wraps in a KeyboardAvoidingView for its custom-label input mode so the option list self-sizes and its "Add Custom Label" row isn't clipped (df8c7f3+, 2026-07-31); the label picker no longer pins the current custom (non-preset) label into its list — it shows only the fixed presets + "Add Custom Label" (a custom label lives solely on the row where it was created), and the picker's preset options now display Title Case (`textTransform: capitalize`) to match the label chip; the shared `BottomSheet` primitive was reworked so its `KeyboardAvoidingView` is the full-screen flex container (owning the scrim + docking the sheet) instead of a wrapper hugging the sheet — the custom-label input mode now sits flush on the keyboard with an opaque sheet over a firmer scrim (`rgba(0,0,0,0.6)`) instead of floating detached with the contact form bleeding through, and its text field auto-capitalizes per word (`autoCapitalize: words`) so a typed custom label reads Title Case — lowercased on save to preserve the stored-lowercase invariant (df8c7f3+, 2026-08-01); the Import-options sheet dropped its "Method"/"Apply" headings and segmented tabs for a plain stack of switches — a **"Review contact info"** switch first (on = review queue, the default; an import-all warning hint shows only while off), then an **"AI Assistant"** switch (off = Direct, the default); the per-import web-lookup toggle was removed — choosing AI-assisted implies the professional web lookup (client always sends `enrich: true`; the AI hint discloses it); the Direct/off-state "Tag each contact yourself; details come straight from your phone." hint was dropped (Direct shows no hint); both option switches' hints (Review contact info + AI Assistant) are now hidden by default behind an **info (ⓘ) button** beside each label (progressive disclosure — tap to toggle, independent of the switch state) rather than shown inline; the footer chip that opens the sheet now reads a static **"Import options"** instead of summarizing the current method/apply selections (df8c7f3+, 2026-08-01); the primary action button's label now depends only on the apply mode — `Review N` when Review contact info is on, else `Import N contact(s)` — dropping the special-case "Calen is sorting…" label for the AI-on + import-all combination (which now reads `Import N contact(s)` like any non-review import) (df8c7f3+, 2026-08-02); removing (or unlinking) a linked related name now cascades removal of the back-link on the other contact — `reciprocalUpdates` diffs the saved rows against `prevEntries` and emits mirror-removal writes for dropped links (was documented as never cascading) (df8c7f3+, 2026-08-02); the import picker's "already imported" flag no longer keys solely on `deviceContactId` — `lib/personFields.buildImportedMatcher` falls back to phone (E.164-canonicalized both sides) / email / exact-name identity, and the roster is ensure-loaded (fetched + decrypted when the shared `['people']` cache is cold, degrading to cache offline) — fixing Hide imported hiding nothing for contacts imported before the link existed; the Hide imported toggle is always shown and defaults on (df8c7f3+, 2026-08-02)
code:
  - mobile/src/screens/profile/PeopleScreen.tsx
  - mobile/src/screens/profile/PersonDetailScreen.tsx
  - mobile/src/screens/profile/PersonFormScreen.tsx
  - mobile/src/screens/profile/ContactImportScreen.tsx
  - mobile/src/components/MultiValueField.tsx
  - mobile/src/lib/personFields.ts
  - mobile/src/lib/deviceContacts.ts
  - mobile/src/lib/vcard.ts
  - mobile/src/lib/contactSortPref.ts
  - mobile/src/lib/phone.ts
  - mobile/src/lib/encSubsets.ts
  - server/src/routes/people.js
  - server/src/models/Person.js
tests:
  - server/src/test/people.integration.test.js
  - mobile/src/lib/__tests__/personFields.test.ts
  - mobile/src/lib/__tests__/phone.test.ts
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
  birthday/anniversary/death, spouse/parent/… — plus **Add Custom
  Label**; the option list scrolls within a capped height so longer vocabularies
  like the related labels fit small screens instead of overflowing the sheet, and
  the sheet pads its bottom past the safe-area inset so the last row — **Add
  Custom Label** on short lists like dates — is fully visible/tappable, not tucked
  under the home indicator), and each field
  is edited through the shared `MultiValueField` control (a red-minus remove per
  row, a green-plus "add" row; the value editor is field-specific — `PhoneField`
  for phones, `DateField` for dates, `PlacesAutocomplete` for addresses, plain
  input otherwise). **Labels are stored lowercase but displayed Title Case**
  (display-only — a `textTransform` on the form's label chip, on the picker's
  preset options, and a title-casing of the string on the contact detail rows;
  the stored value stays lowercase). A **custom label is never added to the
  picker's list** — the picker only ever shows the fixed presets + **Add Custom
  Label**; a custom value lives solely on the row where it was created (its label
  chip), not pinned into the picker for re-selection.
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
  kinds), assistant ↔ manager (`personFields.inverseRelatedLabel`).
- **Custom-label reciprocals:** a **custom** relationship label has no derivable
  inverse, so a linked custom related name gains a **"Who {this contact} is to
  {them}"** control (a label picker) beneath the row where the user sets the
  reciprocal label — e.g. link a **daughter-in-law** and set the mirror to
  **father-in-law**. It stored on the entry as `reciprocalLabel` and, for a custom
  label, is what `personFields.reciprocalLabelFor` returns for the mirror (else
  `other`); preset labels ignore it and derive their inverse. The mirror written
  onto the other card carries the inverse label **and** the saver's own label as
  *its* `reciprocalLabel`, so the other card's control is self-consistent (shows
  the real pairing, not a bare `other`). The control is shown only for a linked
  entry whose label is custom; typing a name by hand (which unlinks) also clears
  `reciprocalLabel`. The mirror is **client-side**
  (contacts are sealed; the server never sees relationship data) and **kept in
  sync** with edits on the linking card:
  - **Name** — renaming the saver refreshes the linked contact's back-link
    `value` (its now-stale copy of the old name) to the new name on the next save.
  - **Label** — **relabeling** the link (e.g. spouse → partner, or editing a
    custom `reciprocalLabel` like father-in-law → parent-in-law) propagates the
    new mirror label, but **only when the saver actually changed the mirror label
    they want** for that link (compared via `reciprocalLabelFor` against the
    previously-saved related names, `reciprocalUpdates`'s `prevEntries`). An
    unrelated re-save never clobbers a label the other card independently
    customized, and when the resulting mirror label is unchanged (mother → father
    both invert to child) no write is emitted.
  A back-link already carrying the current name+label produces no write. A failed
  back-link write never fails the save (best-effort, retried naturally on the next
  save). Unlinked (free-text) related names are not mirrored. `sibling` joined the
  preset labels alongside brother/sister.
- **Deleting a linked contact clears the dangling links:** removing a contact
  also strips every related-name entry on *other* contacts whose `personId`
  pointed at the deleted one (`personFields.relatedNameRemovalsOnDelete`), so no
  card is left showing a relationship to someone who no longer exists.
  Client-side and best-effort (a failed cleanup write doesn't block the delete).
- **Removing a related name cascades to the mirror:** deleting a *linked*
  related-name row (or unlinking it by typing a free-text name over it) and
  saving also removes the back-link entry on the formerly-linked contact — the
  entries whose `personId` points back at the saver (`reciprocalUpdates`
  detects the dropped link by diffing the saved rows against `prevEntries`).
  Same shape as the other mirror writes: client-side (contacts are sealed),
  best-effort, one write per affected contact, and no write when the other
  card carries no back-link. A link that merely changed label/value is a sync,
  not a removal; free-text rows that were never linked cascade nothing.
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
  occasion kind**: `birthday`, `anniversary`, and `death` are the selectable
  recognised kinds; any other label is a `custom` occasion under that label.
  `anniversary` is the wedding label — the redundant `marriage` preset was
  dropped, though the engine still recognises a legacy `marriage` label on
  pre-existing contacts. **`birthday` is the first + default date label**, and
  **there is no `other` catch-all preset** — a date that isn't a recognised kind
  takes a **custom label** (the picker's "Add Custom Label"). These surface on the **Occasions**
  calendar as read-only annually-recurring events (see
  [calendar.md](calendar.md#occasions-calendar-free-opt-in-add-on-id-birthdays);
  `shared/calendar` `occasionKindFromLabel`).
  **Birthday is presented as the first occasion-date row** in the person form's
  **Occasion dates** section — a new personal contact starts with an empty
  Birthday row so it's the default. It remains stored in the dedicated
  **`Person.birthday`** field (the shared engine, e-cards, and import read it
  there, and `dates[]` never contains a birthday): the form **splits the
  "Birthday" row back out** to that field on save (the first birthday-labeled row
  with a value wins) and persists the rest as `dates[]`. **Each occasion-date row
  carries a clear-✕** on its value (any `DateField`), distinct from the red-minus
  that removes the whole row. The **contact detail view** likewise renders the
  birthday **inline as the first row of the dates group** (gift icon), not as a
  separate field above them.
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
  holder (`User.personId`), edited from the **Account** screen (not the People
  roster, where it is hidden — see Roster presentation). It is identified by its
  sealed `accountId` matching the signed-in user.
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
- The roster can be **sorted by first name (default) or last name**, chosen from
  a small toggle above the list and persisted **device-local**
  (`lib/contactSortPref`, key `hc_contact_sort`). The sort key reads the
  structured `firstName`/`lastName` (via `normalizePerson`, so legacy
  single-`name` records sort sensibly): last-name order leads with the surname
  (falling back to the first name for single-token/business names) then the first
  name as a tiebreak, and the sticky **letter section headers follow the same
  key** so grouping matches the chosen order.
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
- The account holder's own self Person is **not shown in the roster** — it is
  excluded from every tab (the user doesn't appear among their own contacts) and
  is edited from the **Account** screen. Other household members' cards still
  appear and carry a **"Member"** chip. The **"+"** add action stays in the **navigation header**
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

- **Nothing auto-imports.** Granting contacts access only lets the user *pick*
  which contacts to bring in — the screen states this up front (a `Hint` above
  the list, and the same reassurance in the denied-state copy). Import is
  explicit: select contacts, then tap the action.
- **Default method is Direct.** The screen opens on **Direct** (you pick; details
  come straight from the phone); AI-assisted is opt-in from the options sheet
  (and only offered when consent + credits allow — see below).
- **Default contact type follows the launch tab.** Opening import from a roster
  tab (Family / Friends / Professionals) seeds the imported contacts' default
  `type` from that tab (`ContactImport`'s `type` route param, passed by
  `PeopleScreen`); it's still adjustable per contact in the Review-each form.
- **Direct import:** pick device contacts and create People
  (`ContactImportScreen`). All of a device contact's phone numbers and emails are
  carried through as labeled multi-value entries (the label comes from the device
  entry, e.g. mobile/home/work); the first of each stays the primary the AI
  classifier sees. Imported phone numbers are **canonicalized to E.164 at import
  time** (`lib/phone.canonicalizePhoneForStorage`, device-country calling code
  applied to a national number), so a contact's number is stored in the **same
  format as the account phone** — the AI classifier's/web-lookup's returned
  primary is canonicalized the same way. This is what lets a saved contact number
  resolve a household/trip/calendar invite by exact match; the loose form the
  address book hands over (e.g. `(604) 555-1212`) would otherwise never match a
  stored `+16045551212`. The single canonicalization rule is shared with the
  person form's save path (`personFields.denormalizeForSave` →
  `canonicalizePhones`); legacy contacts saved before this re-canonicalize on
  their next edit, and the invite pickers canonicalize at read time as a backstop. Each contact row is **fully tappable** to toggle selection (not
  just the checkbox). The picker has **no per-row type switch** —
  the roster has three types (Family / Friends / Professionals), so a two-way
  Family/Friend toggle was misleading; a Direct import defaults each contact's
  type to the **launching roster tab** (falling back to `friend`) and the type is
  set in the **Review-each** form's Type field (all three options) or adjusted
  later on the person.
- **Layout:** the device-contact list is the primary content and fills the
  screen; only a search field and the selection row (select-all · hide-imported ·
  count) sit above it. The set-once import configuration lives in an **"Import
  options" bottom sheet** and is a plain stack of switches (no "Method"/"Apply"
  headings, no segmented tabs), in order: a **"Review contact info"** switch
  (on by default) and an **"AI Assistant"** switch (off = Direct, the default).
  Each switch's explanatory hint is hidden behind an **info (ⓘ) button** beside
  its label — not shown by default; tapping the info button toggles the hint,
  independent of the switch's on/off state. The Review hint explains the
  review-each-vs-import-all behavior; the AI hint discloses both the
  name/company-only classification and the professional web lookup. There is
  **no separate web-lookup toggle** — turning on the AI Assistant implies it.
  The sheet opens from a footer chip next to the primary action; the chip
  reads a static **"Import options"** (not a summary of the current
  selections), rather than the configuration being always-visible controls and
  prose above the list.
- **Limited device access (iOS):** iOS may grant *limited* contacts access (a
  user-picked subset); `getContactsAsync` then only ever returns that subset, so
  the screen must not treat "granted" as "all". When the permission's
  `accessPrivileges` is `limited`, `ContactImportScreen` shows an info banner
  offering **Choose more contacts** — `Contacts.presentAccessPickerAsync()` on
  iOS 18+ re-presents Apple's picker in-app, then re-reads the address book
  (preserving any in-progress selection/tags) — and a **Full access in Settings**
  deep-link (`Linking.openSettings()`) for older iOS or a permanent widening.
  The `denied` state likewise offers an **Open Settings** action rather than a
  dead-end message. On a **first** import under *limited* access (nothing imported
  yet), the shown subset is **auto-selected** — the user already hand-picked
  exactly whom to share, so pre-selecting them saves a "select all" tap; it's a
  one-shot default, so a later manual deselect sticks.
- **Re-import & duplicates:** a device contact already in the roster carries an
  **"Imported"** badge, and re-selecting one triggers a duplicate-confirm dialog
  before it is imported again. "Already in the roster" matches by the stored
  `deviceContactId` link first, **falling back to identity** — a shared phone
  (both sides canonicalized to E.164, so pre-canonicalization free-form numbers
  still match), a shared email (case-insensitive), or the exact full name
  (case/whitespace-insensitive, never partial) — so people imported before the
  link existed, imported on another device, or added by hand still flag
  (`lib/personFields.buildImportedMatcher`). A name-only match may flag a
  same-named stranger; that trade is deliberate — the flag only badges the row
  and gates the confirm dialog, it never blocks an import. The picker **ensures
  the decrypted roster is loaded** (fetching + decrypting via the shared
  `['people']` query when the cache is cold; an offline/failed fetch degrades to
  whatever is cached) instead of passively reading the cache, which silently
  flagged nothing when this screen was reached before the People list had
  fetched. The **Hide imported** filter is always shown and **defaults on**, so
  the list opens focused on what's left to add; unticking it reveals the badged
  rows.
- **AI-assisted:** `POST /people/classify` categorizes contacts. The model sees
  each contact's **name and company only**; phone/email/birthday merge back
  server-side from the request, unseen by the model. **Web-search enrichment of
  businesses/pros is implied by the AI-assisted method** — the client always
  sends `enrich: true` on the AI path (no separate toggle; the server flag and
  its service-contacts-only scope are unchanged), and the AI switch's hint
  discloses the lookup. `POST /people/import` parses
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
  Back cancels, like any add/edit form). The import passes an `aiReview` flag into
  `PersonForm`: a **Direct**-import review **hides the "Ask Calen" form-assist
  panel** (the details came straight from the phone — nothing to re-derive),
  while an **AI-assisted** review keeps it. In the review queue the header save
  check is tinted the **app primary** (rather than the neutral transparent-white
  of a non-accented header) so it's easy to see and not missed while stepping
  through many contacts — a deliberate, **review-import-only** deviation from
  [mobile/CLAUDE.md](../../mobile/CLAUDE.md)'s non-accented header-action rule.
- **Out of AI credits forces Direct + Review each.** Classification spends
  credits, so an empty balance (`!billing.unlimited && creditBalance <= 0`, the
  app's standard credit gate; `unlimited` admins are exempt) makes AI-assisted
  import unavailable exactly like a consent opt-out — the screen auto-corrects
  the method to **Direct** and locks the apply mode to **Review each** (each
  contact is confirmed in the person form by hand rather than batch-saved),
  explaining that the reason is an exhausted balance. The gate is optimistic
  until `useBilling` resolves.

### Export & share a contact

- A Calen contact can be **written to the device's (Apple/Android) address book**
  on the user's explicit request — the write counterpart to import. It is
  **opt-in, never automatic**, and offered two ways:
  - **On create:** the person form shows an **"Also save to iPhone Contacts"**
    switch (default off) — only when *creating a brand-new* Calen contact (not
    editing, not a device-import review, not the self card, since an imported
    contact already lives on the phone). On save, if enabled, the contact is
    added to the device and the returned id is stored as `deviceContactId`.
  - **On the detail view:** an **"Add to iPhone Contacts"** button writes the
    contact to the address book; if it may already be there
    (`deviceContactId` set) it confirms before adding another copy.
  Both paths share `lib/deviceContacts.addPersonToDeviceContacts`, which requests
  **write** contacts permission (`Contacts.requestPermissionsAsync`, expo-contacts
  `/legacy`), builds a `Contacts.Contact` (Person vs. Company by `type`; name /
  first / last, phones, emails, addresses, URLs, company, job title, birthday) and
  calls `Contacts.addContactAsync`. It is **best-effort**: a denied permission
  (`ContactsPermissionError`) or write failure surfaces a note but never blocks
  the in-app save.
- **Share the contact:** the contact detail view's quick-action row (Call / Text
  / Email) also carries a **Share** action (rightmost). It builds a standards-
  compliant **vCard 3.0** (`lib/vcard.buildVCard` — the same field set as the
  device export: structured `N`/`FN`, `ORG`/`TITLE`, labeled `TEL`/`EMAIL`/`ADR`/
  `URL`, `BDAY`; values vCard-escaped), writes it to a `.vcf` in the cache
  directory (`expo-file-system`), and hands it to the OS share sheet
  (`expo-sharing`, `mimeType: 'text/vcard'` / `UTI: 'public.vcard'`; falls back to
  React Native's `Share`). The Share action is always shown (a name-only contact
  can still be shared). Like the device export, this is a **local, user-initiated
  export of the user's own decrypted contact** — see the Encryption boundary.

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

Writing a contact **to the user's own device address book** (the opt-in "save /
add to iPhone Contacts" flows above) — and **sharing a contact as a vCard** via
the OS share sheet — is **outside** the E2EE boundary by design: the boundary is
the network/server, not the user's own hardware. The decrypted contact leaves the
device only into the OS address book / share sheet at the user's explicit
request; nothing sealed is exposed to Calen's servers.

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
  assistant↔manager / custom→`other`) and the back-link builder (skips
  unlinked entries, unknown ids, self-links, already-linked contacts; dedups per
  target; **refreshes a stale mirrored name on rename**, **propagates a relabel
  only when the saver changed the wanted mirror label** without clobbering an
  independently-customized mirror, and emits nothing when the mirror is already
  current); the **custom-label reciprocal** (`reciprocalLabelFor` + the mirror
  carrying the saver's label as its `reciprocalLabel`, round-tripped through
  normalize/save); plus `relatedNameRemovalsOnDelete` clearing dangling links when
  a linked contact is deleted — `mobile/src/lib/__tests__/personFields.test.ts`.
- The consent gates on `/classify` (403 with AI off) are verified in
  [ai-assistant.md](ai-assistant.md)'s `aiPrivacy.integration.test.js`.
- Person CRUD/visibility rides the opaque record store — verified under
  [platform/data-model.md](../platform/data-model.md); self-Person seeding is a
  client behavior (no server write path to test).

## Open questions

- The bulk-import encryption follow-up above.
