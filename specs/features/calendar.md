---
title: Calendar & events
status: current
last-verified: 46cd98a+ (2026-08-04); **switching grid density no longer rebuilds the grid** — `density` was part of the week-row cache's validity signature, so picking Compact/Stacked/Details flushed every cached row and re-derived the whole window synchronously on the frame the switcher popover was trying to animate closed (the expensive part being the spanning-bar pass, which scans every event and trip per row, and which is identical in all three densities); the row build is now split into a density-INDEPENDENT core (cells + bars, cached per week) and a pure arithmetic layer (`lib/monthGrid.weekLayout` → height, header height, whether the weather lane shows), with density moved out of the signature and into the cache KEY, so a switch re-expands nothing, re-scans nothing, and returning to a density already seen is a straight cache hit; the switch is additionally deferred a frame so the popover's dismissal paints first, matching the month/year jump sheet (2026-08-04); **the past edge no longer grows while the today pin owns the scroll position** — a prepend is compensated both by `maintainVisibleContentPosition` and by the pin's re-snap, and the two together walked the viewport back into the freshly prepended rows and prepended again, a runaway that swept the sticky header month (and the jump sheet's highlight, which reads the same row) through one month after another; the header row is now tracked by row KEY rather than index (a prepend shifts every index at once), and the pin does not scroll at all when today falls outside the window, since offset 0 is the past edge (2026-08-04); **the month-boundary rule is now an ordinary week rule, drawn only over the days the month owns** — the first row of a month block used to carry a full-width 1px `colors.primary` border, which both shouted (a coloured rule in a grid whose every other line is a `colors.border` hairline) and hung over the blank cells leading into the 1st; the row-level border is gone and each own-month day cell draws the standard hairline itself, so the line starts at the 1st (applies at every grid density — Compact, Stacked, Details — and in free viewer mode's `ViewerMonthGrid`) (46cd98a+, 2026-08-04); **the grid family now lays its weeks out as month blocks** — each month renders its own Sunday-first grid and blanks the neighbouring month's days, so a boundary week is rendered once per month and real whitespace separates one month from the next (the Apple Calendar layout, replacing the unbroken run of weeks that ran December straight into January); spanning bars and the weather lane clip at the boundary, the 1st carries the abbreviated month name in the app **primary** over the row's opening rule, and the sticky label / month jump / today anchor now key off the row's own block month instead of guessing it from the week's Wednesday; the geometry is pure and unit-tested in `lib/monthGrid.ts`, and `ViewerMonthGrid` carries the identical layout (2026-08-04); expanded-instance date-shape contract documented — `expandRecurringTaskChore` returns Date-valued `nextDueDate` for recurring items but passes one-time values through as strings (2026-08-04); follow-up: the shared `BottomSheet` now tears down **without** its exit animation when the CALLER drops `visible` (only a user dismissal — scrim/grabber-drag/back — slides out), because iOS refuses to present a second Modal while the first is still dismissing: picking **Custom…** in the event form's Alert or Second Alert picker closed the option list, never showed the dual-wheel sheet, and left an invisible modal window swallowing every touch on the event form (same class for the Repeat picker's Custom… which pushes a screen) (2026-08-02); **navigation presentation audit** — the app's four presentation idioms (push / modal / BottomSheet / headerless-with-floating-chrome) are now stated as rules in mobile/CLAUDE.md and applied here: the **Calendars manager** and the **Invitations inbox** changed from modal to **push** (both are browsable hierarchy, and Calendars drills four screens deep), **Print** changed from push to **modal** (finish-and-dismiss), every modal ✕ is now the shared `HeaderCloseButton` (28px, 8pt hitSlop, "Close" label — the hand-rolled 26px unlabeled ones are gone), `CalendarSearch` dropped its `#000` header + hairline divider for the standard `colors.background` + no shadow, and the shared `BottomSheet` gained a real slide-up, a grabber, and drag-to-dismiss (the date/time picker still commits the wheel's current value on any dismissal, drag included) (2026-08-02); 9282d82+ (2026-08-02); **the sources query's embedded snapshots now refetch on store change** — `['calendar','sources']`/`['viewer','sources']` embed `accessibleCustomIds` + `ownedAddonIds`, so a fetch racing ahead of the session's calendar-list refresh (or booting on a stale add-on cache) locked custom-calendar events and add-on lanes into the snapshot with no repaint path until an unrelated invalidation; `commitCustom` and `cacheOwnedAddons` now invalidate both query trees when their contents actually change, quiet on identical echoes (2026-08-02); 9282d82+ (2026-08-02); **fixed a silent data-loss defect in the D1 event re-seal** — `reSealEvents` rebuilt each migrating event's sealed payload from a hand-written 6-field list while `EVENT_ENC` seals 20, so every migration (first-share mint, revoke-rotation) DELETED the other 14 from the ciphertext (the plaintext columns were dropped at C3b, so nothing else holds them); the fatal one was `calendarType`, which lives only inside the sealed blob (the row's plaintext routing is `scope.resource`) and is what BOTH the owner's grid and the viewer's agenda bucket by — a re-sealed event was served fine, decrypted fine, and rendered on no calendar for anyone, which is why an outside-shared calendar came up empty for the collaborator; `reSealEvents` now seals `EVENT_ENC({ ...event, calendarType: resource })`, the reconcile pass groups candidates by `calendarType || scope.resource` so an already-stripped event is still found (grouping on the sealed field alone stranded it under a retired key), and a new owner-only `repairCalendarLaneEvents()` (run from `maintainKeyHygiene` as its OWN call — `reconcileCalendarKeys` early-returns precisely when there's no pending key work) restores `calendarType` from the plaintext lane for already-damaged events, idempotent and refusing to rewrite anything it couldn't decrypt; `allDay`/`recurrence`/`exceptionDates`/alerts/travel/`url`/`placeId` deleted by the old truncation are NOT recoverable (2026-08-02); **the D1 owner reconcile now runs on every unlock** — `maintainKeyHygiene` (→ `reconcileCalendarKeys`/`reconcileTripKeys`) moved from the relaunch-restore path into the auth store's keys-ready hook, fixing the fresh-login gap where an owner who signed out and back in never wrapped the CalendarKey for a newly accepted collaborator (their "waiting for the owner" state was permanent); free-viewer shells now **auto-accept** pending calendar shares (no viewer Accept/Decline — normative in billing-plans.md) (2026-08-02); **the Weather screen's "Where's home?" prompt now stands alone and clears itself** — the missing-address check moved into `isMissingHomeAddressError` (`lib/weatherSource.ts`, unit-tested), the 90-day seasonal outlook card is hidden while the prompt shows (it could only stack "Could not load seasonal outlook" under a card already asking for the address), the CTA passes `promptField: 'homeAddress'` so Account arrives highlighted, and saving a changed address invalidates the `['weather']` + `['homeAddress']` query trees so the still-mounted Weather screen behind Account re-fetches instead of showing its cached error again (2026-08-02); **switching between the grid family and List now preserves the viewed month in both directions** — each layer reports its visible month into a host ref (`viewedMonth`) and adopts it on becoming active (grid→List re-cursors the carousel, today selected when the adopted month is today's else the 1st; List→grid teleports via `jumpTo`, no-op when already there); List's former unconditional enter-on-today re-centre is retired (2026-08-02); the **List layer's month-label header is now the same month/year jump-sheet button** as the grid family's sticky header — the label + sheet pair extracted to a shared `MonthJumpHeaderButton` (exported from `MonthJumpSheet`); in List a pick teleports the month carousel via its cursor (tapped-day selection stays put, matching a swipe), and the button owns the sheet's open state outside the heavy calendar layer + defers the pick's jump one frame so the sheet opens/dismisses instantly (the grid additionally caches built week rows by underlying-input identity across window growth and renders them via a memoized `WeekRow`, so a jump only computes/renders the newly covered weeks) (2026-08-02); shared-lane key loading now covers the OWNER side too — `ensureCollaboratorCalendarKeys` became `ensureSharedCalendarKeys`: besides the member wraps for `mine:false` calendars it also loads the household wrap for the user's own calendars with `calKeyVersion > 0` (surfaced on the serialized calendar + `CustomCalendarRecord`), and it moved from `maintainKeyHygiene` (restored sessions only) to the auth store's keys-ready hook so it runs on EVERY unlock — fixes the owner's outside-shared calendar coming back EMPTY after sign-out/sign-in (the wiped replica re-pulled cal-scoped rows but nothing reloaded the CalendarKey: `reconcileCalendarKeys` skips steady-state calendars and `openOpaqueRecord` doesn't lazy-load resource keys) (2026-08-01); the month grid's fixed 12-month window (2 past + 9 future, inherited from the web initView) is retired — the grid scrolls an **unbounded month window**: opens last-month → +3 (`lib/calendarWindow.initialWindow`), grows 6 months at whichever edge the user nears (one extension per edge until it moves; upward growth anchored by `maintainVisibleContentPosition={{minIndexForVisible:1}}` so prepends don't jump), and the sticky Month-Year header label became a button (chevron-down) opening the **month/year jump sheet** (`MonthJumpSheet`: ‹ year › stepper + 3×4 month grid, visible month filled primary / today's month tinted; a pick grows the window via `ensureCovers` and snaps un-animated to that month's first majority week); the grid's load split into a range-independent sources query (`loadCalendarWindowSources`, `['calendar','sources']` — now also carrying the parsed ICS feed masters via `calendarFeeds.loadFeedSources`/`expandFeedSources`) + **synchronous render-time per-month expansions** (`expandCalendarRange` made sync; memoized per month in the grid, cache reset on sources change) merged by `lib/calendarWindow.mergeCalendarChunks` (identity dedup; unit-tested with the window math in `lib/__tests__/calendarWindow.test.ts`), with `loadCalendarData` now a thin composition of the two halves and the week builder bucketing items by date (O(1) cell lookups); the sync-derived shape replaced a first-cut per-month `useQueries` layer the same day — async chunk state made an event save re-key and re-fetch every month (whole-grid reload/skeleton flash); saving an event now repaints in one pass with one re-render (2026-08-01); collaborator half of D1 + server-side view-only enforcement (free viewer mode) — new `lib/calendarKeys.ensureCollaboratorCalendarKeys()` loads the member-wrapped CalendarKeys for calendars shared TO this user (`mine:false`) and re-pulls the record feed so shared events decrypt into the replica (runs from the viewer shell, on calendar-invitation accept, and from `maintainKeyHygiene` — previously nothing ever loaded a collaborator's member wrap, so shared events silently stayed ciphertext); `/records` now enforces calendar-lane write access server-side from the record's plaintext `scope` (POST/PUT/DELETE with a stored or incoming `scope.kind:'calendar'` require `full` effective access via `canWriteCalendarType`, 403 otherwise; stored scope gates a scope-less body; trips exempt) — superseding the C3b-era "enforcement moved to CalendarKey possession + the client" doctrine; `EventFormScreen` recomputes its read-only collaborator view from the calendar's `access === 'view'` (the server `readOnly` stamp is dead post-C3b); the locked-user viewer shell itself is specced in billing-plans.md "Free viewer mode" (2026-07-31); the calendar Outside-My-Household add field gained the contacts-roster autocomplete the household invite field already had (shared `hooks/useRosterSuggestions` + `matchRoster`, suggestions exclude staged outside entries / member emails / the owner; a tapped suggestion stages at View Only then runs the same lookup-gated outreach), placeholder now "Add name, email, or phone…", keyboard stays open across adds, a spinner replaces the add button during the account lookup, and the "They're on Calen" note clears on typing; the reveal-above-keyboard wrap was extracted to `components/ui.RevealWrap` and the event-invitee picker switched to it, fixing its silent no-op `useRevealOnOpen` call (null scroll context from the Screen-rendering component) that left the suggestion dropdown occluded by the keyboard (2026-07-30); the Add-ons storefront row on the Calendars view is now permanent — when every add-on is owned it no longer disappears but persists as the stable store/manage entry (HOUSEHOLD group's closing row) with subtitle "All add-ons added" instead of the catalog list, so the entry point keeps its learned location and future add-ons surface there (2026-07-30); the Event Action (call placement) screen shows the flat call price ("~N credits/min", from `billing/status.actionCosts.callPerMinute`) above the call CTA — pre-call cost transparency per billing-plans.md (2026-07-30); the Appointments built-in calendar's default colour is now blue `#1976D2` (was purple `#7B1FA2`) in both defaults maps (`lib/calendarPrefs.CALENDARS` + `lib/calendar.CALENDAR_COLORS`); device colour overrides are untouched, and the colour editor's reset now returns Appointments to blue (2026-07-29); `guestListVisible` and hand-set `cancelled` writes now go through client re-seal — the Invitees screen's guest-list toggle (`calendarApi.setGuestListVisible`) and both mark-cancelled surfaces (`calendarApi.cancelEvent`) re-seal the event via the replica instead of PUTting the field plaintext, which the opaque store rejects on an E2EE household with the misleading "update to the latest app version" error (the TestFlight-19 invitee bug); the event form also seals `guestListVisible` into every create/edit payload so the flag survives re-seals and syncs across devices (2026-07-29); calendar loading is now cache-first — `loadCalendarData` gained a `sync: 'inline' | 'background'` mode: the interactive views (month grid, List layer, day timeline/agenda, search) paint immediately from the local replica while `revalidateCalendar()` pulls records+settings+trips concurrently behind the paint and invalidates `['calendar']` only on actual change (deduped, 10s floor; trips reconciled into the replica including removals; grocery config cached device-local in `hc_grocery_settings`); a never-synced device falls back to inline; holiday chips render on mount independent of the data query; the month grid's first-load spinner was replaced with deterministic per-cell skeleton placeholders (per density) and the List layer's day list with `SkeletonList` (2026-07-29); deleting a recurring event offers Apple's "Delete This Event Only" (adds the occurrence's day to a sealed `exceptionDates` list the shared engine skips) vs "Delete All Future Events" (sets `recurrence.until` to the day before, or deletes the series when it's the first occurrence); shared by the detail view + edit form via `lib/eventDelete.ts` + `calendarApi.excludeOccurrence`/`truncateSeries` (HDK-sealed; outside-shared calendars not yet handled) (2026-07-29); event detail view now reflects every configured field — recurrence summary line ("Repeats weekly … until <date>", accent-coloured), a Travel Time row (duration + "Leave by" on timed events), and an Apple-style mini hour-grid timeline card placing the event block by its clock time (timed events only; all-day omits it), whose block content adapts to duration — >1h shows title+location+time, exactly 1h drops location, <1h shows title only; the "Delete Event" control is an Apple-style translucent floating pill **pinned to the screen** (a sibling of the scroll view, so it stays fixed while content scrolls beneath it instead of scrolling away attached to the map); the location map closes the scroll content below it (2026-07-29); the event detail view re-pulls the event on focus (`useFocusEffect`) so edits made in the form — e.g. turning off recurrence, which un-hides the Cancel/Reschedule card — are reflected on return without a manual refresh; the Cancel/Reschedule card moved to sit directly below the timeline card and above the Calendar row (was down among the alert/travel rows); its title shortened to "Cancel/Reschedule" (was "Cancel or Reschedule", which truncated in the one-line card title) (2026-07-29); Starts/Ends picker commits on dismiss (tap-away accepts) + start-time change past the end drags the end to preserve duration, and the symmetric reverse — editing the end (time or date) before the start drags the start back to preserve duration, via shared lib/datetime.startKeepingDuration reused by every Starts/Ends form (2026-07-28, reverse 2026-07-29); event detail view renders both alerts grouped in one divided card, with the Delete Event pill floating over the location map (2026-07-28); Birthdays→Occasions calendar (labeled contact dates as annual occasions), calendar-level occasion alerts, scheduled e-cards (2026-07-28); per-contact occasion exclusion (`occasionsHidden`) + occasion rows open PersonForm scrolled to Dates (2026-07-28); e-card recipients scoped to the occasion's contact + linked contacts, with inline add-email + per-recipient address picker for multi-email contacts (2026-07-28); scheduled-card indicator on the occasion row + edit/cancel + live email preview (2026-07-28); occasions render as kind icons (not chips) on the month grid and tap through to the Occasions screen from calendar/day/agenda surfaces (2026-07-28); a tapped occasion scrolls to the top of the Occasions list and is highlighted (`focus` param) (2026-07-28); e-card hour picker opens scrolled to noon (2026-07-28); e-card style gallery — 3 designs per occasion kind, greeting-card email with CSS-motion progressive enhancement, in-form style picker + animated live preview (2026-07-28); e-card personalization — fully editable card lines (greeting/sign-off/signature overrides), email-safe font menu, up to 3 inline CID photos (2026-07-28); default greeting + subject address recipients by first name only (2026-07-28); travel-time origin is an editable "starting address" (home-seeded, not labelled as home) with Current-location + Home one-tap shortcuts via shared `lib/currentLocation.ts` (2026-07-28); the two event alert slots must be distinct — each picker excludes the other slot's value (`excludeUsedAlert`) so the same lead time can't be set twice (2026-07-28); event attachments always seal on-device before upload (removed the plaintext fallback) and the server accepts iOS's relabeled opaque-binary content-types so the encrypted `.bin` ciphertext isn't dropped as "No file uploaded"; the event view previews attachments in-app via a WebView (images + PDFs render inline on the AttachmentPreview screen, Share button in the header) — WebView is used instead of RN's <Image>, which hard-crashes on the new architecture in both an RN <Modal> and a plain native-stack screen; expo-sharing alone (the interim fix) only gave the share sheet, not a direct preview (2026-07-29); the End Repeat (`until`) date loads back as the local Y-M-D via `ymd(new Date(until))` instead of slicing the ISO's UTC date, fixing a one-day-forward drift on every edit in behind-UTC timezones (2026-07-29); new events default travel time **on** only once the event location (destination) is set, then with the origin seeded from the user's current location, but only when location has already been shared with the app (`resolveCurrentAddressIfShared` reads the granted permission without prompting, and no GPS fix is taken until a destination exists); applied once so it doesn't override the user turning it back off; with no destination or no shared location the default is off; editing an existing event leaves its saved travel-time setting untouched; the Travel Time row shows "On" while enabled but not yet computed instead of "None"; the "Home" origin shortcut decrypts the E2EE-sealed home address client-side via shared `lib/homeAddress.ts` (2026-07-29); the Occasions empty-state CTA now reads "Add dates in Contacts" (was "…in People") to match the app-wide Contacts naming (copy-only) (2026-07-29); the Add-ons storefront row's subtitle names the full add-on catalog in store order with **no price** (every add-on, owned or not; the store screen does the selling) — spec + CalendarsScreen tests aligned to the shipped component, which dropped the earlier per-locked price line (2026-07-29); leaving the event form or its Invitees screen with unsaved edits (header ✕ / back / swipe-back / Android back) prompts an Apple-style "Discard Changes?" action sheet, guarded app-wide via the shared `useUnsavedChangesGuard` hook (listens on React Navigation `beforeRemove`; a successful save/delete/leave calls `allowLeave` to exit without prompting) (2026-07-29); editing an event **never** auto-changes its travel time — the debounced drive-time recompute is suppressed while the destination/origin still match what the event loaded with (a `travelSeedRef` snapshot), so merely opening a travel-enabled event no longer silently nulls-and-refetches its saved minutes (which also spuriously dirtied the unsaved-changes guard); recompute resumes only once the user actually edits the destination or starting point (2026-07-29); the pushed **Travel Time** sub-screen now carries a header ✓ checkmark (+ ✕ close) like the app's other form sub-screens — edits already sync back live via the travelDraft store, so the checkmark just confirms/returns (2026-07-29); do-not-call is now surfaced on both call screens — the Event Action screen pre-checks the event's number (`GET /calls/suppressed`) and disables the call button with a reason when it's suppressed, and the Interaction outcome view shows an explicit "asked not to be called again" notice driven by the per-call `dncCaptured` flag (2026-07-29); the Cancel/Reschedule card now appears on **recurring** events too, scoped to the tapped occurrence — the call carries `PhoneCall.occurrenceDate` (the occurrence's local Y-M-D) + that day's start instant, and the call-derived cancelled/reschedule dimming is re-keyed from series-id to event+occurrenceDate (`lib/callStatus.buildEventStatus`, consumed across the month grid / day timeline / agenda / list / detail), so one call dims only its own instance; unscoped/legacy calls still match every day; the series-wide "Mark appointment as cancelled" fallback is hidden on recurring occurrences (2026-07-29); the card moved to be the first row of the details group (directly above the Calendar card) and its title relabelled "Reschedule/Cancel" (was "Cancel/Reschedule"); the two idle states (no-phone / ready-to-call) dropped their explanatory subtitle so the row is a clean single-line "Reschedule/Cancel" button (2026-07-29); tapping the card with no business number yet routes to the Location view with a `promptPhone` flag that shows a prominent callout banner at the top ("Add a business phone number to activate calling.", styled per the app's tinted-banner convention and tinted with the event's own calendar colour rather than the app primary — was a muted hint that blended in) and highlights the phone field (2026-07-29); calendar-share email invites (AddCalendarScreen outside-share) now compose via the shared mail-app chooser (`useEmailComposer`/EmailAppSheet — behavior specced in households-sharing.md) instead of a bare `mailto:` (2026-07-29); clearing the event location now switches travel time **off** (and drops the saved/computed drive time) on both the add and edit forms — travel time is anchored to the destination, so removing the destination removes travel time; only ever turns it off, so it can't fight the user re-enabling it (2026-07-29); accepting a cross-household event invitation now seals the recipient's **own** copy on-device (client-minted `_id` + HDK-sealed `enc` with `invitationId` folded in) and posts that to `POST /invitations/:id/accept`, matching the C3b server contract — the mobile client previously posted the bare plaintext snapshot `{ event }`, which the opaque store rejects with "A sealed event copy (_id + enc) is required", so accepting any sealed invite in-app failed; a locked vault now surfaces an "unlock your vault" message instead (the seal is factored into `lib/invitees.sealAcceptedCopy`, unit-tested) (2026-07-29); the organizer's device now actually forwards `guestListVisible` on every `invitationsApi.send` (sealed/plaintext/SMS lanes, via `sendInvitations`) — it was previously never sent, so the per-invitation flag always defaulted to visible and the "Guests can see guest list" toggle was a silent no-op (recipients always saw the guest list regardless of the switch) (2026-07-29); the Starts/Ends duration-keeping rule is now symmetric in both directions — editing the **start** (time or date) to at/after the end pushes the **end** forward to preserve the span (new `lib/datetime.endKeepingDuration`/`endTimeKeepingDuration`, mirrors of `startKeepingDuration`/`startTimeKeepingDuration`), so the end is never left before the start on the event form, the trip and trip-item/journey forms, and the cancel/reschedule time windows (closing an equal-date hole where advancing the start date onto the end's day previously produced end-before-start) (2026-07-29); the event-detail mini timeline card is now a **compact, fixed-size window** (`TIME_CARD_MAX_HOURS = 3`, opening ~1h before the event) so a long event no longer stretches the card into a wall of hours — an event longer than the window overflows it and has its block **clipped at the card's bottom edge** (`blockBottom = clipped ? canvasH : y(endDec)`) while the block's start–end text keeps the true end time (2026-07-29); event invite outreach is now device-composed end-to-end (households-sharing.md policy): the server `event_invitation` email is retired — `POST /invitations` instead pushes account-holder recipients (title-free for sealed invites) and the organizer's device composes the .ics-link email for non-account invitees via `sendInvitations` + the mail-app chooser (`eventInviteEmailContent`, sealed invites get a notice-only body since their public .ics 404s); `GET /invitations/lookup` also accepts `phone` (existence only); the Invitees screen's pending email rows gained a paper-plane Remind; calendar outside-shares now skip the composer for account-holder recipients (lookup-gated, fail-open) with their own row Remind (2026-07-29); the shared calendar engine gained `deriveAvailability` — a free/busy reduction over already-expanded events + trip overlays (timed events → busy hour-blocks, trips → whole "away" days, all-day events → a soft note that keeps the day free, and tasks/chores/meals/grocery excluded as non-occupying) consumed by the calendar assistant's new `get_availability` tool; the busy/free rule and its waking-window/timezone handling are specced in [ai-assistant.md](ai-assistant.md) (2026-07-30); the event Location view's `promptPhone` callout now renders via the shared `components/ui.SetupCallout` (extracted from its inline banner, still tinted with the event's calendar colour — behavior unchanged), and the calendar assistant can now route the user to it itself via a `setup_event_phone` setup chip when it needs a number to call an event about (see ai-assistant.md) (df8c7f3+, 2026-07-31); the calendar assistant's **edit and delete now actually work on mobile** — the `open_edit_event_form`/`delete_event` tools stage the action for a device-side confirm tap (an "Open the event to edit" chip opening the native `EventForm`, or a single "Delete from my calendar" chip that batch-deletes the staged events through the shared `lib/eventDelete` `assistantDeletePerform` — one-off delete, or recurring exclude-occurrence vs delete-series) instead of the old web `navigateTo` route the RN app silently dropped (which left forms un-opened and events un-deleted while the model falsely reported success); behavior specced in [ai-assistant.md](ai-assistant.md) (df8c7f3+, 2026-07-31); the event **Location view** was reworked from a search field stacked over an always-visible Name/Address/Phone form (two competing input models, and a picked place's Google address duplicated the name into the Address field) into a **single-input-model state machine** — Empty (search + "Enter an address manually" escape hatch), Picked (the resolved place collapses into a read-only card: static map, name, and the address on its own line with the leading business name stripped, plus an ✕ to change it), and Manual (Name/Address fields + "Search for a place instead" back-link, entered automatically for a saved location that has no place_id); the business phone stays an editable field in all three states; storage is unchanged (single de-duplicated `location` string + `placeId` + `phone`) (df8c7f3+, 2026-07-31); the calendar's floating chrome was **re-hierarchized by priority** — the bottom-left pill became a labelled **Today | Calendars** pair (Calendars promoted from an ambiguous calendar-glyph icon to a text label), the assistant entry was promoted from a pill icon to a standalone 56pt **Calen FAB** alone in the bottom-right corner (surface disc, gradient C at 28pt, one shadow step above the pills) — the screen's single primary action — and the `fromAssistant` "‹ Calen" return pill moved from the avatar slot to the FAB slot (the avatar stays put — see ai-assistant.md); the **Invitations inbox lost its floating button entirely** (month and day views; `components/InvitationsButton` deleted): it is event-driven, not frequency-driven, so its entry point moved to a badged **Invitations row in Profile** and the count now cascades — calendar avatar badge (E2EE-locked "!" takes precedence, else the pending count, 9+ cap) → Profile's Invitations row (same count) → the inbox; the "New"-tab counting rules were extracted to `hooks/useInvitationsCount` (df8c7f3+, 2026-07-31); occasion contacts hidden via `occasionsHidden` are now **omitted entirely** from the Occasions list (the old dimmed "Hidden from calendar" group was removed — they were already skipped everywhere else), and the list's `Hint` shows only when occasions exist while the empty state gained a clear "add a date to a contact" message; the copy now treats birthday as one of the contact's dates (birthday was merged into the person form/detail dates card) and says "contacts", not "People" (df8c7f3+, 2026-07-31); e-cards are now **one-time** — a card sends on its next upcoming occurrence then deactivates (`ECard.active`/`sentAt` replace the old annual `lastSentYear` guard in `runECardCheck`), the form hint reads "Sends once on `<next date>`", and the E2EE plaintext-exception disclosure is shown at **create time only**; the e-card recipients card gained an **"Add a related contact"** row that opens the occasion contact itself (`PersonForm` `focus: 'related'`, scrolled to Related names) to manage the link — the newly linked contact then appears as a recipient candidate automatically on return (recipients = the occasion contact + their related names) — and the editable card lines gained a visible edit affordance ("Tap to edit" pencil badge — tapping it focuses the greeting line with the caret at the start — plus dashed underlines); the **Print** month-grid layout now wraps event titles to **2 lines** (CSS line-clamp, no more one-line ellipsis) and prints **compact 12-hour times** ("1PM") with a Print-screen **24-hour clock** toggle ("13:00"); the **Subscribe** screen gained an optional email-driven **provider helper** (detect Gmail/iCloud/Outlook → deep-link to their calendar-link settings + steps; the user still pastes the URL); the **Calendars view** rows show a **leading** Apple-style on/off circle carrying the calendar's colour (filled check-circle shown / empty dimmed circle hidden), replacing the old leading accent bar; the per-country **Holidays editor lost its "Remove <country>" danger button** (removal stays available via Calendars → Edit Calendar → Delete); and the modal-presented **Attachment/Place preview** screens gained a top-left close ✕ (df8c7f3+, 2026-07-31); the day view (single/multi-day all-day lane + List agenda) now renders date-only **chores** as Chores-calendar items — tinted in the Chores calendar colour and badged with the chore's own MaterialCommunityIcons glyph (`AllDayItem.icon`, sourced from `Chore.icon`), replacing the muted empty-circle reminder chip; date-only **tasks** keep the muted dot (df8c7f3+, 2026-07-31); the day-view icon treatment was extended to **events** (a generic calendar glyph, `EVENT_ICON = 'calendar-blank-outline'`) and **occasions** (their `occasionIcon` kind glyph) — both the all-day lane chips and the List agenda rows now lead with the colour-tinted glyph instead of a plain colour bar (the timed hour-grid blocks are unchanged); and the **List** view gained a **"Today" divider marker** above today's header (accent lines + label, mirroring the Occasions view), with today always kept as a section when it's in-window (even empty, unless the whole window is empty) so the marker anchors the list (df8c7f3+, 2026-08-01); the List view's explicit **"Load earlier"** button was replaced by **infinite scroll upward** — scrolling within `EARLIER_THRESHOLD` (80px) of the top prepends the previous `EXTEND_DAYS` stretch, anchored by `maintainVisibleContentPosition={{minIndexForVisible:1}}` (new-arch default) so content grows above the viewport without a jump; a `loadingEarlier` ref guards re-fires until `window.start` moves, and a fixed-height header spinner shows while it settles (the scroll-restore `scrollToLocation`/`onScrollToIndexFailed` dance was removed) (df8c7f3+, 2026-08-01); the **Occasions list** was reworked from a flat forward-only run (every occasion shown at its next occurrence, so a just-passed date silently jumped to the bottom ~12 months out and there was no sense of the window being viewed) into a **today-anchored timeline** — `lib/occasions.collectOccasions(people, now?)` anchors each occasion to the occurrence nearest today and returns a signed `offset` (recently-passed within `PAST_WINDOW_DAYS` (7) → negative, today → 0, else next upcoming → positive), and the screen renders **Recently observed** (dimmed, no schedule prompt, "Sent" pill when its one-time card already went out), a **"Today · `<date>`"** marker, **Coming up** (the highlighted `COMING_UP_DAYS` (60) plan-ahead horizon carrying the e-card envelope), and a collapsed **"Later this year (N)"** tail (auto-expanded when a calendar-tapped focus occasion lives there); `whenLabel` gained past phrasings ("Yesterday" / "N days ago"); windowing extracted from OccasionsScreen into `lib/occasions.ts` + unit-tested (`lib/__tests__/occasions.test.ts`, injectable `now`) (df8c7f3+, 2026-07-31); the redundant **`marriage`** date-label preset was dropped — `anniversary` is now the sole wedding label offered in the contact date-label picker (`DATE_LABELS`), though the shared engine still recognises a legacy `marriage` label on pre-existing contacts (kind/noun/icon/e-card templates for it are retained for backward compatibility) (df8c7f3+, 2026-07-31); the **thunderstorm** weather icon composite was rebuilt on the Rainy pattern — only the glyph's lower band is rendered (blue base for the drops + a gold centre strip for the bolt) under the standard white cloud, with band/strip positions measured from the Ionicons TTF and an explicit `width: size` on every clipped inner glyph (an RN Text measures at most its parent's width and iOS clips the glyph to the Text's own bounds, which had made narrow clip windows show the wrong glyph slice — the gold right drops + stray blue cloud edge of the first attempt, then the gold bolt strip rendering nothing) (df8c7f3+, 2026-08-01); the event form's **Title** field now declares `autoCapitalize="sentences"` explicitly so the keyboard opens shifted and the first letter of a new or edited title is capitalized without reaching for shift (df8c7f3+, 2026-08-02); the **calendar-name** field on New Calendar and Subscribe now dismisses the keyboard on Done (explicit `onSubmitEditing` → `Keyboard.dismiss()`) — the name is the only typed step on either screen (everything below it is tapped), and the platform blur-on-submit default was leaving the keyboard up over the sharing/colour rows (9282d82+, 2026-08-02); **holiday alerts** — the holidays editor gained the Occasions view's notifications button, opening a new **Holiday Alerts** screen (Alert / Second alert / Alert at) whose one config is shared by every holiday calendar the user has; device-local, default OFF, muted per-calendar by that calendar's Alerts switch, fired on-device (see notifications.md) (46cd98a+, 2026-08-04); **a record write now invalidates the `['calendar']` queries at the CRUD chokepoint** — `lib/recordStore` already mirrored every create/update/delete into the replica the calendar assembles from, but nothing told the cached sources query to re-read it (30s `staleTime`, no refetch-on-focus, grid mounted as a tab), so an editor had to remember `invalidateQueries(['calendar'])` and the person form didn't: editing a contact's occasion dates repainted the Occasions list (`['people']`) while the month grid kept the pre-edit dates until the next sync pass; `recordStore` now invalidates after mirroring a write to a calendar-bearing collection (`CalendarEvent`, `MaintenanceTask`, `Chore`, `Person`, `RecipeSchedule`), coalescing bursts (bulk contact import) into one pass (46cd98a+, 2026-08-03); **a timed event no longer walks its start date forward one day per edit** — the event form read a loaded event's clock time in the device's LOCAL zone but took its calendar date by slicing the stored ISO string, which is UTC, and west of UTC a late-evening event has already rolled over (Aug 3 11:05pm EDT = Aug 4 03:05Z), so opening an 11:05pm event showed Aug 4, saving wrote Aug 4 11:05pm, and every further edit→save cycle stepped it one more day (the end, read the same way, stayed put, so the event also looked spuriously multi-day); the storage convention — all-day at noon UTC and read in UTC, timed as a real instant and read entirely in local — is now encoded once as the exact-inverse pair `eventWhenFromStored` / `eventStoredFromWhen` in `lib/calendar.ts` that the form uses in both directions, so a load→save round-trip is a fixed point (unit-tested over repeated cycles under a pinned `America/New_York`), and a same-local-day end folds back to a blank End date instead of reading as multi-day (46cd98a+, 2026-08-03)
code:
  - mobile/src/screens/calendar/
  - mobile/src/lib/calendar.ts
  - mobile/src/lib/calendarData.ts
  - mobile/src/lib/calendarWindow.ts       # unbounded month-window math + per-month chunk merge
  - mobile/src/lib/monthGrid.ts            # month-block geometry (Apple-style blocks) + boundary bar clipping
  - mobile/src/lib/eventRepeat.ts
  - mobile/src/lib/occasions.ts            # occasion kind → title/icon/noun + list windowing (collectOccasions)
  - mobile/src/lib/recordStore.ts          # CRUD chokepoint: mirrors writes into the replica + invalidates ['calendar']
  - server/src/models/CalendarEvent.js
  - server/src/models/CustomCalendar.js
  - server/src/models/ECard.js             # scheduled occasion e-cards (plaintext exception)
  - server/src/routes/ecards.js            # e-card CRUD
  - server/src/services/ecardTemplates.js  # e-card style gallery + card HTML renderer
  - mobile/src/lib/ecardTemplates.ts       # mirrored gallery metadata (picker + preview)
  - server/src/routes/calendars.js        # custom calendars + calendar keys + invitations
  - server/src/routes/records.js          # the store events are actually persisted in
  - server/src/routes/calendarChat.js     # the calendar assistant
  - shared/calendar/                       # recurrence expansion (shared engine)
tests:
  - server/src/test/customCalendars.integration.test.js
  - server/src/test/calendarKeys.integration.test.js
  - server/src/test/invitations.integration.test.js
  - shared/calendar/index.test.js
  - server/src/test/ecards.integration.test.js
  - server/src/services/ecardTemplates.test.js
  - mobile/src/lib/__tests__/{calendarData,calendarFeeds,calendarPrefs,calendarWindow,monthGrid,holidays,homeRegion,weatherSource,recurrence,tz,printCalendar,addons,occasions,recordStore,eventWhen}.test.ts
  - mobile/src/screens/calendar/__tests__/CalendarsScreen.test.tsx
  - mobile/src/screens/calendar/dayview/__tests__/dayViewLayout.test.ts
  - mobile/src/screens/viewer/__tests__/ViewerMonthGrid.monthRule.test.tsx
---

# Calendar & events

## Purpose

The calendar is Calen's home surface: a household's events across built-in and
user-defined calendars, with recurrence, reminders, travel time, invitees
(including people outside the household), holidays, an optional weather overlay,
and printing. It is also the anchor for the calendar AI assistant.

## Behavior (normative)

### Events

- An event MUST belong to a `calendarType`: a built-in calendar (`activities`,
  `appointments`) or a user-defined calendar (`custom-<slug>`). The mobile "Add
  calendar" flow mints `custom-<slug>` ids on-device.
- An event carries a `title`, optional `description`/`location`/`url`/`phone`, a
  `startDate`, optional `endDate`, and an `allDay` flag (default true). The
  business `phone` (which Calen dials for cancel/reschedule) is entered on the
  location screen via the shared `PhoneField` and stored as canonical E.164.
- **Title capitalization:** the event form's Title field (create *and* edit)
  declares `autoCapitalize="sentences"` explicitly, so the keyboard opens shifted
  and the first letter of a typed title is capitalized without reaching for
  shift. It must stay explicit — RN's documented `sentences` default is not what
  the native field ends up with here.
- **Discard-changes guard:** leaving a form with unsaved edits — via the header
  ✕, the back chevron, the swipe-back gesture, or Android hardware back — first
  shows the Apple-style "Discard Changes?" action sheet; the exit only proceeds
  on **Discard Changes**. A form is "dirty" when it differs from the baseline
  captured once it initialized (a create's empty defaults; an edit's loaded
  record), or when a new event has queued invitees or attachments. A successful
  save/delete/leave exits without the prompt. Read-only guest/collaborator views
  never prompt (nothing to save). Implemented via the shared
  `useUnsavedChangesGuard` hook and applied across every edit form — here the
  event form, Invitees, Location, Add/Subscribe Calendar, Occasion Alerts, and
  E-Card screens, and app-wide on the People, Account, Chore, Task, Item, Trip,
  Trip Item, and Recipe forms (see [mobile/CLAUDE.md](../../mobile/CLAUDE.md)).
- **Starts / Ends editing:** the shared date/time picker (`DateField`/`TimeField`)
  accepts the value the wheel is currently on when the sheet is **dismissed** —
  tapping the backdrop, dragging the sheet down by its grabber, or the Done
  button all commit it; there is no discard-on-tap-away. The end is **never**
  left before the start: the two endpoints keep their gap by dragging the
  *other* one, whichever the user edits.
  - Editing the **start** (time *or* date) to at/after the end **pushes the end
    forward** by the same amount so the duration is preserved (10–11am → start
    2pm becomes 2–3pm; if the pushed end crosses midnight its **date** rolls to
    the next day, and it folds back to a same-day end when it lands on the
    start's own day).
  - Editing the **end** (time *or* date) to at/before the start **drags the
    start back** by the same amount (8–9am → end 4am becomes 3–4am; if the
    shifted start crosses back over midnight its date rolls to the previous day).

  Both directions share `lib/datetime.ts` (`endKeepingDuration` /
  `startKeepingDuration`), which every Starts/Ends form in the app reuses, so the
  end can never sit before the start regardless of which field is touched.
- **Starts / Ends storage — timezone rule.** How an endpoint is stored decides
  how it must be read back, and the two are **not** the same for the two kinds of
  event:
  - An **all-day** event stores each endpoint at **noon UTC**
    (`YYYY-MM-DDT12:00:00.000Z`). Its calendar date is deliberately
    timezone-stable, so it MUST be read back in **UTC**.
  - A **timed** event stores real instants (the local wall clock converted to
    UTC). Its date and its clock time MUST **both** be read back in the device's
    **local** zone.

  Reading a timed event's clock locally but taking its date off the ISO string
  (which is UTC) is the failure mode: west of UTC a late-evening event is already
  the next UTC day (Aug 3 11:05pm EDT = Aug 4 03:05Z), so the form would open on
  Aug 4 at 11:05pm, save *that*, and step one further day forward on every
  subsequent edit — the same drift the End Repeat (`until`) rule below guards
  against. The conversion therefore lives in one place, as the exact-inverse pair
  `eventWhenFromStored` / `eventStoredFromWhen` in `lib/calendar.ts`, which the
  event form uses in both directions; a load → save round-trip is a **fixed
  point**, and the unit tests assert that over repeated cycles.

  The form's **End date** stays unset whenever the end lands on the start's own
  local day — it means "same day", and it is what the drag helpers above assume.
  A timed event whose end genuinely crosses local midnight (11:05pm–12:05am)
  *does* carry an End date of the next day and *does* legitimately appear on both
  days in the calendar grid.
- **Recurrence** supports `daily` / `weekly` / `monthly` / `yearly` with an
  `interval`, optional `until`, and pattern refinements: weekly `daysOfWeek`,
  monthly `daysOfMonth` or `weekOfMonth`+`weekdayKind` ("on the last Friday"),
  and yearly `months`. Occurrence expansion is done by the shared engine
  (`shared/calendar/`), so mobile and any other consumer agree. The **End Repeat**
  date (`until`) is the last *local* day the event repeats: it is stored as the
  end of that day in the user's timezone (`…T23:59:59` local → the UTC instant),
  so the last occurrence is included. Because that instant can fall on the next
  UTC calendar date, the edit form must recover the **local** Y-M-D when it loads
  `until` (via `ymd(new Date(until))`), not slice the ISO string's UTC date —
  slicing drifts the shown End Repeat one day forward on every edit. The event
  **detail view** renders the recurrence as a summary line under the date/time
  ("Repeats weekly", "Repeats every 2 weeks on Monday"), with `… until <date>`
  appended when an End Repeat is set — accent-coloured, mirroring the form's
  Repeat / End Repeat rows.
- **Deleting a recurring event** (from the detail view's Delete Event control or
  the edit form's Delete) is an **Apple-style two-way choice** — a native alert
  ("This is a repeating event.") offering **Delete This Event Only** and **Delete
  All Future Events** (a one-off event keeps the plain single-button confirm). The
  occurrence the choice acts on is the calendar day the user opened the event from
  (the screens' `date` route param; absent — e.g. from search — it falls back to
  the series start). *This Event Only* adds that day (`YYYY-MM-DD`) to the event's
  **`exceptionDates`** list, which the shared engine skips on expansion (Apple's
  EXDATE); the day key matches the calendar's per-cell bucketing (all-day = UTC
  date, timed = local date). *All Future Events* ends the series the day before the
  occurrence by setting `recurrence.until` (past occurrences stay), or **deletes
  the whole event** when the occurrence is the series' first (nothing precedes it).
  The server can't edit sealed content, so both re-seal the whole event through the
  store (`lib/eventDelete.ts` builds the prompt; `calendarApi.excludeOccurrence` /
  `truncateSeries` re-seal). Both seal under the HDK — a recurring event on an
  outside-shared calendar isn't handled by this path yet.
- **Reminders/alerts:** up to two alerts per event (`reminderMinutes`/`At`,
  `alert2Minutes`/`At`), delivered as on-device local notifications. In a shared
  household, `alertAudience` targets `everyone` or just the `owner` (creator).
  See [notifications.md](notifications.md). The event detail view renders **both**
  alerts when set — an "Alert" row plus a "Second alert" row (the latter only when
  `alert2Minutes` is set) **grouped in one hairline-divided card** (Apple
  Calendar-style), matching the form's Alert / Second Alert fields. The two
  alerts must be **distinct**: each picker excludes the value already chosen in the
  other slot (`excludeUsedAlert`), so the same lead time can't be set twice (which
  would fire two identical notifications). The "None" and "Custom…" rows are never
  filtered out.
- **Travel time** (`travelMinutes`, `travelDistanceKm`) may be attached so an
  event's reminder accounts for getting there. On a **new** event, travel time is
  irrelevant until a destination exists, so it defaults **on** only **once the
  event location (the destination) is set** — and then with the origin seeded from
  the user's **current location**, but only when they've **already shared**
  location with the app. The default never prompts for the permission and takes no
  GPS fix until a destination exists (`resolveCurrentAddressIfShared` in
  `lib/currentLocation.ts`, which reads the granted status without requesting it).
  It applies once, so it never overrides the user turning travel back off. With no
  destination, or no shared location, the default is **off**. Editing an existing event
  **never changes its travel time automatically** — neither the auto-on default
  nor the drive-time recompute fires. Merely opening the event (which seeds the
  saved destination) must not rewrite its saved minutes; the drive time
  recomputes only when the user actually edits the destination or the starting
  point. Travel time is anchored to the destination, so **clearing the event
  location switches travel time off** (and drops any saved/computed drive time) —
  on both the add and edit forms. This only ever turns travel off, so it never
  fights the user re-enabling it once a location is set again. On the event form the
  Travel Time row reads the drive time (with "Leave by…") once computed; **"On"**
  while enabled but not yet computed (e.g. a new event before its location is
  set); **"None"** when off. The Travel Time
  sub-screen sets a **starting location** (origin) that the drive time is computed
  from. The origin field is pre-filled from the event's current origin (the
  default above, or whatever was last set), but is a plain
  editable address (generic "Starting address" placeholder — never labelled as
  the home field). Two one-tap shortcuts sit under it while a manual duration is
  **not** set (a manual duration ignores the origin): **Current location** — the
  opt-in device-GPS reverse-geocode path shared with the Account home-address
  field (`lib/currentLocation.ts`; same denied/unavailable/not-found fallbacks) —
  and **Home** (shown only when a home address exists and differs from the current
  origin). The event **detail view** shows a **Travel Time** row whenever a drive
  time (or manual duration) is saved — the duration as the value, with a "Leave
  by <clock time>" subtitle (start − drive time) on a timed event whose departure
  falls on the same day.
- **The Location view has one input model at a time** (Apple Calendar-style),
  not a search field competing with an always-visible Name/Address/Phone form.
  Three states:
  - **Empty** — a single Google-Places search field ("Search for a business or
    address") with a quiet accent-tinted **"Enter an address manually"** link
    below it (the escape hatch).
  - **Picked** — selecting a suggestion collapses the search into a read-only
    **place card**: a static map at the top, then the place **name** and its
    **address on a separate line with the name stripped** (Google prefixes an
    establishment's `description`/`formatted_address` with its own name, so the
    address line would otherwise repeat the title). An **✕** clears the selection
    and returns to Empty. With no name (a bare address) the address is the title
    and there is no second line.
  - **Manual** — the **Name** and **Address** fields for a place Google can't
    find, reached via the escape hatch, with a **"Search for a place instead"**
    link back to Empty. A location already on the event but with **no place_id**
    (typed by hand / legacy) opens straight into Manual so its value is visible.
  The **business phone** is a first-class **editable** `PhoneField` shown in
  **all three** states (it's the number Calen dials for Call to Cancel, and is
  often the very reason the user is on this screen), followed by the hint that
  Calen uses it to call the business. Saving still stores the single
  `location` string (`locationString()` — "Name, address", de-duplicated),
  `placeId`, and `phone`; the state machine is presentation only.
- **Cancellation via AI call:** when Calen's cancellation call gets a business to
  confirm, the user resolves the outcome **from the event view itself** — the
  event stays on the calendar (faded/struck) until they **delete** it. The event
  view surfaces the conclusion in context (the business called + the call
  summary). The Event Action screen's **"Share my contact details if asked"**
  switch (default off) controls whether the AI caller may give the user's
  phone/email for identity checks. See [ai-assistant.md](ai-assistant.md).
  When the event has **no business number yet**, the Reschedule/Cancel card routes
  to the event's **Location view** to add one (via the `promptPhone` route param).
  Because the user was sent there to enable calling, that view surfaces a
  **prominent callout banner at the top** — a tinted box (the app's banner
  convention, cf. `CreditsBanner`: `accent+'1A'` fill, `accent+'55'` border, a
  filled phone-icon disc, bold text) reading **"Add a business phone number to
  activate calling."** — **not** a muted hint (which blended into the page). The
  banner is tinted with the **event's own calendar colour** (the calendar whose
  Reschedule/Cancel card sent the user here), not the app primary — falling back to
  primary until the event decrypts. The phone field is also **highlighted**. Both
  clear once a number is typed.
- **Recurring events call per occurrence.** The Cancel/Reschedule card is shown on
  recurring events too (not just one-offs). Because a recurring event is a single
  record whose occurrences share one id, a call placed from a recurring occurrence
  is **scoped to that instance**: the call carries the tapped occurrence's local
  Y-M-D (`PhoneCall.occurrenceDate`) and its own start instant (the tapped day +
  the series' time of day), so Calen tells the business the correct specific date
  and the confirmed outcome dims/strikes **only that occurrence**, not the whole
  series (see *Resolved events are dimmed* below). A call with no `occurrenceDate`
  (a non-recurring event, or a legacy row) stays **unscoped** — it matches the
  event on every day it renders (preserving multi-day-span behavior). The
  series-wide **"Mark appointment as cancelled"** fallback (couldn't-confirm path,
  which sets a whole-event flag) is **hidden on recurring occurrences** — deleting
  that single occurrence is the path there instead.
- **Do-not-call is surfaced on both call screens.** If a business asked (on a
  prior call) not to receive automated calls, Calen refuses to dial it. The user
  learns this without hitting a dead end: the **Event Action** screen pre-checks
  the event's number and, when it's suppressed, **disables the "Call to
  Cancel/Reschedule" button** with a one-line reason; the **Interaction** (call
  outcome) view of the call where the opt-out happened shows an explicit
  "asked not to be called again" notice (the per-call `dncCaptured` flag), so the
  suppression isn't left implicit in the free-text summary. See the do-not-call
  section of [ai-assistant.md](ai-assistant.md).
- **Resolved events are dimmed on every calendar surface** (month grid, agenda,
  day view): a **confirmed-cancelled** event renders faded with a strike-through
  title; an event with a **confirmed reschedule not yet applied** to its time
  renders faded (no strike) as a "still at the old time, needs updating" cue. Both
  signals are **derived from the household's recent calls** (the server can't set
  a flag under E2EE), not stored on the event, and both **clear when the call
  notice is acknowledged** — Dismiss on the event view or OK in Invitations
  (one shared `acknowledged` flag) — returning the event to a normal appearance.
  A **hand-set** `cancelled` flag (from the "couldn't confirm → mark cancelled"
  path) persists until the event is deleted; `cancelled` is sealed event
  content, so both mark-cancelled surfaces (event detail + call Interaction)
  set it by **re-sealing the event client-side** via `calendarApi.cancelEvent`
  (HDK lane, like `excludeOccurrence`), never a plaintext field update. The derivation is **occurrence-aware**
  (`lib/callStatus` `buildEventStatus`): a call carrying an `occurrenceDate` dims
  only the matching day, an unscoped call dims the event on every day it renders,
  and each surface passes the date of the occurrence it's drawing — so a confirmed
  cancel of one occurrence of a recurring series never strikes the other
  occurrences.
- **Detail view reflects every configured field.** The guiding principle: whatever
  the edit form lets the user set MUST be visible on the read-only detail view.
  Title, location, calendar, invitees, alerts, URL, attachments, and notes render
  as before; recurrence and travel time render as described above. The detail
  view **re-pulls the event whenever it regains focus** (e.g. returning from the
  edit form), so an edit that changes what's rendered here is reflected without a
  manual refresh. The **"Reschedule/Cancel" card** renders as the **first row of
  the details group, directly above the Calendar card** (not down among the
  alert/travel rows), on both one-off and recurring events (recurring calls are
  scoped to the tapped occurrence — see *Recurring events call per occurrence*
  above). The call-placement screen shows the flat call price as a quiet
  caption above the call CTA ("~N credits/min from your AI credits, billed by
  the second", from `billing/status.actionCosts.callPerMinute`; hidden when
  unknown) — the pre-call cost transparency rule is normative in
  [billing-plans](billing-plans.md). A **timed**
  event additionally shows an **Apple-style mini timeline card** under the
  date/time block: a compact hour-grid (gutter hour labels around the event) with
  the event drawn as an accent-tinted block — solid accent left bar, accent-colour
  text — positioned by its clock time. The block's **content adapts to its height**
  (a short event has no room for every line): an event **longer than an hour**
  shows title + location + start–end time; an event of **exactly an hour** drops
  the location (title + time); an event **shorter than an hour** shows the title
  only. The card is a **compact, fixed-size window** (~3 hours, opening roughly an hour
  before the event) so it never grows into a wall of hours: an event longer than
  the window has its block **clipped at the card's bottom edge** (running off to
  signal it continues), while the block's start–end text still names the true end
  time. A multi-day timed event is clamped to its first day (midnight). All-day events omit the card (they have
  no clock position). The card carries no map imagery — the location map closes
  the page (below).
- **Detail-screen close (Apple-style).** The **"Delete Event"** control is a
  translucent floating pill (dark scrim, danger-red label) **pinned to the bottom
  of the screen** — it is a sibling of the scroll view (not a child), so it stays
  **fixed in place while the event content scrolls beneath it**, rather than
  scrolling away attached to the map. It sits above the bottom safe-area inset and
  is always present. The scroll content reserves bottom padding so its last
  element clears the pill. The location map (static map + street-view thumbnail),
  when the event has a location whose imagery loads, closes the scroll content
  (Apple-style); with no location — or if the map tiles fail to load — the map is
  simply omitted (the pill still floats fixed).
- **Attachments** (photos / PDFs, `EventAttachment`, ≤25 MB). Files are **always
  sealed on-device before upload** — a fresh per-file key, ciphertext uploaded as
  an opaque part, no plaintext lane (see [Encryption boundary](#encryption-boundary)
  + crypto-e2ee.md). Because iOS relabels a `.bin` ciphertext part's content-type
  (e.g. `application/macbinary`), the server accepts the whole opaque-binary family,
  not just `application/octet-stream` (the real type rides in the body's
  `fileType`). Picks staged on a **new** event upload after the save creates it;
  a failed upload is surfaced (which files, not silently dropped). On the **event
  view**, tapping an attachment card downloads + decrypts it on-device and then
  **previews it in-app**: images and PDFs render inline in a WebView
  (`AttachmentPreview` screen — a WebView, not RN's `<Image>`, which crashes on the
  new architecture), with a **Share** button in the header that hands the file to
  the OS sheet (Open in… / Save to Files). Any non-previewable type skips straight
  to the OS share sheet.

### Views (month display density)

The calendar home is a **single month surface** rendered at one of four
densities, chosen from a view switcher — the left-most of the three floating
buttons in the top-right cluster (search + add are the other two). The switcher
button's glyph reflects the active mode; tapping it opens an **anchored dropdown
popover** (not a bottom sheet — this is the one deliberate exception to the
bottom-sheet picker convention, to mirror Apple Calendar) listing the modes with
a checkmark on the active one and a divider isolating **List**. The choice is
**persisted device-local** (`hc_month_density`, `lib/calendarPrefs` →
`useMonthDensity`); default is **Details**.

- **Compact** — a uniform short row per week; each day shows the day number and a
  row of up to four coloured **dots** (one per source: each spanning span
  covering the day, each single-day event, and one per maintenance/chore/meal
  group). No text, no bars. The whole month fits with room to spare.
- **Stacked** — each single-day item renders as a thin **coloured bar** (no
  text); multi-day events and trips render as the overlaid spanning bars.
  Week-row height grows with the busiest day.
- **Details** — the full month grid: event **chips** (title + start time),
  labelled spanning bars, and the maintenance/chore/meal/grocery icon row. This
  is the pre-switcher behavior.
- **List** — a compact single-month grid (dots per day, like Compact) with the
  **tapped day's events listed below** (as compact cards). Only the visible
  month's days are shown (leading/trailing days of adjacent months are blanked).
  The grid is an **interactive vertical carousel**: dragging scrolls continuously
  into the adjacent month (up reveals the start of the next month, down the end of
  the previous), and on release it **snaps to a full month** — past a distance/
  velocity threshold it commits to the adjacent month, otherwise it springs back.
  Tapping a day fills the list. The **month label above the grid is the same
  month/year jump-sheet button** as the grid family's sticky header (shared
  `MonthJumpHeaderButton`, see the unbounded-window section): a pick teleports
  the carousel straight to that month (re-cursors it — no window mechanics),
  and the tapped-day selection stays put, exactly as when swiping between
  months. Switching layers preserves the **viewed month** in both directions
  (see the crossfade note below): entering List adopts the month the grid was
  showing — with today selected and circled in the primary colour when that
  month is today's, otherwise the month's **1st** selected so the day list
  reflects the visible month. This mode **replaced the former standalone
  "events" agenda view** (a full-screen infinite agenda toggled by a list button),
  which has been removed.

The grid family lays its weeks out as **month blocks** (`lib/monthGrid.ts`):
each month renders its own Sunday-first grid and blanks the neighbouring
month's days, so a boundary week is rendered once per month and real whitespace
separates one month from the next (the Apple Calendar layout). The **1st**
carries the abbreviated month name in the app **primary**, on a reserved line
above the day numbers. The rule that opens a month's first row is the **same
hairline in `colors.border` as every other week rule** — not a tinted or heavier
line — and it is drawn **per day cell, only over the days the month owns**: the
blank cells leading into the 1st get no rule, so the line starts at the 1st
instead of hanging over the whitespace. This holds at every density in the
family (Compact, Stacked, Details) and in free viewer mode's `ViewerMonthGrid`,
which carries the identical layout.

Spanning bars and the weather lane **clip at the month boundary**: lanes are
assigned across the whole week (so the two copies of a boundary week agree on
lane order), then clipped to the block's own columns, so a trip crossing the
boundary draws as two clipped bars rather than one bar over blank cells. Month
blocks are also what the sticky header, the month/year jump, and the today
anchor key off — a row *belongs* to a month, so the label is exact rather than
inferred from the week's Wednesday, a jump lands on the block's first row, and
today's row is the one where today is the block's own day.

**Switching density is a layout change, never a rebuild.** The three grid
densities share **one cached row core** per week — the cells' content and the
week's spanning bars, identical in all three and the expensive half to build
(the bar pass scans every event and trip, per row). Density is therefore *not*
part of the row cache's validity signature; it is part of the cache **key**
(`<density>:<week>`), and the only work a switch does is
`lib/monthGrid.weekLayout` — pure arithmetic turning the core's per-column
measurements into a row height, a header height, and whether the weather lane
shows (Compact hides it, as it hides every span). So picking
Compact/Stacked/Details re-expands nothing and re-scans nothing, and switching
back to a density already seen is a straight cache hit; both caches flush
together when the underlying data changes. The switch is deferred a frame
(`requestAnimationFrame`) so the switcher popover's dismissal paints before the
layer re-renders — the same rule the month/year jump sheet follows, and the
reason the menu no longer hangs on the way out.

#### The unbounded month window

The grid family (Compact/Stacked/Details) scrolls an **unbounded month
window** — there is no fixed range and no hard stop in either direction:

- The window opens small — last month through three months ahead
  (`lib/calendarWindow.initialWindow`) — and **only ever grows**. Scrolling
  near the top or bottom edge of the built grid extends that edge by six
  months (`EXTEND_MONTHS`), one extension per edge at a time (the guard
  resets only when the edge actually moves). Upward growth is anchored by
  `maintainVisibleContentPosition` so prepended weeks extend the content
  above the viewport without a visible jump — the same mechanism as the
  day-view List agenda's earlier-loading.
- **The past edge never grows while the today pin still owns the scroll
  position.** A prepend is compensated twice — once by
  `maintainVisibleContentPosition`, once by the pin re-snapping to today's new
  offset on `onContentSizeChange` — and the two together can walk the viewport
  back into the freshly prepended rows, which satisfies the threshold again and
  prepends once more. That runaway swept the header month (and the jump sheet's
  highlight, which reads the same row) backwards through the calendar. The past
  edge therefore grows only once the user has taken the grid somewhere
  themselves; a drag or a month jump releases the pin. For the same reason the
  pin does **not** scroll when today falls outside the window — offset 0 is the
  past edge, and snapping there re-triggers the extension on every re-measure.
- **The row under the sticky header is tracked by row key, not index.** A
  past-edge extension prepends rows and shifts every index at once, so an index
  alone silently renames the month under the header. A key names the same row
  before and after a prepend.
- The sticky **"Month Year" header label is a button** (chevron-down
  affordance): tapping it opens the **month/year jump sheet**
  (`MonthJumpSheet` — a bottom sheet with a ‹ year › stepper over a 3×4
  month grid; the currently visible month carries the filled primary disc,
  today's month the primary-tinted label, and the year is unbounded both
  ways). Picking a month grows the window to cover it (`ensureCovers`, one
  month of margin) and snaps **without animation** — a teleport, not a
  scroll — to the **first row of that month's block**, updating the sticky
  label immediately. The label-button + sheet pair
  is the shared `MonthJumpHeaderButton` (exported from `MonthJumpSheet`),
  which also heads the **List layer** — there a pick just re-cursors the
  month carousel. The button owns the sheet's open state (outside the heavy
  calendar layer) and defers the pick's jump by a frame, so the sheet opens
  and dismisses instantly rather than waiting on the layer's re-render.
- The window math and the chunk merge are pure and unit-tested in
  `lib/calendarWindow.ts`. The former fixed 12-month window (2 past +
  current + 9 future, inherited from the web's initView) is retired.

Compact/Stacked/Details share one scrolling grid layer (the month blocks above);
List is a separate layer. The switcher crossfades between the grid family and List; the
shared floating chrome never moves. The two layers share one **viewed month**:
each reports the month it is showing into the host (a ref — scroll-frequency
writes, no host re-render) and adopts it when it becomes the active layer, so
switching views never loses the month the user had navigated to (grid→List
re-cursors the List carousel; List→grid teleports the grid, a no-op when it is
already showing that month). The chrome is arranged by priority:

- **Top-left** — the profile avatar (conventional account corner). It is the
  badge anchor for everything that resolves inside Profile, with a precedence
  rule — security beats inbox: the red **"!"** when encrypted data is locked on
  this device, otherwise the **pending Invitations count** (9+ cap); never
  both. The Invitations inbox itself has **no calendar-chrome button** — it is
  event-driven, not frequency-driven, so it lives as a badged row in Profile
  and the badge trail cascades: avatar count → Profile's Invitations row
  (same count, `hooks/useInvitationsCount` — the "New"-tab counting rules) →
  the inbox. The inbox **presents as a push** (back chevron), like every other
  Profile drill-in — Household, Contacts, Account. (It presented modally until
  2026-08-02.)
- **Top-right** — the utility pill: view switcher, search, add.
- **Bottom-left** — a labelled **Today | Calendars** pill (hairline divider
  between). Both are text labels: Calendars is a primary destination, and a
  calendar glyph inside a calendar app is ambiguous.
- **Bottom-right** — the standalone **Calen FAB**: the gradient "C" glyph on a
  56pt surface disc, larger and one shadow step above the pills, alone in the
  prime thumb corner. It is the screen's single visually-dominant primary
  action; shown only while AI is enabled. (When the calendar was pushed by an
  assistant nav chip, this slot shows the "‹ Calen" return pill instead — see
  [ai-assistant.md](ai-assistant.md).)

The single **Today** button re-centres whichever layer is active.

### Loading (cache-first, stale-while-revalidate)

**Expanded-instance date shapes (consumer contract).** The engine's expanded
tasks/chores do **not** carry a single `nextDueDate` type:
`expandRecurringTaskChore` passes a **one-time** item's value through as the
record's ISO *string*, while every instance it generates for a `calendar` or
`interval` recurrence carries a **`Date` object**. Consumers must normalize
(`new Date(...)`, or a shape-tolerant helper) — never assume the string form.
Assuming it is what broke on-device reminders entirely; see
[notifications.md](notifications.md). Expanded *events* are unambiguous by
comparison: `expandRecurringEvent` always sets `startDate` to a `Date`.

`loadCalendarData` takes a `sync` mode. **`inline`** (the default) awaits the
server pull before assembling — the shape for one-shot consumers that must see
fresh truth (Print, the reminder scheduler, the assistant's sources); its
records pull and settings fetch run **in parallel**, not sequentially.
**`background`** — passed by every interactive calendar view (month grid, List
layer, day timeline/agenda, search) — assembles **immediately from the local
replica** and kicks off `revalidateCalendar()` behind the paint, so a warm
launch shows the calendar without waiting on the network.

- `revalidateCalendar()` pulls the records feed, the grocery settings, and the
  trips collection concurrently, then invalidates the `['calendar']` queries
  **only when something actually changed** (records upserted/removed, grocery
  config differing from its cache, or the trips (_id, updatedAt) set moving) —
  an unchanged pass ends quietly, which is what keeps the
  invalidate → refetch → revalidate cycle from spinning. Passes are deduped
  (concurrent callers share one in-flight pull) and floored at 10s apart.
- The trips pull **reconciles the replica bucket** (server-deleted trips are
  removed, not just left to age) since the background path reads trips from the
  replica alone.
- The grocery config (`groceryShoppingDay`/`groceryFrequency`/`groceryAnchor`)
  is cached device-local (`hc_grocery_settings`) so the background path — and
  inline loads that fail offline — render the real shopping-day markers instead
  of resetting to defaults.
- A device that has **never completed a sync pass** (fresh install, or the
  post-unlock/account-switch cursor reset — `hasSyncedRecords()`) has an empty
  replica, so `background` falls back to `inline` rather than flash an empty
  calendar.
- **The month grid splits the load in two**, which is what makes its unbounded
  window cheap: one **range-independent sources query**
  (`loadCalendarWindowSources`, `['calendar','sources']` — the replica read
  plus the custom-calendar access set, the owned add-on set, and the parsed
  ICS feed masters (`calendarFeeds.loadFeedSources`); the replica holds
  everything, so sources never depended on the range) feeding a
  **synchronous per-month expansion** (`expandCalendarRange` — the shared
  engine plus the chokepoint filters: custom-calendar access, add-on locks,
  ICS feed injection via the pure `expandFeedSources`). Expansion is
  **derived data, computed at render and memoized per month** — never
  fetched through async query state. The consequences are the contract:
  extending the window expands only the added months (cache hits for the
  rest, sources never re-read for a bigger range), and a data change (e.g.
  **saving an event**) refetches the sources and repaints in **one pass with
  one re-render** — the previous frame stays up until the recompute lands,
  so the edit simply appears in its cells with **no whole-grid reload, no
  per-month churn, and no skeleton flash**. The per-month results merge
  through `lib/calendarWindow.mergeCalendarChunks` (identity dedup — a span
  crossing a month boundary appears once, a recurring occurrence keys by
  `_id:startDate`). Every other consumer still calls `loadCalendarData`, now
  a thin composition of the two halves, so the chokepoint filters stay
  enforced in one place. The grid's week builder also **buckets items by
  date once per rebuild** (cells do O(1) lookups), keeping rebuild cost
  linear in days as the window grows.
- **The embedded snapshots refetch themselves.** Because the sources query
  EMBEDS the custom-calendar access set and the owned add-on set, hooks
  re-rendering against a changed store cannot fix a stale expansion — the
  filters run from the snapshot. So the two stores invalidate the
  `['calendar']` and `['viewer']` query trees when their contents actually
  change: `commitCustom` on a real list change (a sources fetch that raced
  ahead of the session's `refreshCustomCalendars` dropped EVERY custom
  calendar's events until an unrelated invalidation), and `cacheOwnedAddons`
  on a changed owned set (billing-plans.md). Steady-state echoes (identical
  list/set) MUST stay quiet so invalidate → refetch → re-mirror can't cycle.
- **A record write invalidates the calendar — at the CRUD chokepoint, not per
  screen.** The calendar assembles from the **replica**, and `lib/recordStore`
  mirrors every create/update/delete into it before returning, so the edit is
  already the on-device truth the moment a form saves; the only thing left
  stale is the cached `['calendar']` query data (30s `staleTime`, no
  refetch-on-focus, and the grid is a mounted tab — nothing re-runs on its
  own). So `recordStore` itself invalidates `['calendar']` after mirroring a
  write to a collection the engine expands (`CalendarEvent`, `MaintenanceTask`,
  `Chore`, `Person`, `RecipeSchedule`), coalescing bursts (a bulk contact
  import writes one record per contact) into a single invalidation. An editor
  MUST NOT have to remember this: **editing a contact's occasion dates**
  repainted the Occasions list (it reads `['people']`) while the month grid
  kept the pre-edit dates until the next sync pass, because the person form
  invalidated only `['people']`.
- **Holidays never wait for sync.** Month-grid holiday chips are computed
  on-device from prefs and MUST render as soon as the grid mounts, independent
  of the network-backed data query (the List layer and day views already did).
- **Skeleton, not a spinner.** During the first-ever load (the inline-fallback
  case above — the only time there is no replica to paint) the month grid shows
  shimmering per-cell placeholders shaped per density (chip-, bar-, or
  dot-shaped; deterministic per date, some cells left empty like a real month)
  instead of a floating `ActivityIndicator`; the List layer's day list shows
  `SkeletonList` rows instead of a premature "Nothing scheduled.".

### Day view (tap a day)

Tapping a month-grid day opens the **day view** (`CalendarDay` route — the
param only seeds the surface; all browsing after that is in-place state, not
navigation). It mirrors Apple Calendar's day surface: **three modes** behind
the day view's own switcher (the same anchored-dropdown convention as the
month switcher — button glyph reflects the active mode, checkmark on the
active row, **List** isolated below a divider). The choice is persisted
device-local (`hc_day_view_mode`, `lib/calendarPrefs` → `useDayViewMode`);
default **Single Day**.

**Shared chrome.** The native header is off; the view draws its own floating
pills over whichever mode is active: top-left a **back pill** labelled with
the anchor's month ("‹ July") returning to the month view; top-right the
switcher/search/add pill; bottom-left **Today** (re-anchors to today and
re-centres the active mode); bottom-right month-jump (calendar glyph →
month view). The Invitations inbox has no button here either (it lives in
Profile, badged via the month view's avatar). The native back-swipe stays
disabled: horizontal swipes page between days.

- **Single Day / Multi Day (the timeline modes)** are one hour-grid surface
  differing only in visible-day count (Multi Day is **fixed at two columns**):
  - A **week strip** (weekday letters + paging date numbers) sits above the
    grid. Today is marked in the **app primary colour** (never Apple's red):
    a primary-tinted number, becoming a **filled primary circle** when it's
    the anchor; a non-today anchor gets a **white circle**; in Multi Day a
    **grey pill spans the visible pair** (clipped at Saturday — the spillover
    Sunday shows on the next page). Tapping a number re-anchors in place;
    paging the strip keeps the weekday and moves the week; day-swipes that
    cross a week edge page the strip to follow.
  - The **hour grid** is a fixed 24h canvas (1 px/min), gutter labels
    `12 AM … Noon … 11 PM`. Timed events render as blocks — translucent
    calendar-colour fill, solid colour bar on the left edge, title in the
    calendar colour — **clipped to each day column** (a midnight-spanning
    event yields one clipped segment per column). Overlapping blocks
    **lane-pack** (first-fit within each overlap cluster, equal widths). A
    *timed* event covering the entire day demotes to the all-day lane.
  - The **all-day lane** (hidden when every visible day is empty) holds
    all-day events, trips, holidays, birthdays, meals, the grocery marker —
    and **date-only tasks/chores**: they have no time of day, so the view
    never invents a slot for them. Chips are badged with a leading
    MaterialCommunityIcons glyph tinted in the item's colour: **events** a
    generic calendar glyph, **occasions** their kind icon (`occasionIcon` —
    cake, heart, ring…), **chores** the chore's own icon. Date-only **tasks**
    render as muted empty-circle chips (not a colour-badged item). Capped at
    three rows per day with "+N more" expanding.
  - The **now indicator** renders only when today is visible, in the app
    primary colour: a line with a dot across today's column (dimmer across
    the rest of the row), plus a time badge in the gutter, ticking on the
    minute in an isolated leaf.
  - The **hourly weather rail**: while the Weather calendar is toggled
    visible (the same gate as the month grid's forecast strip), each day
    column weaves the passive forecast's hourly entries into the time
    canvas — a slim ambient rail down the column's right edge, one condition
    icon + temperature per forecast hour, centred in its hour band.
    Non-interactive and rendered **under** the event blocks (weather is
    context; events own the canvas). Days outside the forecast simply have
    no rail.
  - **Swiping** pages by the visible day count (±1 single, ±2 multi) with the
    directional slide; the vertical scroll offset survives day swipes *and*
    the single↔multi switch (one mounted grid). The initial position is the
    now-line for today, just above the first event otherwise, 8 AM when empty.
- **List** — a continuous agenda of **days with items only** (plus **today**,
  which always gets a section when it falls in the window — even empty — so its
  marker anchors the list; an all-empty window drops it and the EmptyState
  shows): sticky day headers ("Monday – Jul 27") with a passive-weather glance
  (condition icon + high/low) when the Weather calendar is visible and the
  forecast covers the day. **Today's** header is preceded by a **"Today"
  divider marker** (accent lines + label, app primary colour) and its date line
  is tinted primary — the same today-marker idiom as the Occasions view. Rows
  are led by a colour-tinted glyph rather than a bare colour bar: timed +
  all-day **events** a generic calendar glyph, **occasions** their kind icon,
  **chores** the chore's own icon; date-only **tasks** stay **muted
  empty-circle rows**. Timed events show title, location line, and stacked
  start/end times on the right; all-day items are marked "all-day". The window
  **starts at the
  anchor's day** — the anchor is the top of the list, never a scroll target
  into unrendered sections (SectionList can't reliably `scrollToLocation`
  that far), so a new anchor (day swipe, week-strip tap, **Today**) restarts
  the window at that day. Scrolling to the end extends the window forward;
  scrolling back **to the top prepends the previous stretch automatically**
  (infinite scroll up) — the previously-first day is anchored via
  `maintainVisibleContentPosition` so the inserted days grow above the viewport
  without a jump, and a brief spinner shows in the list header while the
  prepend settles (no explicit "Load earlier" button). Leaving List keeps the
  anchor.

Resolved-call dimming (see *Resolved events are dimmed on every calendar
surface*) applies in all three modes. The former day-view **weather card**
(conditions hero + horizontal hourly strip) was removed with this surface —
its hourly forecast now lives *in* the timeline as the weather rail, and the
List headers carry the daily glance; the Weather screen owns the full
forecast. All of it follows the Weather calendar's visibility toggle.

### Custom calendars

- A household may create custom calendars (colour + name); these are managed
  through `server/src/routes/calendars.js` (`/api/calendars`) and the mobile
  Calendars / Add-Calendar / Calendar-Colors screens.
- The **name** is the only typed field on the New Calendar and Subscribe
  screens (sharing, colour and alerts are all tapped), so its keyboard **Done**
  key MUST dismiss the keyboard rather than leave it covering the rows below.
- Custom calendars can be **subscribed** (external ICS feeds) and **holiday**
  calendars added; see the Subscribe/Holiday screens. The Subscribe screen
  offers an optional **provider helper**: a subscribe link can't be derived
  from an email, so entering one detects the provider (Gmail/iCloud/Outlook,
  else a generic guide) and deep-links to that provider's calendar-link
  settings page with copy-paste steps — the user still pastes the resulting
  `webcal`/`https` URL into the link field (guidance, not automation).
- **Holiday calendars know where home is.** Provincial/state holidays are
  opt-in by subdivision (`selectedRegions`), and the home subdivision is
  preselected automatically wherever it can be derived (`lib/homeRegion.ts`:
  the saved home address — decrypted client-side for E2EE households — through
  the keyless geocoders' `regionForAddress`, matched against the country's
  `REGIONS` names):
  - **First run:** a fresh install auto-seeds the device-locale country's
    holiday calendar (the long-standing `pendingLocalHolidayCals` seed in
    `calendarPrefs`, uploaded server-backed by `refreshCustomCalendars`; deduped
    by country against the server list). New since 2026-07: right after that
    seed uploads, the home province/state is preselected on it when the saved
    address makes it derivable — only on the calendar the seed itself minted,
    never on one that came from the server or real legacy data.
  - **Creating one** (Add Calendar → holiday country) seeds `selectedRegions`
    with the detected home region when the picked country matches.
  - **Saving a home address** (Account) auto-selects the detected region on the
    user's own holiday calendars of that country — but only those with **no
    regional picks yet**; an explicit choice is never overridden
    (`autoSelectHolidayRegion`).
- **Holiday alerts are one config for every holiday calendar.** The holidays
  editor carries a **notifications button** in its header (the same alarm bell
  the Occasions view uses, tinted with the calendar's colour) opening **Holiday
  Alerts**: Alert / Second alert (days before, the shared
  `OCCASION_ALERT_OFFSET_OPTIONS` list) + a single **Alert at** time, exactly
  like Occasion Alerts. The settings are **shared by all of the user's holiday
  calendars** — opened from any country's editor, they land on the same
  device-local prefs (`hc_holiday_alert_prefs`) — because someone who wants a
  heads-up before a holiday wants it for every holiday they display. They apply
  to the holidays each calendar actually shows (national + selected regions +
  enabled cultural/religious), and **default to off**: holidays are numerous, so
  they are opt-in rather than something that silently fills the rolling reminder
  window. A holiday calendar's own **Alerts switch** (Edit Calendar) mutes its
  holidays. Alerts fire on-device — see [notifications.md](notifications.md).
  Because the prefs are device-local, a housemate reading a **shared** holiday
  calendar sets their own alerts even though the calendar's contents are the
  owner's to configure.

### Calendars view (the manager)

- **Presentation: a push**, not a modal. The manager is browsable hierarchy —
  it drills into Add Calendar, Edit Calendar, Colours & Order, and Print — so it
  arrives with a back chevron, not a ✕. (It presented modally until 2026-08-02;
  see the presentation rules in [mobile/CLAUDE.md](../../mobile/CLAUDE.md).)
- Calendars group by **audience**, ordered **HOUSEHOLD** (built-ins +
  household-wide customs — the dominant group leads) → **JUST ME** →
  **SHARED**; empty groups are hidden. Every row in SHARED MUST state its
  direction in the subtitle — "Shared by you · N person/people" (member +
  outside shares counted) or "Shared with you" — joined after the kind
  ("Holidays"/"Subscription") when both apply; household-wide calendars carry
  no direction (their group says it).
- **Single-member household:** the Just me / Household split carries no
  information, so unshared custom calendars display under HOUSEHOLD and the
  JUST ME group is absent. The underlying sharing state stays unshared — when
  a second member joins, those calendars move to a now-meaningful JUST ME
  group rather than being silently exposed. While the member count is still
  unknown (first load), the split is kept (the safe reading).
- Rows are **single-purpose**: tapping a row toggles that calendar's
  visibility (Apple-Calendar semantics; the row is `accessibilityRole:
  "switch"` with checked state, and a hidden calendar dims its name). The row's
  **leading control is an Apple-style on/off circle** (replacing the old accent
  bar) carrying the calendar's colour — a filled check-circle when shown, an
  empty outline circle (dimmed) when hidden — so the toggle state and the
  calendar's colour read from one control at the start of the row. Tapping a row
  MUST NOT navigate. The toggle's visual flip on the
  manager screen commits urgently; other mounted consumers of the visibility
  store (e.g. the month grid beneath the modal) re-render in a non-urgent
  transition so their cost never delays the tap feedback.
- Built-in calendars ship with default colours (overridable per device via
  Colours & Order, resettable to these defaults): Activities green `#388E3C`,
  Appointments **blue `#1976D2`** (changed from purple `#7B1FA2` 2026-07-29),
  Occasions pink `#E91E63`, Weather light blue `#0288D1`, Chores orange
  `#F57C00`, Meals teal `#00897B`, Maintenance blue `#1976D2`, Trips deep
  purple `#5E35B1`. Defined once in `lib/calendarPrefs.CALENDARS` (mirrored by
  `lib/calendar.CALENDAR_COLORS`); every default is a `COLOR_PRESETS` swatch.
- Navigation lives in the explicit trailing controls: **every row carries an
  edit (info) button** opening the Edit Calendar form — the one consistent
  path to name/colour/alerts/sharing/delete. Rows with a content view
  additionally show an accent-tinted **"Open" pill** before the edit button:
  feature-backed calendars (Maintenance, Chores, Meals, Trips, Birthdays,
  Weather) open their home screen; holiday calendars open their holidays
  editor (which days show). Feature home and holidays-editor screens carry
  **no header edit pencil** — the row's edit button is the single edit path.
  Their one header action is the **alarm bell** where the calendar has
  calendar-level alerts to configure (Occasions → Occasion Alerts, holidays →
  Holiday Alerts), tinted with that calendar's colour.
- The primary **add action is the header `+`** (app convention), opening the
  Add Calendar chooser (new / subscribe / holiday / restore deleted).
  Secondary actions — Calendar colours & order, Print — are one grouped
  "manage" card at the end of the list. There is no long-press delete;
  built-ins are deleted from Edit Calendar (restore via Add Calendar).
- **Print presents as a modal** (✕, swipe-down): pick a layout and range,
  produce a PDF, dismiss. It is a finish-and-dismiss task rather than a place in
  the calendar hierarchy. The viewer shell's `ViewerPrintScreen` follows the
  same rule.

### Feature-calendar add-ons (locked state)

- Five calendars are add-ons — Meals, Maintenance, Trips (one-time paid) and
  Occasions, Chores (**included free but opt-in** — claimed from the Add-ons
  screen, never default-added; the normative purchase/claim spec is
  [billing-plans.md](billing-plans.md#feature-calendar-add-ons)). Only
  Activities, Appointments, and Weather ship enabled. In the Calendars view,
  **locked** add-on calendars (unbought paid and unclaimed free alike) MUST
  NOT render as rows in the HOUSEHOLD group; they collapse into **one
  storefront row rendered as the HOUSEHOLD group's closing row** (inside the
  group, where those calendars would otherwise sit — contextual, never a
  top-of-screen banner) — storefront icon at full saturation (acquirable, not
  disabled) and a subtitle naming the **full add-on catalog in store order with
  no price** (every add-on calendar, owned or not; the store screen does the
  selling) — which opens the Add-ons store. The storefront row is
  **permanent**: once everything is owned it stays in place as the stable
  store/manage entry point (users keep their learned location, and future
  add-ons surface there without a new affordance appearing), with its subtitle
  switching from the catalog list to the status line **"All add-ons added"**
  (the row must not read as re-selling what's owned). The HOUSEHOLD group
  therefore always renders (it hosts the storefront row), even if every
  household calendar row is deleted or locked. Owned/claimed add-on calendars
  render exactly like other built-ins.
- `loadCalendarData` MUST exclude locked features' items (tasks, trips,
  occasions, chores, meal schedules + grocery-shopping markers) at the same
  chokepoint as custom-calendar access filtering, so the grid, day/agenda/list,
  search, print, reminder scheduling, and assistant reads all agree. Locked
  ids also hide from every calendar-list surface: the Print screen's
  checklist, the **Colours & Order list**, and the Add-Calendar menu's
  **deleted-calendars restore list** (restoring a locked calendar would
  restore it into nothing; the storefront row is its affordance until owned).
- All five add-on feature homes (Kitchen, Maintenance, Trips, Chores,
  Occasions) gate at render: locked → the `AddonLockedView` interstitial
  (free add-ons: the "Add for free" variant; see their specs —
  `OccasionsScreen` is specified here).
- Locking never deletes anything: device prefs (visibility/colour/order/deleted)
  and household data are retained, and purchase/claim restores the prior state.

### Invitees & sharing

- An event may invite **people inside the household** and **people outside it**.
  Outside invitations go through `server/src/routes/invitations.js`. **Outreach
  is device-composed** (2026-07-29 — the server's `event_invitation` email is
  retired; policy in [households-sharing](households-sharing.md)): an invitee
  **with an account** gets a server push (`pushToUser`, best-effort, sealed
  invites push a title-free notice) + the in-app Invitations inbox and NO
  email; an invitee **without an account** gets an email composed from the
  organizer's own mail app (via the mail-app chooser) carrying the event
  snapshot and the public `.ics` link, mirroring the SMS text
  (`lib/invitees.eventInviteEmailContent`; `sendInvitations` decides per
  invitee off `GET /invitations/lookup`, failing open to compose). Pending
  email rows on the Invitees screen carry a Remind action (compose again on
  demand); phone rows keep their resend-text twin.
- `guestListVisible` controls whether cross-household invitees can see who else
  is invited. It is **sealed event content** (inside `enc`, like `cancelled`):
  the event form seals it into every create/edit payload (seeded from the
  invitee draft store), and the Invitees screen's toggle on a saved event
  re-seals the event client-side via `calendarApi.setGuestListVisible` — never
  a plaintext field update, which the opaque store rejects on an E2EE
  household. The server enforces guest-list visibility from the per-invitation
  copy of the flag snapshotted onto each `EventInvitation` at send time — so the
  organizer's device forwards `guestListVisible` on every `invitationsApi.send`
  (`lib/invitees.sendInvitations`, from the invitee draft store), across the
  sealed, plaintext, and SMS lanes. Omitting it defaults to visible.
- Accepting a cross-household invitation creates a **copy** event on the
  accepter's calendar with `invitationId` set; on that copy the client's delete
  action becomes **"Leave event"** (which also retires the invitation).
  Signal-parity C3b: the server can't read the sealed source event, so the
  **recipient's device seals its own copy** — it takes the decrypted invitation
  snapshot, folds `invitationId` inside, seals it under its own HDK
  (`sealNew('CalendarEvent', …)`), and posts the client-minted `_id` + opaque
  `enc` to `POST /invitations/:id/accept`; the server stores it as a Record it
  can't read, in the recipient's household scope. The accept fails with
  "A sealed event copy (_id + enc) is required" if the client posts the bare
  plaintext snapshot instead of the sealed copy, or if the recipient's vault is
  locked (no HDK to seal with) — the Invitations screen surfaces an "unlock your
  vault" message in that case rather than letting the server reject it.
- A **calendar** (not a single event) can be shared with people outside the
  household by email or phone (`PUT /calendars/:id/sharing`); calendar invitations
  are accepted/declined via `/api/calendars/invitations/*`. **Outreach is
  device-composed** — the owner's own mail/Messages app sends the nudge (the
  user's chosen mail app via the shared mail-app chooser, `sms:` for texts —
  mobile `lib/shareInvite` + `components/EmailAppSheet`, chooser behavior
  specced in [households-sharing](households-sharing.md)); the server sends no
  invite email or text, it only creates the `CalendarInvitation` discovery record. An invited
  **existing account** additionally gets a push (`notify.pushToUser`, best-effort)
  and sees the invite in its in-app inbox. Same pattern as
  [households-sharing](households-sharing.md) and [trips](trips.md).
- **The Outside My Household add field autocompletes over the contacts
  roster** (AddCalendarScreen), same behavior as the household invite field:
  the decrypted People records matched by name, email, or phone digits via the
  shared `useRosterSuggestions` hook (behavior specced in
  [households-sharing](households-sharing.md)); placeholder "Add name, email,
  or phone…". Tapping a suggestion **stages** the contact's resolved address
  (primary email, else canonical E.164 phone) in the outside list at View Only
  — unlike the household invite, nothing sends until the calendar saves — then
  runs the same lookup-gated outreach as a typed add. Suggestions exclude
  addresses already in the outside list, household members' emails, and the
  owner's own email (one exclusion set; the typed path keeps its pointed
  per-case errors: "That's you", "…is in your household — select them above").
  The field keeps the keyboard open across adds (a multi-add field), shows a
  spinner in place of the add button while the account-existence lookup runs,
  and clears the stale "They're on Calen" note as soon as typing resumes. The
  input+dropdown pair is scrolled clear of the keyboard by the shared
  `RevealWrap` (components/ui) — also now used by the event-invitee picker,
  whose previous direct `useRevealOnOpen` call from the screen component read
  a null scroll context and silently never revealed.
- **Shared-lane key loading (the D1 wraps, BOTH sides).** Events on an
  outside-shared calendar seal under its CalendarKey, so the replica can only
  decrypt them while that key is held — and sign-out wipes the replica, the
  sync cursor, and every in-memory key.
  `lib/calendarKeys.ensureSharedCalendarKeys()` is the device pass that
  restores them: it loads the **member wrap** for every calendar shared TO
  this user (`mine:false`, unwrapped with the identity keypair) AND the
  **household wrap** for the user's OWN calendars that ever minted a
  CalendarKey (`mine:true` with `calKeyVersion > 0`, unwrapped with the HDK —
  keyed off `calKeyVersion`, not the outside-share list, so a fully-un-shared
  calendar whose rows still sit under an old CalendarKey keeps decrypting),
  then re-pulls the record feed so previously-skipped ciphertext rows decrypt
  into the replica. It runs from the auth store's keys-ready hook on **every**
  unlock (fresh login included — `maintainKeyHygiene` alone only covered
  restored sessions, which let an owner's own shared-calendar events vanish
  after a sign-out/sign-in), from the viewer shell (mount/focus), and on
  accepting a calendar invitation. Neither side is covered elsewhere: the
  owner reconcile pass (`reconcileCalendarKeys`) only touches calendars with
  PENDING key work, and `openOpaqueRecord` doesn't lazy-load resource keys.
  **The owner reconcile pass runs on every unlock too** (2026-08-02):
  `maintainKeyHygiene` (→ `reconcileCalendarKeys`/`reconcileTripKeys`) moved
  from the relaunch-restore path into the same keys-ready hook, so a newly
  accepted collaborator gets their member wrap the next time the owner opens
  Calen unlocked **however the owner signed in** — previously an owner who
  signed out and back in (a fresh login) never ran the wrap, leaving the
  collaborator's waiting state permanent. Until that owner session happens,
  the shared events are unreadable on the collaborator's device — surfaces
  show a "waiting for the owner" state ("events appear the next time its
  owner opens Calen" — there is deliberately no owner-facing prompt; the
  wrap is silent), not an error.
- **Re-sealing an event seals the WHOLE `EVENT_ENC` subset — never a subset of
  the subset.** Migrating a calendar's events onto its CalendarKey (first-share
  mint, revoke-rotation) decrypts and re-seals each one; whatever the re-seal
  omits is **deleted from the ciphertext**, since the plaintext columns were
  dropped at C3b and the Record row keeps no copy. The field this must never
  lose is **`calendarType`**: it lives only inside the sealed payload (the row's
  plaintext routing is `scope.resource`), and BOTH the owner's grid and the
  viewer's agenda bucket events by the *decrypted* value — so an event re-sealed
  without it is served correctly, decrypts correctly, and renders on **no
  calendar for anyone**. `reSealEvents` therefore builds its content with
  `EVENT_ENC` (forcing `calendarType` to the calendar being migrated) rather
  than a hand-written field list, and the reconcile pass groups candidate events
  by `calendarType || scope.resource` so an already-stripped event is still
  found (grouping on the sealed field alone would strand it under a retired key).
- **`repairCalendarLaneEvents` heals events stripped by the old re-seal.** A
  historical `reSealEvents` sealed 6 of the 20 fields, so events migrated by it
  are invisible on every surface. The pass (owner-only — a `view` collaborator
  is 403'd on the lane; runs from `maintainKeyHygiene`, a SEPARATE call because
  `reconcileCalendarKeys` early-returns exactly when the server reports no
  pending key work) finds cal-scoped replica events with no decrypted
  `calendarType`, restores it from `scope.resource`, re-seals via `EVENT_ENC`,
  and re-syncs. It is idempotent, and it refuses to rewrite an event whose
  content didn't decrypt (locked session reads as "missing" the same way a
  stripped one does — re-sealing that would destroy the event, not repair it).
  Only the routing is recoverable: `allDay`, `recurrence`, `exceptionDates`,
  alerts, travel and `url`/`placeId` were deleted by the truncation and stay lost.
- **View-only enforcement is server-side again (supersedes "moved to the
  client", 2026-07-31).** The opaque `/records` store enforces calendar-lane
  write access from the record's plaintext `scope`: POST/PUT/DELETE of a
  record whose stored or incoming `scope.kind === 'calendar'` require
  **`full`** effective access on `scope.resource`
  (`calendarSharing.canWriteCalendarType` via `effectiveCalendarAccess`) and
  403 otherwise — a `view` collaborator holds a member envelope (they need it
  to read) but cannot write, and no one can POST records claiming a calendar
  they have no seat on. The stored scope gates a scope-less update body, so
  the lane can't be shed by omission. Trips are exempt (trip collaborators
  are full-access by design); an unknown/deleted calendar key falls back to
  the household-scope rule. Client-side, the event form recomputes its
  read-only view from the calendar's `access === 'view'` (the server's old
  per-event `readOnly` stamp retired with C3b), so the 403 never surfaces as
  a mystery save error.
- **Free viewer mode** rides this sharing model: a locked (no app unlock)
  user with a shared calendar or a pending calendar invitation gets a
  read-only viewer shell instead of the hard paywall. A viewer never triages
  calendar invitations — the shell **auto-accepts pending calendar shares**
  on entry/focus (the Accept/Decline inbox flow is unlocked-app-only), so a
  shared calendar simply appears — normative spec in
  [billing-plans.md](billing-plans.md) ("Free viewer mode").

### Overlays & output

- **Forecast strip in the month grid.** When the Weather calendar is toggled
  visible, the grid shows the **7-day forecast as a spanning strip** riding
  the existing week-bar lane system: a translucent lane (tinted with the
  Weather calendar's colour) at lane 0 — event/trip bars stack below it — with
  one segment per forecast day (condition icon + high temp). It spans exactly
  the forecast days, splitting across week rows like any multi-day bar.
  Shown in Details and Stacked; hidden in Compact (which hides all spans).
  Data via `loadPassiveForecast` (source-aware, never prompts; a failed load
  just means no strip). Tapping the strip opens the Weather screen.
- **Geocoding chain.** The client geocoder (`shared/weather` `geocode`) tries
  Nominatim first and falls back to Photon (both keyless + CORS-open, so E2EE
  households never send the address to our server). The server geocoder
  (`services/weather.js`, pre-drop households only) prefers the Google
  Geocoding API when `GOOGLE_PLACES_API_KEY` is set and falls back to
  Nominatim. Both surface the primary's error message when the whole chain
  fails.
- **The Weather screen's location source** is chosen on the screen itself via
  the single tappable **location chip** above the hero (icon + current-source
  label + chevron → the three-option picker sheet). One affordance, not two —
  a header button was tried and removed as redundant. Layout constraint: the
  screen's header is a transparent native bar whose band swallows taps
  entry-path-dependently, so the chip MUST sit *below* it (content clears
  `insets.top + 52`); a control inside the bar band regresses tappability from
  some entries (e.g. the former day-view weather card). Persisted device-local
  (`hc_weather_source`, `lib/weatherSource.ts`):
  - **My location** (the default — first open triggers the iOS location
    permission ask): a foreground GPS fix, fetched client-direct from
    open-meteo, so the fix never touches our server. One fix is cached ~60s and
    shared by the forecast + outlook queries. Failure modes render an
    actionable card, not a dead screen: permission **denied** → Open Settings +
    "Use home address"; native module **unavailable** (pre-rebuild dev client,
    lazy-required) → reinstall note + "Use home address".
  - **Home**: the household's home address via the existing E2EE-aware path.
  - **Another location**: tapping the row expands an inline **Google-Places
    city autocomplete** (`PlacesAutocomplete type="city"` — the same picker as
    trip destinations). **Selecting a suggestion is the confirmation**: it
    applies the source and closes the sheet; free text alone is never
    accepted, so an unrecognized place can't be saved. The chosen place shows
    as the row's subtitle, and its weather is geocoded client-direct
    (`geocodePlace`) at fetch time.
  The chip renders above the loading/error branches so a broken source can
  always be switched away from.
- **Rain icons scale with intensity.** The WMO code buckets into
  light (51/53/56/61/80) / moderate (55/57/63/66/81) / heavy (65/67/82)
  (`rainIntensity` in `components/WeatherIcon`). All tiers use the SAME
  classic two-tone composite — a consistent solid **white cloud** with blue
  Ionicons `rainy` **streaks** below it. Only the streaks vary: the component
  renders just the glyph's lower streak band (its own blue cloud is never
  shown, so no blue cloud peeks past the white one) and clips that band's
  width from the right (55% / 78% / full) so lighter rain reveals fewer of the
  same streaks — heavy is exactly the original icon. The **cloud is identical
  across all three tiers**; only the raindrop count changes. Chosen over a
  custom drop composition (tried and rejected): the tiers must stay
  stylistically identical to the original glyph.
- **Thunderstorm is the same composite, three-tone**: the solid white cloud
  over the Ionicons `thunderstorm` glyph's lower band, with **blue** rain drops
  and a **gold** bolt (blue lower band + a gold centre strip re-colouring just
  the bolt). Like rain, only the glyph's lower band is ever rendered — its own
  cloud never shows, so no gold/blue edge peeks above or beside the white
  cloud. Band and strip positions are **measured from the font**, not
  eyeballed (glyph advance = exactly 1em, so fractions of `size` are exact;
  cloud bottoms at y 0.65, bolt x 0.344–0.662, drops x 0.154–0.299 /
  0.703–0.844), and every clipped inner glyph carries an explicit
  `width: size` — an RN Text measures at most its parent's width and iOS clips
  the glyph to the Text's **own** bounds, so inside a narrow clip wrapper an
  auto-width glyph shows only its leftmost slice regardless of where the
  wrapper's window sits (the cause of both the original gold right-hand drops
  and the gold bolt strip silently rendering nothing).
- **Rain quantity is shown wherever weather is.** Amounts format via
  `formatMm` (one decimal under 1 mm, whole numbers above, hidden under
  0.1 mm): the Weather hero's meta line adds "Rain X mm" when it's currently
  precipitating; each 7-day row shows "prob% · Xmm"; every hourly-strip slot
  (Weather screen, trip detail) shows the hour's mm under its probability.
- **Passive weather surfaces** (the calendar day view's **hourly weather
  rail** and **List-header glance**, and the **assistant's** weather context)
  follow the same chosen source via
  `loadPassiveForecast`, with one hard rule: they **never prompt** — the
  location permission ask belongs to the Weather screen. Live is used only
  when the permission is *already* granted; otherwise (or when the GPS fetch
  fails) they fall back to the home address, and when that fails too they
  render no weather. So a live-location user with no home address still gets
  the day-view glance once they've granted the permission on the Weather screen.
- **No home address** (home source) on the Weather screen is an actionable
  empty state: a card explaining what the address unlocks with a **"Set home
  address"** button that navigates to the Account screen's identity section
  (`promptField: 'homeAddress'`, so the field arrives highlighted under its
  setup callout). Other load failures (offline, provider down) show a plain
  retry message instead — the CTA only appears for the missing-address error,
  recognized by `isMissingHomeAddressError` (`lib/weatherSource.ts`), the single
  definition covering both the client-direct throw and the server error body.
  While that prompt is showing it is the **only** card on the screen: the
  **90-day seasonal outlook is hidden**, since an outlook for a location we
  don't have can only stack its own failure under a card already asking for it.
- **A saved address takes effect immediately on the screens behind Account.**
  Saving a *changed* home address invalidates the `['weather']` and
  `['homeAddress']` query trees, so the Weather screen the user was sent from
  re-fetches instead of re-rendering its cached "no home address" error (the
  screen stays mounted under Account, so nothing else would refresh it); the
  same invalidation refreshes the month grid's forecast strip and the
  travel-time screen's Home shortcut.
- **Travel-aware weather.** When a *booked* trip's date range spans today, the
  Weather screen shows a destination-forecast card (current conditions + the
  remaining trip days, capped at 5) under the home forecast. Fetched
  client-direct from open-meteo via `geocodePlace` — the destination never
  touches our server. The card is silent (absent) when there is no active
  trip, the trips add-on is locked, or the lookup fails.
- **Holidays** and **occasions** (from People) surface as read-only events (see
  the Occasions calendar below).
- Events/agenda can be **printed** (`mobile/src/lib/printCalendar.ts`, Print
  screen). In the month-grid layout an event title **wraps to at most two lines**
  (a CSS line-clamp) rather than clipping to one — long titles stay legible in a
  tight cell. Times print in a **compact 12-hour form** by default ("1:00 PM" →
  "1PM"; ":00" and the space are dropped), and the Print screen's Options offer a
  **24-hour clock** toggle that renders zero-padded `HH:mm` ("13:00") instead.

### Occasions calendar (free opt-in add-on, id `birthdays`)

- The **Occasions** calendar (formerly "Birthdays") derives read-only,
  annually-recurring events from People. Two sources per contact:
  - the dedicated `Person.birthday` field → a `birthday` occasion; and
  - each `Person.dates[]` entry → an occasion whose **kind comes from the
    label**: `anniversary` and `death` are the selectable recognised kinds (a
    legacy `marriage` label is still recognised for pre-existing contacts but is
    no longer offered — `anniversary` is the wedding label); any other label is a
    `custom` occasion whose display name is the raw label.
  The shared engine (`shared/calendar` `occasionOccurrences` +
  `occasionKindFromLabel`) builds `CalendarData.occasions`
  (`{ id, kind, name, date, personId, label, year? }`); consumers title/icon
  each kind via `mobile/src/lib/occasions.ts`. Add/edit occasion dates on the
  person's card (People); the internal calendar/add-on id stays `birthdays`.
- **Rendering.** On the month grid, occasions appear as **kind icons** (cake /
  heart / ring / candle / calendar-star) in the cell's icon row — **not** as
  event-style chips. Tapping an occasion anywhere it's read-only (the month-grid
  icon, the day view, the agenda list) opens the **Occasions** screen, not the
  person's edit form, and passes a `focus` param so the list **scrolls that
  occasion to the top and outlines it** (bolder border + faint accent wash). The
  focus is matched by `occasionFocusKey` (person + kind + month/day + label). (The
  person's card is still where dates are edited, reached from the Occasions list.)
- **Per-contact inclusion.** A person may be **excluded** from the Occasions
  calendar via `Person.occasionsHidden` (sealed; default shown) — a
  "Show on Occasions calendar" switch in the Occasion dates section of their card. Hidden
  contacts contribute no occasions to the grid, day/list, search, print,
  reminders, **or the Occasions list** — they are **omitted entirely** (the
  shared engine and the Occasions screen both skip them), re-included only by
  toggling the switch back on from the person's card. Tapping any (shown)
  occasion row opens the person **scrolled to the Dates section**
  (`PersonForm` `focus: 'dates'`) to edit its dates.
- **Occasions list — a today-anchored timeline.** The list is not a flat
  forward run; it reads as a timeline centred on today, so it's clear what has
  just happened vs. what's coming and when it's worth planning ahead.
  `lib/occasions.collectOccasions(people, now?)` anchors each occasion to the
  occurrence **nearest today** and returns a signed `offset` in days: a
  recently-passed occurrence within **`PAST_WINDOW_DAYS` (7)** gets a **negative**
  offset, today is **0**, otherwise the **next upcoming** occurrence gets a
  **positive** offset (rolling to next year once this year's date is >7 days
  past). Entries sort by `offset` (then name), and the screen splits them into:
  - **Recently observed** (`offset < 0`) — a `SectionHeader` group of dimmed
    rows for occasions in the last 7 days, so a just-passed occasion doesn't
    silently teleport to the bottom of the list. These rows carry **no
    "schedule an e-card" prompt** (a card set now would fire ~a year out); if the
    occasion's card already sent (`active:false`, `sentAt` set) the row shows a
    small **"Sent"** pill instead.
  - a **"Today · `<Mon D>`"** marker row (accent rule + label) anchoring the
    boundary — shown whenever any occasions exist.
  - **Coming up** (`0 ≤ offset ≤ COMING_UP_DAYS` (60)) — the highlighted
    plan-ahead horizon; the primary actionable zone where the e-card envelope
    (schedule / edit / active-`email-check`) lives. Today's occasions (offset 0)
    lead this group with the accent outline. When nothing falls in the window an
    inline "Nothing in the next 60 days." note shows.
  - **Later this year** (`offset > COMING_UP_DAYS`) — a **collapsed** toggle
    ("Later this year (N)") for the far-future tail, so dates too distant to plan
    a card for don't clutter the horizon; auto-expanded when a calendar-tapped
    `focus` occasion lives there.
  `whenLabel(offset)` renders the relative cue ("Yesterday" / "3 days ago" /
  "Today" / "Tomorrow" / "in N days"); "Later" rows drop it and lean on the
  month/day. The windowing is unit-tested (`lib/__tests__/occasions.test.ts`,
  injectable `now`). The explanatory `Hint`
  ("Occasions come from the dates on your contacts' cards — birthdays,
  anniversaries, and any other dates you add …") shows only when there are
  occasions to act on. With none shown, an empty state ("No occasions yet")
  explains that the dates you add to a contact surface here and offers an **Add
  dates in Contacts** action. The copy treats **birthday as one of the dates**
  (not a separate thing) and says "contacts", not "People".
- **Calendar-level alerts.** One alert config for the whole Occasions calendar
  (no per-occasion override) — offsets (days before) + a single time, stored
  device-local (`hc_occasion_alert_prefs`). Defaults: an alert at **noon the day
  of** the occasion AND one **two weeks before**. Alerts fire on-device like
  maintenance/chore day-alerts (see [notifications.md](notifications.md)); the
  Occasions calendar's Alerts switch (calendar id `birthdays`) mutes them.
- **Scheduled e-cards.** From an occasion the user can schedule an e-card:
  a card **style chosen from a per-kind gallery** (birthday / anniversary /
  marriage / condolence / custom) plus a custom message, delivered by email on
  the occasion's date. **Style gallery:** each kind offers **three designs**
  (e.g. birthday: Confetti / Balloons / Golden; condolence: Dove / Candlelight /
  Evening Sky), defined in `server/src/services/ecardTemplates.js` (`GALLERY`)
  and mirrored for the picker in `mobile/src/lib/ecardTemplates.ts` — the
  template **keys are a stable API contract** kept in sync by a unit test. The
  form shows the styles as a **horizontal swatch row**; the chosen key is
  stored in `ECard.template`. **Unknown or legacy keys** (old rows stored
  `template: <kind>`) resolve to the kind's **first (default) style** on both
  sides. **Card email design:** the e-card does NOT use the transactional
  `htmlLayout` — it renders as a standalone greeting card (tinted canvas,
  rounded card, full-bleed gradient cover with decorative art, display
  heading, message on white, per-style sign-off phrase, "Sent with ♥ through
  Calen" footer). **Motion is progressive enhancement:** cover art animates via
  CSS `@keyframes` (floating balloons/hearts, falling confetti, twinkling
  sparkles, drifting doves) in clients that support it (Apple Mail / iOS Mail,
  Outlook macOS, Thunderbird); Gmail and Outlook-Windows strip animation and
  receive the identical static card (with `bgcolor` solid fallbacks where
  gradients are unsupported); a `prefers-reduced-motion` query stills
  everything. Condolence styles use only slow, gentle motion, and **condolence
  subjects never include the recipient's name** (celebration kinds do; custom
  labels don't). All user content is HTML-escaped, and a plaintext alternative
  always accompanies the HTML. **Fully editable card text:** every line of the
  card is author-editable — the greeting, message, sign-off phrase, and
  signature are **bare inputs on the card face itself** (placeholders show the
  defaults). Blank fields fall back at send time: greeting → per-recipient
  "Dear <first name>," — recipients are stored with their full contact name,
  but the default greeting and the subject-line name use the **first name
  only** (a custom greeting applies to every recipient verbatim);
  sign-off → the style's phrase; signature → the author's first name (the
  signature also signs the subject line). Stored as `ECard.greeting` /
  `signoff` / `signature` (≤120 chars each). **Font choice:** an `ECard.font`
  key picks the card typeface from a small email-safe menu — Auto (the
  template's own face) / Modern (system sans) / Serif (Georgia) / Elegant
  (Palatino) / Script (Snell Roundhand, cursive fallback; rendered slightly
  larger for legibility) — applied to the heading and body in both the email
  (`FONTS` stacks) and the native preview (`FONT_NATIVE`); unknown keys fall
  back to the template default. **Photos:** up to **3 author photos** per card
  (JPEG/PNG/GIF/WebP, ≤10MB each), uploaded multipart to `POST
  /api/ecards/:id/photos` into the shared disk upload store and **embedded
  inline in the email via CID attachments** (no external image hosting) between
  the message and sign-off; removable per-photo (author-only) and unlinked from
  disk when the photo or card is deleted. New-card photo picks upload after the
  card is created; a failed photo upload never loses the card.
  Recipient candidates are scoped to **the occasion's own
  contact plus anyone linked to them** (their `relatedNames` that resolve to a
  roster person) — not the whole roster. To add another recipient, an **"Add a
  related contact"** row opens the occasion **contact itself** (`PersonForm`,
  `focus: 'related'` — scrolled to Related names) where the link is managed
  normally (including its sealed reciprocal back-link); on return the newly
  linked contact appears as a candidate here automatically, since the recipient
  list is derived from the occasion contact plus their related names.
  A candidate **missing an email** can
  have one added **inline**, which is saved to that contact's card (sealed). A
  card goes to **one address per recipient**: a contact with **multiple emails**
  defaults to their primary, switchable via a per-recipient address picker (the
  chosen label, e.g. "work", shows on the row). Send delivery is **hour-granular**
  (the scheduler reads only the hour), so the send time is a **whole-hour
  picker**, not a free minute field. The hour list **opens scrolled to noon**
  (AM hours reachable by scrolling up) so daytime hours are the visible
  default and "2:00 AM" isn't mistaken for "2:00 PM". The form's centerpiece is
  the **live editable card** (gradient cover + gently bobbing art via
  Reanimated/SVG, heading, then the editable greeting/message/photos/sign-off/
  signature lines, footer) mirroring the email renderer — there is no separate
  message field. The editable lines carry a visible **edit affordance** (a
  "Tap to edit" pencil badge on the card body + a faint dashed underline under
  each line) so their tappability isn't mistaken for finished card text; tapping
  the badge focuses the greeting line with the caret at its start. A **scheduled**
  card is marked on its occasion row by a filled-envelope icon; tapping it
  **re-opens the card to edit or cancel** it. **Each card sends once**, on the
  occasion's **next upcoming** date (this year if it hasn't passed yet, else next
  year), then **deactivates** (`runECardCheck` clears `active` and stamps
  `sentAt` after the send) — it does **not** recur annually. A meaningful edit
  re-arms the card for its next occurrence. The form's send hint reads "Sends
  once on `<next date>`". **Deliberate E2EE exception:** the recipient emails,
  message/framing lines, and card photos are stored **plaintext** server-side
  (`ECard` model + upload-store files, `POST /api/ecards`) and sent by the
  scheduler (`runECardCheck`) so they fire while
  the app is closed — see [crypto-e2ee.md](../platform/crypto-e2ee.md)
  "Deliberate plaintext exceptions". This plaintext-exception disclosure is shown
  on the form at **create time only** (the edit view drops it once the card
  exists). Occasions stays a free add-on; e-cards are
  free.

## Data & API surface

- **Model:** `CalendarEvent` (`server/src/models/CalendarEvent.js`). Custom
  calendars: `CustomCalendar`. Cross-household invites: `EventInvitation`;
  emailed non-account invites also touch `CalendarInvitation`.
- **Persistence:** events are **not** stored via a `/events` route. They are
  content records in the **unified opaque record store** — created/updated/
  deleted through `POST/PUT/DELETE /api/records` and pulled with the incremental
  last-writer-wins sync `GET /api/records/sync`. The `CalendarEvent` schema
  defines the *decrypted* shape and the plaintext scope fields; the server
  stores the sealed blob. See [platform/data-model.md](platform/data-model.md).
- **Custom calendars / keys / invitations:** `server/src/routes/calendars.js`
  (`/api/calendars`, including per-calendar key envelopes under `/:key/keys`).
- **Assistant:** `server/src/routes/calendarChat.js` (`/api/calendar/chat`).
- **Client:** `mobile/src/screens/calendar/*` (Calendar, Day, Agenda, Search,
  event form + its sub-screens for location/repeat/invitees/travel, Calendars,
  Add/Subscribe/Holiday, Weather, Print, Invitations) plus `lib/calendar.ts`,
  `calendarData.ts`, `eventRepeat.ts`, `calendarKeys.ts`, `holidays.ts`.

## Encryption boundary

- **Everything is sealed.** In the live opaque record store a calendar event is a
  `Record` whose entire content — `title`, `description`, `location`, dates,
  `calendarType`, `alertAudience`, `cancelled`, recurrence, `exceptionDates`
  (deleted-occurrence days), and even the fact
  that it *is* a calendar event — rides inside the encrypted `enc` blob. The
  server sees only the record's routing metadata (`householdId`, key version,
  ciphertext, optional shared-resource `scope`, tombstone, timestamps). See
  [platform/data-model.md](../platform/data-model.md).
  - The `CalendarEvent` schema's per-field "plaintext scope field" comments
    describe the earlier dual-write era; they are **not** server-visible for new
    records. Reminder *timing* is handled on-device (local notifications), not by
    a server-visible schedule field.
- **Outside sharing is a minimized plaintext exception.** Event invitations to
  people who **have accounts** are **sealed** to the recipient (Signal-parity
  D3) — no plaintext snapshot. Only an invitation to someone **without an
  account** carries a *readable snapshot* of that one event (that's what makes
  the public `.ics` link in the composed email/text work); revoking the
  invitation deletes the snapshot. A calendar shared outside the household uses a per-resource
  CalendarKey (D1) so the collaborator decrypts it without the HDK. See
  [platform/crypto-e2ee.md](../platform/crypto-e2ee.md) and `docs/TRANSPARENCY.md`.

## Verification

- Calendars view interaction contract: row tap toggles visibility (never
  navigates), Open pill / edit button navigation, locked add-ons collapsing
  into the single storefront row (and the row persisting as the "All add-ons
  added" manage entry when everything is owned) —
  `mobile/src/screens/calendar/__tests__/CalendarsScreen.test.tsx`; the
  data-side lock (`applyAddonLocks`) — `mobile/src/lib/__tests__/addons.test.ts`.
- Custom calendars: create/list visibility tiers (private, household-wide,
  member-specific, outsiders excluded), creator-only writes, validation,
  outside-share invitation lifecycle, access levels, feed subscription
  normalization, and the free-viewer-mode `viewer` counts on
  `GET /billing/status` (pending → accepted → revoked; pre-signup email claim)
  — `customCalendars.integration.test.js`.
- Calendar-lane write authorization: a seated `view` collaborator reads the
  resource lane but 403s on POST/PUT/DELETE (including a scope-less update
  body), a `full` collaborator and the owner write, a non-collaborator can't
  POST into a foreign calendar scope — `records.integration.test.js`.
- Per-calendar resource keys: owner-only mint/rotate, wrap-on-approve,
  collaborator-only member wraps, sealed events reaching collaborators as
  ciphertext, revoke → rotation, envelope cleanup on delete —
  `calendarKeys.integration.test.js`.
- Event invitations: invite/accept/decline/leave/revoke lifecycle, copy-event
  semantics, email-only claim at registration, `.ics` snapshot + public link,
  guest-list scope, guard rails — `invitations.integration.test.js`.
- CalendarKey re-seal integrity: a migrated event keeps its whole `EVENT_ENC`
  subset (the 14 fields an earlier hand-written list dropped, `calendarType`
  first), an already-stripped event is still found via `scope.resource`, and
  `repairCalendarLaneEvents` restores `calendarType` while leaving healthy,
  undecrypted, and not-mine events alone — `mobile/src/lib/__tests__/calendarKeys.test.ts`.
- Recurrence expansion (the shared engine) — `shared/calendar/index.test.js`.
- Client-side calendar plumbing (feeds, prefs/density, holidays, recurrence
  helpers, timezone math, printing) — the `mobile/src/lib/__tests__/` units
  listed in `tests:`.
- Month-block geometry: every day of every month covered exactly once, a
  boundary week rendered in both months with complementary halves, unique row
  keys, the month marker on the 1st at `firstCol`, a Sunday-start month with no
  leading blanks, a 28-day February starting mid-week, and spanning bars clipped
  (or dropped) at the block edge — `mobile/src/lib/__tests__/monthGrid.test.ts`.
  The same suite pins the **density layer** (`weekLayout`): all three densities
  read off one unchanged core, a week is sized by its single tallest cell
  (never by per-column maxima summed), the month-label line is reserved in every
  density, each density's own minimum/maximum height applies, and the weather
  lane shows in Stacked/Details but never in Compact.
  The viewer grid's today anchor rides on the same geometry —
  `mobile/src/screens/viewer/__tests__/ViewerMonthGrid.todayAnchor.test.tsx`.
- The month-boundary rule: a month's first row draws no rule of its own, each of
  its own-month day cells draws the ordinary `colors.border` hairline, the blank
  lead-in cells draw none, and an ordinary week row still owns its rule at the
  row level —
  `mobile/src/screens/viewer/__tests__/ViewerMonthGrid.monthRule.test.tsx`
  (`CalendarScreen`'s grid carries the identical row/cell style pair).
- Day-view layout math (all-day vs. timed routing incl. midnight clipping, the
  muted task chips + icon-badged chore chips, lane packing, week-strip paging/selection,
  initial-scroll targets, gutter/now-badge labels) —
  `mobile/src/screens/calendar/dayview/__tests__/dayViewLayout.test.ts`.
- The sealed record store the events persist in is verified under
  [platform/data-model.md](../platform/data-model.md) (records suite) and
  [platform/crypto-e2ee.md](../platform/crypto-e2ee.md) (author hiding, drop).

## Out of scope

- Recurrence *math* lives in `shared/calendar/` (its own tested engine), not
  here.
- Reminder *delivery* is specified in [notifications.md](notifications.md).
- The calendar assistant's data-minimization/consent rules are in
  [ai-assistant.md](ai-assistant.md).
- Cross-household key/membership mechanics are in
  [households-sharing.md](households-sharing.md).

## Open questions

- Document the ICS subscription refresh cadence and failure behavior.

*(Resolved 2026-07-20: event reminder scheduling is fully on-device; no
server-visible schedule field remains — see [notifications.md](notifications.md).)*
