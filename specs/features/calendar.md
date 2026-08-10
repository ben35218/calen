---
title: Calendar & events
status: current
last-verified: ddaa21b+ (2026-08-10); **month ⇄ day is now one canvas that zooms, and Today drills into it** — the bottom pill (Today | Calendars) and the Calen FAB sit at identical coordinates on both screens, yet a stock native push was sliding that shared furniture off-screen and back for every day open; `CalendarDay` now pushes with `animation: 'none'` and the two screens draw the move themselves (`screens/calendar/dayTransition.ts`) as a shared-axis-Z zoom — month content scales up 1→1.08 and fades, the day grows in from 0.92, top pills swing wider (1.14) so the button row is what visibly pops, and the bottom row animates on NEITHER screen so it reads as one pill that stayed put; the screens swap only once both are empty (month fades first, THEN navigates; day fades first, THEN pops — the pop intercepted via `beforeRemove` so the back pill, Android back and pop-past all get the reverse zoom, RESET excepted), the month's zoom state is module-level so returning resumes the move backwards instead of cutting to a cold month, and Reduce Motion drops the scaling for a plain crossfade; a real blur was rejected (RN `filter: [{blur}]` is Android-only — it would cost a native module and an EAS rebuild), as were Reanimated shared-element transitions and `react-native-screen-transitions` (nothing travels between different layouts). **Today** in the month view now opens today's day view (in the last-used day mode) after re-centring the layer underneath, instead of only scrolling. **the day view's bottom floating chrome now matches the month view's** — the day view had drifted to its own bottom row (a lone **Today** pill on the left and a calendar-glyph month-jump button on the right), so the two things the month view puts in that row, **Calendars** and the **Calen FAB**, were unreachable from a day; the day view now renders the same labelled **Today | Calendars** pill and the same AI-gated Calen FAB, and the calendar-glyph button is gone (back to the month is the top-left back pill, which the glyph merely duplicated while displacing the assistant); the pill's label padding was also brought back to the month view's 16pt, since the 22pt it used while Today sat there alone pushed the new divider off-centre. **the day view's event blocks now read like cards** — a block showed its title over a single muted grey line that ran the start time and location together ("9:00 AM · 520 St Philippe St"), so the two most-asked questions of a calendar block (where, and until when) were either absent or buried in one undifferentiated string; a block now carries **title, location and the start–end range** as separate lines, each meta line led by its own glyph (pin, clock) and set in the calendar's colour rather than grey, with the range written Apple-compact (`timeRangeLabel` — "9 – 11AM", "11:30AM – 1PM": on-the-hour drops the minutes and one meridiem serves both sides when they share a half of the day); what a block says is now governed by its rendered height (`blockDetail` — full ≥56px carries all three, medium ≥38px drops the location, below that the title alone, with a second title line only above 78px), so a half-hour event no longer tries to stack three clipped rows into 30px; an event with a drive time set now **extends upward from its start** rather than carrying a badge — the block's span begins at the DEPARTURE and its top slice is a labelled **travel band** ("15 min travel"; silent under 14px, always explicit to a screen reader: "30 min travel time before this event — leave by 9:30 AM"), drawn in a third of the block's tint with a faded left bar and a hairline at the boundary so where the driving stops and the event starts is unmistakable; the band is real occupied time, so it takes part in lane packing (a drive overlapping an earlier meeting splits the width — one can't be driving to one event and sitting in another) and in the opening scroll position, is clipped at the top of the column when the drive would start before midnight, and does NOT feed the height tiers, which measure the event body alone (a first cut instead marked travel with a car glyph on the time row — dropped: a badge says a drive exists but shows none of the time it takes); the block text also moved onto the shared `lib/color.tintedChip` palette, so the calendar hue is lightened to clear the contrast floor against the block's own 18% fill instead of being painted raw (the same correction the month chips took); 8 new component tests in `dayview/__tests__/DayColumn.test.tsx` plus label/tier tests in `dayViewLayout.test.ts` (2026-08-10); ddaa21b+ (2026-08-10); **the Details grid's event chips are now tinted, not solid** — a chip was a block of the calendar's colour with white text, which reads as a filled label rather than as an event and, three to a cell, turned a busy week into slabs of saturated colour; a chip is now Apple's tinted card: a translucent wash of the calendar's colour (22% over the black canvas) carrying the title and start time **in that same colour**, so the hue still identifies the calendar while the cell reads as text on the canvas (multi-day spanning bars stay solid with white text, as in Apple Calendar, which is what keeps a span visually distinct from a single-day chip); because the stored calendar colours are Material 700-weight hues that land near 3.5:1 as text on their own tint — under the WCAG AA floor — the label colour is derived rather than used raw: new `lib/color.tintedChip` lightens the hue (hue and saturation held) only as far as needed to clear 5.5:1 against the fill it actually sits on, with the quieter time line composited to an opaque hex and pulled back up if the dimming took it under 4.5:1, memoized per colour and unit-tested against every entry in `COLOR_PRESETS`; free viewer mode's `ViewerMonthGrid` carries the identical chip (2026-08-10); ddaa21b+ (2026-08-10); **the custom-alert sheet now saves on dismissal, not only on Done** — setting a lead time and tapping away (scrim, drag-down, Android back) discarded it, so the alert could only be captured by hitting Done; the sheet commits what the wheel is showing on every close, like the Starts/Ends pickers, while a sheet dismissed without touching a control still writes nothing (the 30-minute seed is not a choice); the sheet moved out of EventFormScreen into `components/CustomAlertSheet.tsx` with the selection mirrored as it is picked (the slide-out callback can run before React re-renders) and a component test on the dismissal contract; ddaa21b+ (2026-08-10); **the List layer's day selection restyled to Apple's dark-mode calendar** — today keeps its filled primary disc only while it IS the selection; picking another day demotes today to a bare primary-coloured number and gives the picked day a white disc with the number knocked out in the canvas black (was a `colors.surface` grey tint under an unchanged number, with today's disc never yielding); ddaa21b+ (2026-08-10); **the floating add button is selection-aware in List mode** — tapping a day in the List layer and then **+** opens the new-event form with Starts/Ends on that day (the host reads the layer's selected day over the shared `TodayHandle` via a new optional `getSelectedDate`; previously the form always opened on today); the grid family, which has no selected day, keeps the today default; ddaa21b+ (2026-08-10); the custom-alert sheet's anchor control now leads with **Before leaving** and defaults to it on a slot with no alert set (a slot that already holds one still opens in its own framing, so Done can't re-anchor it); ddaa21b+ (2026-08-09); the custom-alert sheet's unit tabs now start each unit at its own default (30 min / 2 hr / 2 days) instead of clamping the previous unit's number into the new range, which landed a tap on Hours at 23 hours; ddaa21b+ (2026-08-09); **clearing the first alert now promotes the second into its slot** (`promoteSecondAlert`, anchor carried up) — the Second Alert field only renders while a first alert exists, so clearing the first left the second set behind a hidden row: invisible, uneditable, and back the moment a first alert was set again; ddaa21b+ (2026-08-09); **event alerts now record whether their lead time was set against the event or against departure** — a custom "2 hours before" was re-worded by the picker as "1 hr 37 min before leaving" (any value at or past the drive time was assumed departure-relative, so only canned rows escaped it); the framing is now stored (`alertAnchor`/`alert2Anchor`), the pickers are keyed by anchor+minutes, the custom sheet gained a Before event / Before leaving control and a Minutes wheel to 180 (so 90 minutes / 1½ hours before leaving is reachable at all), and a departure-anchored alert follows a changed drive time; ddaa21b+ (2026-08-09); **the Location view's search now finds addresses, not just businesses** — the untyped `/places/autocomplete` lane filtered predictions to `establishment`, so typing a street address into the field labelled "Search for a business or address" returned an empty dropdown; the untyped lane now sends no `includedPrimaryTypes` at all (2026-08-09); ddaa21b+ (2026-08-08); **live household sync (poke-and-pull)** — a housemate's write now reaches the other members' devices without a refresh: the record write routes feed a content-blind poke bus (`services/recordChanges` — coalesced pokes + a debounced data-only silent push + a Mongo change stream for out-of-band writes, degrading to local-only off a replica set), delivered over an authenticated WebSocket at `/api/records/ws` (`services/recordSocket`, session-revocation-aware, writer's session excluded) to `lib/recordSocket`/`hooks/useRecordSync` on-device, where every poke/reconnect/foreground schedules the normal cursor revalidate (`scheduleRevalidate` — the 10s floor parks a trailing pass instead of dropping a poke) and the silent push wakes a backgrounded app to sync the replica (`lib/pushSync`, dirty flag → `['calendar']` invalidation on foreground; `remote-notification` added to UIBackgroundModes, needs an EAS rebuild) (2026-08-08); **the Location view's map previews are now tappable** — a picked Google Place collapsed into a card whose static map looked exactly like the event view's location map but did nothing when tapped, so the map read as broken; both map previews on that view (the picked place card's and the manual-entry one below the Name/Address fields) now open the place in Maps through the same Google Maps search URL the event view uses, queried with `locationString()` so the two entry points land on the same place, with the card's ✕ left as its own tap target so clearing the selection still can't open Maps (2026-08-08); **the Invitees screen was restructured into three titled zones** — it opened with a paragraph describing only the OUTSIDE-invite flow (which read as the whole screen's purpose) over an untitled member list and an untitled address field, so neither act was labelled and the guidance was prose the user had to read past to reach the controls; it is now **Notify household members** / **Invite others** / **Guest list**, each a bold zone heading whose explanation is folded behind the ⓘ (`HintDisclosure`, per mobile/CLAUDE.md "hints are disclosed, always"), with the New/Received/Accepted/Declined status groups demoted to the quiet uppercase `SectionHeader` eyebrows nested under their zone (the two levels were previously the same style, so the screen read flat), the empty state scoped to the outside-invite zone ("No one outside your household yet.") so a household-only event no longer reads as empty and reduced to a single muted line — the hand-rolled icon block (and the shared `EmptyState variant="inline"` that first replaced it) stood ~158px against the ~80px the first invitee row occupies, so the zone visibly SHRANK on adding someone, which reads as the layout breaking rather than as progress, the switch relabelled "Guests can see who's invited" so its heading and label stop repeating the words "guest list", and the whole Guest list zone now **hidden until an outside invitee is staged or sent** (a cross-household concern housemates aren't part of — on a household-only event it governed nothing, and a dead control closing the screen invited the user to reason about a guest list that would never exist) (2026-08-06); **Household invitees: in-household accept/decline on events** — the Invitees screen gained a "Your household" member section (>1-member households, creator excluded); the selection seals into the event as `householdInvitees` (EVENT_ENC/DROP_FIELDS/CONTENT_KEYS + the invitee-draft seed-through so re-saves preserve it), each member answers with their OWN sealed `EventRsvp` record (single-writer — no LWW contention on the event; client-side join in `lib/householdRsvp.ts`), the invited member gets an instant push + a `householdEvent` inbox row (replica-derived, 5s poll, badged) with Accept/Decline, the creator gets a reply push + per-member status chips on the event detail (household names ahead of outside invitees), an in-place date/time edit re-notifies non-declined invitees WITHOUT resetting RSVPs, and the push channel is a stateless membership-validated relay (`POST /notifications/event-request|event-response`, client-chosen strings, nothing stored — see notifications.md) (2026-08-06); **Starts/Ends rule redesigned: editing the start now ALWAYS carries the end with it** (in either direction, not only when dragged past the end) so the duration is preserved — the end field is how the duration changes (shared `lib/datetime.endKeepingDuration`, so trips/itinerary/reschedule windows follow too) (2026-08-06); **the All day switch could not be turned OFF** (reported on device: the toggle sprang back on) — `alertsForAllDay` returned its `alerts` argument unchanged in the off branch, and the switch passed the whole form as that argument, so `set({ allDay: false, ...alertsForAllDay(false, form) })` spread the form's own `allDay: true` back over the patch; the helper now returns a fresh two-key object in both branches and the switch hands it only the two alert fields (2026-08-06); e-card text strips **U+FFFC OBJ characters** (iOS dictation leftovers rendered as an "OBJ" box — reported from a delivered card) at write AND render time, and the cover hero emoji gets a **Gmail-only shrink** (`u + .body .ec-hero`) because Gmail's emoji-bitmap swap blurs it at 58px (2026-08-06); **the e-card ✓ no longer holds the user through the photo uploads** (reported: a long spinner on the form before returning to Occasions) — save awaits only the card-row create/update, navigates back immediately, and the multi-MB photos upload in the background in parallel (`lib/ecardPhotos.uploadECardPhotos`), with a global alert naming how many failed (2026-08-05); e-card photos are picked **multi-select in one library visit** (`pickImages` in lib/media, `selectionLimit` = the card's open slots) instead of one per visit (2026-08-05); **e-card subject put the recipient's name after the heading's punctuation** ("🎊 Congratulations!, Alan — from Ben", reported from a delivered anniversary card) — the name now goes inside the closing punctuation ("Congratulations, Alan! — from Ben"), and **card photos downscale to email size at send time** (`mailer.emailSizedPhoto`: ≤1280px, EXIF-oriented, GIF passthrough; stored originals untouched) because full-resolution phone photos (~3MB) made Apple Mail defer the inline card images into "Tap to Download" tiles that then opened at full size (2026-08-05); **all-day event alerts are whole days off the day-alert hour, not minutes off noon UTC** — an all-day event has no start time, but its Alert pickers still offered 15/30/60-minute lead times and the scheduler counted them back from the stored noon-UTC instant, so every all-day alert landed at whatever local hour the reader's UTC offset produced (5am in Los Angeles, 8am in New York, 2pm in Berlin) and a previously configured minute offset survived the All-day switch untouched; an event alert now counts back from an ALERT ANCHOR (`eventAlertAnchor`, lib/calendar) — its start instant when timed, its own calendar date at `User.dayAlertTime` (9am default) when all-day — the all-day pickers/labels/Custom sheet/AI schemas offer whole days only ("On the day (9:00 AM)"), switching All day ON re-bases the alerts already set instead of dropping or keeping them, and the notification body is day-based (2026-08-04); **the calendar painted in the default colours before recolouring** — the prefs load only started when a calendar surface mounted, and read ~15 AsyncStorage keys one await at a time, so the grid/chips/icons came up in the built-in colours and switched to the user's a second or two later; the load is now a single `multiGet` and the app holds its splash on `useCalendarPrefsReady` (cache present → paint at once, never waiting on the network; nothing cached, i.e. the first launch after a sign-in → the account's first pass, capped at 2s) (2026-08-04); occurrence scoping now works on **outside-shared calendars** — the scoped writes re-seal in the record's own key lane (`api.resealInLane`) instead of always using the household key, so the earlier blanket suppression (which traded the capability away to avoid locking collaborators out) is gone; **attachments now follow an override or a fork** via a new `POST /calendar/events/:id/attachments/copy-from/:sourceId` that duplicates rows and files without re-encrypting (the per-file key is household-wrapped), the file being copied rather than shared so a delete can't unlink the other event's attachment (2026-08-04); **a repeat-rule-only change saved silently** — the save-scope decision suppressed its sheet when the edit was made from the series' first occurrence (reasoning that "future" and "the whole series" are the same write there), which collapsed two separate concerns: the occurrence governs how a chosen scope is CARRIED OUT, never whether the user is asked; the sheet now always appears for a series-defining change and future-from-the-first is performed as an in-place series update (events, chores and tasks alike) (2026-08-04); a scoped save now lands the user on the record it created — an override/fork writes a NEW record, so the detail screen under the form stayed bound to the original id and showed the unedited event (reported: "saved this event only, the event view was unchanged, but the month grid had the change"); the form rebinds that entry to the new id + day on exit (`navigation/rebindDetailBelow.ts`), chore and task forms included (2026-08-04); **repeating events are scoped per occurrence on SAVE, not just on delete** — the edit form now shows the occurrence the user tapped (a repeating event's record holds the series' first day, so every occurrence had been titled and dated with the series start) and saving an edit asks Apple's "How should this change be applied?", offering Save for This Event Only / Save for Future Events for an occurrence-level field and Save for Future Events alone when the repeat rule or the calendar changed; the two writes are a detached override and a re-anchored series fork, both create-then-mutate with rollback; delete's prompt became an action sheet with Apple's wording to match; the save path also now carries `exceptionDates` through, without which every edit resurrected the occurrences the user had deleted; occurrence scoping is suppressed entirely on calendar-key-sealed shared events, which the re-seal would lock collaborators out of (2026-08-04); **the calendar arrangement survives a sign-out** — each calendar's colour, the display order, which are hidden, which built-ins were deleted and which have alerts muted were written only to AsyncStorage, and that cache is wiped at sign-out with the rest of the account keys, so every one of those choices silently reverted to the app default on the next sign-in (reported against a recoloured Chores calendar); they now persist on `User.calendarPrefs` via `PUT /settings` with the cache demoted to a warm read-through, adopted field-by-field on load (an absent field seeds the account from this device, a present-but-empty one is a real "cleared" value that beats the cache) and guarded so a local edit made while the fetch is in flight wins; the two view modes (month density, day-view mode) stay device-local by design (2026-08-04); **New Event opens with the cursor in the Title field** — the form's Title input takes `autoFocus` on a blank create (`!isEdit && !prefill`), so the keyboard is already up and the title can be typed without a tap; edit keeps its hands off (the title exists) and an assistant-prefilled draft does too, since that flow is a review pass over filled fields, not a typing one (2026-08-04); **switching grid density no longer rebuilds the grid** — `density` was part of the week-row cache's validity signature, so picking Compact/Stacked/Details flushed every cached row and re-derived the whole window synchronously on the frame the switcher popover was trying to animate closed (the expensive part being the spanning-bar pass, which scans every event and trip per row, and which is identical in all three densities); the row build is now split into a density-INDEPENDENT core (cells + bars, cached per week) and a pure arithmetic layer (`lib/monthGrid.weekLayout` → height, header height, whether the weather lane shows), with density moved out of the signature and into the cache KEY, so a switch re-expands nothing, re-scans nothing, and returning to a density already seen is a straight cache hit; the switch is additionally deferred a frame so the popover's dismissal paints first, matching the month/year jump sheet (2026-08-04); **the past edge no longer grows while the today pin owns the scroll position** — a prepend is compensated both by `maintainVisibleContentPosition` and by the pin's re-snap, and the two together walked the viewport back into the freshly prepended rows and prepended again, a runaway that swept the sticky header month (and the jump sheet's highlight, which reads the same row) through one month after another; the header row is now tracked by row KEY rather than index (a prepend shifts every index at once), and the pin does not scroll at all when today falls outside the window, since offset 0 is the past edge (2026-08-04); **the month-boundary rule is now an ordinary week rule, drawn only over the days the month owns** — the first row of a month block used to carry a full-width 1px `colors.primary` border, which both shouted (a coloured rule in a grid whose every other line is a `colors.border` hairline) and hung over the blank cells leading into the 1st; the row-level border is gone and each own-month day cell draws the standard hairline itself, so the line starts at the 1st (applies at every grid density — Compact, Stacked, Details — and in free viewer mode's `ViewerMonthGrid`) (46cd98a+, 2026-08-04); **the grid family now lays its weeks out as month blocks** — each month renders its own Sunday-first grid and blanks the neighbouring month's days, so a boundary week is rendered once per month and real whitespace separates one month from the next (the Apple Calendar layout, replacing the unbroken run of weeks that ran December straight into January); spanning bars and the weather lane clip at the boundary, the 1st carries the abbreviated month name in the app **primary** over the row's opening rule, and the sticky label / month jump / today anchor now key off the row's own block month instead of guessing it from the week's Wednesday; the geometry is pure and unit-tested in `lib/monthGrid.ts`, and `ViewerMonthGrid` carries the identical layout (2026-08-04); expanded-instance date-shape contract documented — `expandRecurringTaskChore` returns Date-valued `nextDueDate` for recurring items but passes one-time values through as strings (2026-08-04); follow-up: the shared `BottomSheet` now tears down **without** its exit animation when the CALLER drops `visible` (only a user dismissal — scrim/grabber-drag/back — slides out), because iOS refuses to present a second Modal while the first is still dismissing: picking **Custom…** in the event form's Alert or Second Alert picker closed the option list, never showed the dual-wheel sheet, and left an invisible modal window swallowing every touch on the event form (same class for the Repeat picker's Custom… which pushes a screen) (2026-08-02); **navigation presentation audit** — the app's four presentation idioms (push / modal / BottomSheet / headerless-with-floating-chrome) are now stated as rules in mobile/CLAUDE.md and applied here: the **Calendars manager** and the **Invitations inbox** changed from modal to **push** (both are browsable hierarchy, and Calendars drills four screens deep), **Print** changed from push to **modal** (finish-and-dismiss), every modal ✕ is now the shared `HeaderCloseButton` (28px, 8pt hitSlop, "Close" label — the hand-rolled 26px unlabeled ones are gone), `CalendarSearch` dropped its `#000` header + hairline divider for the standard `colors.background` + no shadow, and the shared `BottomSheet` gained a real slide-up, a grabber, and drag-to-dismiss (the date/time picker still commits the wheel's current value on any dismissal, drag included) (2026-08-02); 9282d82+ (2026-08-02); **the sources query's embedded snapshots now refetch on store change** — `['calendar','sources']`/`['viewer','sources']` embed `accessibleCustomIds` + `ownedAddonIds`, so a fetch racing ahead of the session's calendar-list refresh (or booting on a stale add-on cache) locked custom-calendar events and add-on lanes into the snapshot with no repaint path until an unrelated invalidation; `commitCustom` and `cacheOwnedAddons` now invalidate both query trees when their contents actually change, quiet on identical echoes (2026-08-02); 9282d82+ (2026-08-02); **fixed a silent data-loss defect in the D1 event re-seal** — `reSealEvents` rebuilt each migrating event's sealed payload from a hand-written 6-field list while `EVENT_ENC` seals 20, so every migration (first-share mint, revoke-rotation) DELETED the other 14 from the ciphertext (the plaintext columns were dropped at C3b, so nothing else holds them); the fatal one was `calendarType`, which lives only inside the sealed blob (the row's plaintext routing is `scope.resource`) and is what BOTH the owner's grid and the viewer's agenda bucket by — a re-sealed event was served fine, decrypted fine, and rendered on no calendar for anyone, which is why an outside-shared calendar came up empty for the collaborator; `reSealEvents` now seals `EVENT_ENC({ ...event, calendarType: resource })`, the reconcile pass groups candidates by `calendarType || scope.resource` so an already-stripped event is still found (grouping on the sealed field alone stranded it under a retired key), and a new owner-only `repairCalendarLaneEvents()` (run from `maintainKeyHygiene` as its OWN call — `reconcileCalendarKeys` early-returns precisely when there's no pending key work) restores `calendarType` from the plaintext lane for already-damaged events, idempotent and refusing to rewrite anything it couldn't decrypt; `allDay`/`recurrence`/`exceptionDates`/alerts/travel/`url`/`placeId` deleted by the old truncation are NOT recoverable (2026-08-02); **the D1 owner reconcile now runs on every unlock** — `maintainKeyHygiene` (→ `reconcileCalendarKeys`/`reconcileTripKeys`) moved from the relaunch-restore path into the auth store's keys-ready hook, fixing the fresh-login gap where an owner who signed out and back in never wrapped the CalendarKey for a newly accepted collaborator (their "waiting for the owner" state was permanent); free-viewer shells now **auto-accept** pending calendar shares (no viewer Accept/Decline — normative in billing-plans.md) (2026-08-02); **the Weather screen's "Where's home?" prompt now stands alone and clears itself** — the missing-address check moved into `isMissingHomeAddressError` (`lib/weatherSource.ts`, unit-tested), the 90-day seasonal outlook card is hidden while the prompt shows (it could only stack "Could not load seasonal outlook" under a card already asking for the address), the CTA passes `promptField: 'homeAddress'` so Account arrives highlighted, and saving a changed address invalidates the `['weather']` + `['homeAddress']` query trees so the still-mounted Weather screen behind Account re-fetches instead of showing its cached error again (2026-08-02); **switching between the grid family and List now preserves the viewed month in both directions** — each layer reports its visible month into a host ref (`viewedMonth`) and adopts it on becoming active (grid→List re-cursors the carousel, today selected when the adopted month is today's else the 1st; List→grid teleports via `jumpTo`, no-op when already there); List's former unconditional enter-on-today re-centre is retired (2026-08-02); the **List layer's month-label header is now the same month/year jump-sheet button** as the grid family's sticky header — the label + sheet pair extracted to a shared `MonthJumpHeaderButton` (exported from `MonthJumpSheet`); in List a pick teleports the month carousel via its cursor (tapped-day selection stays put, matching a swipe), and the button owns the sheet's open state outside the heavy calendar layer + defers the pick's jump one frame so the sheet opens/dismisses instantly (the grid additionally caches built week rows by underlying-input identity across window growth and renders them via a memoized `WeekRow`, so a jump only computes/renders the newly covered weeks) (2026-08-02); shared-lane key loading now covers the OWNER side too — `ensureCollaboratorCalendarKeys` became `ensureSharedCalendarKeys`: besides the member wraps for `mine:false` calendars it also loads the household wrap for the user's own calendars with `calKeyVersion > 0` (surfaced on the serialized calendar + `CustomCalendarRecord`), and it moved from `maintainKeyHygiene` (restored sessions only) to the auth store's keys-ready hook so it runs on EVERY unlock — fixes the owner's outside-shared calendar coming back EMPTY after sign-out/sign-in (the wiped replica re-pulled cal-scoped rows but nothing reloaded the CalendarKey: `reconcileCalendarKeys` skips steady-state calendars and `openOpaqueRecord` doesn't lazy-load resource keys) (2026-08-01); the month grid's fixed 12-month window (2 past + 9 future, inherited from the web initView) is retired — the grid scrolls an **unbounded month window**: opens last-month → +3 (`lib/calendarWindow.initialWindow`), grows 6 months at whichever edge the user nears (one extension per edge until it moves; upward growth anchored by `maintainVisibleContentPosition={{minIndexForVisible:1}}` so prepends don't jump), and the sticky Month-Year header label became a button (chevron-down) opening the **month/year jump sheet** (`MonthJumpSheet`: ‹ year › stepper + 3×4 month grid, visible month filled primary / today's month tinted; a pick grows the window via `ensureCovers` and snaps un-animated to that month's first majority week); the grid's load split into a range-independent sources query (`loadCalendarWindowSources`, `['calendar','sources']` — now also carrying the parsed ICS feed masters via `calendarFeeds.loadFeedSources`/`expandFeedSources`) + **synchronous render-time per-month expansions** (`expandCalendarRange` made sync; memoized per month in the grid, cache reset on sources change) merged by `lib/calendarWindow.mergeCalendarChunks` (identity dedup; unit-tested with the window math in `lib/__tests__/calendarWindow.test.ts`), with `loadCalendarData` now a thin composition of the two halves and the week builder bucketing items by date (O(1) cell lookups); the sync-derived shape replaced a first-cut per-month `useQueries` layer the same day — async chunk state made an event save re-key and re-fetch every month (whole-grid reload/skeleton flash); saving an event now repaints in one pass with one re-render (2026-08-01); collaborator half of D1 + server-side view-only enforcement (free viewer mode) — new `lib/calendarKeys.ensureCollaboratorCalendarKeys()` loads the member-wrapped CalendarKeys for calendars shared TO this user (`mine:false`) and re-pulls the record feed so shared events decrypt into the replica (runs from the viewer shell, on calendar-invitation accept, and from `maintainKeyHygiene` — previously nothing ever loaded a collaborator's member wrap, so shared events silently stayed ciphertext); `/records` now enforces calendar-lane write access server-side from the record's plaintext `scope` (POST/PUT/DELETE with a stored or incoming `scope.kind:'calendar'` require `full` effective access via `canWriteCalendarType`, 403 otherwise; stored scope gates a scope-less body; trips exempt) — superseding the C3b-era "enforcement moved to CalendarKey possession + the client" doctrine; `EventFormScreen` recomputes its read-only collaborator view from the calendar's `access === 'view'` (the server `readOnly` stamp is dead post-C3b); the locked-user viewer shell itself is specced in billing-plans.md "Free viewer mode" (2026-07-31); the calendar Outside-My-Household add field gained the contacts-roster autocomplete the household invite field already had (shared `hooks/useRosterSuggestions` + `matchRoster`, suggestions exclude staged outside entries / member emails / the owner; a tapped suggestion stages at View Only then runs the same lookup-gated outreach), placeholder now "Add name, email, or phone…", keyboard stays open across adds, a spinner replaces the add button during the account lookup, and the "They're on Calen" note clears on typing; the reveal-above-keyboard wrap was extracted to `components/ui.RevealWrap` and the event-invitee picker switched to it, fixing its silent no-op `useRevealOnOpen` call (null scroll context from the Screen-rendering component) that left the suggestion dropdown occluded by the keyboard (2026-07-30); the Add-ons storefront row on the Calendars view is now permanent — when every add-on is owned it no longer disappears but persists as the stable store/manage entry (HOUSEHOLD group's closing row) with subtitle "All add-ons added" instead of the catalog list, so the entry point keeps its learned location and future add-ons surface there (2026-07-30); the Event Action (call placement) screen shows the flat call price ("~N credits/min", from `billing/status.actionCosts.callPerMinute`) above the call CTA — pre-call cost transparency per billing-plans.md (2026-07-30); the Appointments built-in calendar's default colour is now blue `#1976D2` (was purple `#7B1FA2`) in both defaults maps (`lib/calendarPrefs.CALENDARS` + `lib/calendar.CALENDAR_COLORS`); device colour overrides are untouched, and the colour editor's reset now returns Appointments to blue (2026-07-29); `guestListVisible` and hand-set `cancelled` writes now go through client re-seal — the Invitees screen's guest-list toggle (`calendarApi.setGuestListVisible`) and both mark-cancelled surfaces (`calendarApi.cancelEvent`) re-seal the event via the replica instead of PUTting the field plaintext, which the opaque store rejects on an E2EE household with the misleading "update to the latest app version" error (the TestFlight-19 invitee bug); the event form also seals `guestListVisible` into every create/edit payload so the flag survives re-seals and syncs across devices (2026-07-29); calendar loading is now cache-first — `loadCalendarData` gained a `sync: 'inline' | 'background'` mode: the interactive views (month grid, List layer, day timeline/agenda, search) paint immediately from the local replica while `revalidateCalendar()` pulls records+settings+trips concurrently behind the paint and invalidates `['calendar']` only on actual change (deduped, 10s floor; trips reconciled into the replica including removals; grocery config cached device-local in `hc_grocery_settings`); a never-synced device falls back to inline; holiday chips render on mount independent of the data query; the month grid's first-load spinner was replaced with deterministic per-cell skeleton placeholders (per density) and the List layer's day list with `SkeletonList` (2026-07-29); deleting a recurring event offers Apple's "Delete This Event Only" (adds the occurrence's day to a sealed `exceptionDates` list the shared engine skips) vs "Delete All Future Events" (sets `recurrence.until` to the day before, or deletes the series when it's the first occurrence); shared by the detail view + edit form via `lib/eventDelete.ts` + `calendarApi.excludeOccurrence`/`truncateSeries` (HDK-sealed; outside-shared calendars not yet handled) (2026-07-29); event detail view now reflects every configured field — recurrence summary line ("Repeats weekly … until <date>", accent-coloured), a Travel Time row (duration + "Leave by" on timed events), and an Apple-style mini hour-grid timeline card placing the event block by its clock time (timed events only; all-day omits it), whose block content adapts to duration — >1h shows title+location+time, exactly 1h drops location, <1h shows title only; the "Delete Event" control is an Apple-style translucent floating pill **pinned to the screen** (a sibling of the scroll view, so it stays fixed while content scrolls beneath it instead of scrolling away attached to the map); the location map closes the scroll content below it (2026-07-29); the event detail view re-pulls the event on focus (`useFocusEffect`) so edits made in the form — e.g. turning off recurrence, which un-hides the Cancel/Reschedule card — are reflected on return without a manual refresh; the Cancel/Reschedule card moved to sit directly below the timeline card and above the Calendar row (was down among the alert/travel rows); its title shortened to "Cancel/Reschedule" (was "Cancel or Reschedule", which truncated in the one-line card title) (2026-07-29); Starts/Ends picker commits on dismiss (tap-away accepts) + start-time change past the end drags the end to preserve duration, and the symmetric reverse — editing the end (time or date) before the start drags the start back to preserve duration, via shared lib/datetime.startKeepingDuration reused by every Starts/Ends form (2026-07-28, reverse 2026-07-29); event detail view renders both alerts grouped in one divided card, with the Delete Event pill floating over the location map (2026-07-28); Birthdays→Occasions calendar (labeled contact dates as annual occasions), calendar-level occasion alerts, scheduled e-cards (2026-07-28); per-contact occasion exclusion (`occasionsHidden`) + occasion rows open PersonForm scrolled to Dates (2026-07-28); e-card recipients scoped to the occasion's contact + linked contacts, with inline add-email + per-recipient address picker for multi-email contacts (2026-07-28); scheduled-card indicator on the occasion row + edit/cancel + live email preview (2026-07-28); occasions render as kind icons (not chips) on the month grid and tap through to the Occasions screen from calendar/day/agenda surfaces (2026-07-28); a tapped occasion scrolls to the top of the Occasions list and is highlighted (`focus` param) (2026-07-28); e-card hour picker opens scrolled to noon (2026-07-28); e-card style gallery — 3 designs per occasion kind, greeting-card email with CSS-motion progressive enhancement, in-form style picker + animated live preview (2026-07-28); e-card personalization — fully editable card lines (greeting/sign-off/signature overrides), email-safe font menu, up to 3 inline CID photos (2026-07-28); default greeting + subject address recipients by first name only (2026-07-28); travel-time origin is an editable "starting address" (home-seeded, not labelled as home) with Current-location + Home one-tap shortcuts via shared `lib/currentLocation.ts` (2026-07-28); the two event alert slots must be distinct — each picker excludes the other slot's value (`excludeUsedAlert`) so the same lead time can't be set twice (2026-07-28); event attachments always seal on-device before upload (removed the plaintext fallback) and the server accepts iOS's relabeled opaque-binary content-types so the encrypted `.bin` ciphertext isn't dropped as "No file uploaded"; the event view previews attachments in-app via a WebView (images + PDFs render inline on the AttachmentPreview screen, Share button in the header) — WebView is used instead of RN's <Image>, which hard-crashes on the new architecture in both an RN <Modal> and a plain native-stack screen; expo-sharing alone (the interim fix) only gave the share sheet, not a direct preview (2026-07-29); the End Repeat (`until`) date loads back as the local Y-M-D via `ymd(new Date(until))` instead of slicing the ISO's UTC date, fixing a one-day-forward drift on every edit in behind-UTC timezones (2026-07-29); new events default travel time **on** only once the event location (destination) is set, then with the origin seeded from the user's current location, but only when location has already been shared with the app (`resolveCurrentAddressIfShared` reads the granted permission without prompting, and no GPS fix is taken until a destination exists); applied once so it doesn't override the user turning it back off; with no destination or no shared location the default is off; editing an existing event leaves its saved travel-time setting untouched; the Travel Time row shows "On" while enabled but not yet computed instead of "None"; the "Home" origin shortcut decrypts the E2EE-sealed home address client-side via shared `lib/homeAddress.ts` (2026-07-29); the Occasions empty-state CTA now reads "Add dates in Contacts" (was "…in People") to match the app-wide Contacts naming (copy-only) (2026-07-29); the Add-ons storefront row's subtitle names the full add-on catalog in store order with **no price** (every add-on, owned or not; the store screen does the selling) — spec + CalendarsScreen tests aligned to the shipped component, which dropped the earlier per-locked price line (2026-07-29); leaving the event form or its Invitees screen with unsaved edits (header ✕ / back / swipe-back / Android back) prompts an Apple-style "Discard Changes?" action sheet, guarded app-wide via the shared `useUnsavedChangesGuard` hook (listens on React Navigation `beforeRemove`; a successful save/delete/leave calls `allowLeave` to exit without prompting) (2026-07-29); editing an event **never** auto-changes its travel time — the debounced drive-time recompute is suppressed while the destination/origin still match what the event loaded with (a `travelSeedRef` snapshot), so merely opening a travel-enabled event no longer silently nulls-and-refetches its saved minutes (which also spuriously dirtied the unsaved-changes guard); recompute resumes only once the user actually edits the destination or starting point (2026-07-29); the pushed **Travel Time** sub-screen now carries a header ✓ checkmark (+ ✕ close) like the app's other form sub-screens — edits already sync back live via the travelDraft store, so the checkmark just confirms/returns (2026-07-29); do-not-call is now surfaced on both call screens — the Event Action screen pre-checks the event's number (`GET /calls/suppressed`) and disables the call button with a reason when it's suppressed, and the Interaction outcome view shows an explicit "asked not to be called again" notice driven by the per-call `dncCaptured` flag (2026-07-29); the Cancel/Reschedule card now appears on **recurring** events too, scoped to the tapped occurrence — the call carries `PhoneCall.occurrenceDate` (the occurrence's local Y-M-D) + that day's start instant, and the call-derived cancelled/reschedule dimming is re-keyed from series-id to event+occurrenceDate (`lib/callStatus.buildEventStatus`, consumed across the month grid / day timeline / agenda / list / detail), so one call dims only its own instance; unscoped/legacy calls still match every day; the series-wide "Mark appointment as cancelled" fallback is hidden on recurring occurrences (2026-07-29); the card moved to be the first row of the details group (directly above the Calendar card) and its title relabelled "Reschedule/Cancel" (was "Cancel/Reschedule"); the two idle states (no-phone / ready-to-call) dropped their explanatory subtitle so the row is a clean single-line "Reschedule/Cancel" button (2026-07-29); tapping the card with no business number yet routes to the Location view with a `promptPhone` flag that shows a prominent callout banner at the top ("Add a business phone number to activate calling.", styled per the app's tinted-banner convention and tinted with the event's own calendar colour rather than the app primary — was a muted hint that blended in) and highlights the phone field (2026-07-29); calendar-share email invites (AddCalendarScreen outside-share) now compose via the shared mail-app chooser (`useEmailComposer`/EmailAppSheet — behavior specced in households-sharing.md) instead of a bare `mailto:` (2026-07-29); clearing the event location now switches travel time **off** (and drops the saved/computed drive time) on both the add and edit forms — travel time is anchored to the destination, so removing the destination removes travel time; only ever turns it off, so it can't fight the user re-enabling it (2026-07-29); accepting a cross-household event invitation now seals the recipient's **own** copy on-device (client-minted `_id` + HDK-sealed `enc` with `invitationId` folded in) and posts that to `POST /invitations/:id/accept`, matching the C3b server contract — the mobile client previously posted the bare plaintext snapshot `{ event }`, which the opaque store rejects with "A sealed event copy (_id + enc) is required", so accepting any sealed invite in-app failed; a locked vault now surfaces an "unlock your vault" message instead (the seal is factored into `lib/invitees.sealAcceptedCopy`, unit-tested) (2026-07-29); the organizer's device now actually forwards `guestListVisible` on every `invitationsApi.send` (sealed/plaintext/SMS lanes, via `sendInvitations`) — it was previously never sent, so the per-invitation flag always defaulted to visible and the "Guests can see guest list" toggle was a silent no-op (recipients always saw the guest list regardless of the switch) (2026-07-29); the Starts/Ends duration-keeping rule is now symmetric in both directions — editing the **start** (time or date) to at/after the end pushes the **end** forward to preserve the span (new `lib/datetime.endKeepingDuration`/`endTimeKeepingDuration`, mirrors of `startKeepingDuration`/`startTimeKeepingDuration`), so the end is never left before the start on the event form, the trip and trip-item/journey forms, and the cancel/reschedule time windows (closing an equal-date hole where advancing the start date onto the end's day previously produced end-before-start) (2026-07-29); the event-detail mini timeline card is now a **compact, fixed-size window** (`TIME_CARD_MAX_HOURS = 3`, opening ~1h before the event) so a long event no longer stretches the card into a wall of hours — an event longer than the window overflows it and has its block **clipped at the card's bottom edge** (`blockBottom = clipped ? canvasH : y(endDec)`) while the block's start–end text keeps the true end time (2026-07-29); event invite outreach is now device-composed end-to-end (households-sharing.md policy): the server `event_invitation` email is retired — `POST /invitations` instead pushes account-holder recipients (title-free for sealed invites) and the organizer's device composes the .ics-link email for non-account invitees via `sendInvitations` + the mail-app chooser (`eventInviteEmailContent`, sealed invites get a notice-only body since their public .ics 404s); `GET /invitations/lookup` also accepts `phone` (existence only); the Invitees screen's pending email rows gained a paper-plane Remind; calendar outside-shares now skip the composer for account-holder recipients (lookup-gated, fail-open) with their own row Remind (2026-07-29); the shared calendar engine gained `deriveAvailability` — a free/busy reduction over already-expanded events + trip overlays (timed events → busy hour-blocks, trips → whole "away" days, all-day events → a soft note that keeps the day free, and tasks/chores/meals/grocery excluded as non-occupying) consumed by the calendar assistant's new `get_availability` tool; the busy/free rule and its waking-window/timezone handling are specced in [ai-assistant.md](ai-assistant.md) (2026-07-30); the event Location view's `promptPhone` callout now renders via the shared `components/ui.SetupCallout` (extracted from its inline banner, still tinted with the event's calendar colour — behavior unchanged), and the calendar assistant can now route the user to it itself via a `setup_event_phone` setup chip when it needs a number to call an event about (see ai-assistant.md) (df8c7f3+, 2026-07-31); the calendar assistant's **edit and delete now actually work on mobile** — the `open_edit_event_form`/`delete_event` tools stage the action for a device-side confirm tap (an "Open the event to edit" chip opening the native `EventForm`, or a single "Delete from my calendar" chip that batch-deletes the staged events through the shared `lib/eventDelete` `assistantDeletePerform` — one-off delete, or recurring exclude-occurrence vs delete-series) instead of the old web `navigateTo` route the RN app silently dropped (which left forms un-opened and events un-deleted while the model falsely reported success); behavior specced in [ai-assistant.md](ai-assistant.md) (df8c7f3+, 2026-07-31); the event **Location view** was reworked from a search field stacked over an always-visible Name/Address/Phone form (two competing input models, and a picked place's Google address duplicated the name into the Address field) into a **single-input-model state machine** — Empty (search + "Enter an address manually" escape hatch), Picked (the resolved place collapses into a read-only card: static map, name, and the address on its own line with the leading business name stripped, plus an ✕ to change it), and Manual (Name/Address fields + "Search for a place instead" back-link, entered automatically for a saved location that has no place_id); the business phone stays an editable field in all three states; storage is unchanged (single de-duplicated `location` string + `placeId` + `phone`) (df8c7f3+, 2026-07-31); the calendar's floating chrome was **re-hierarchized by priority** — the bottom-left pill became a labelled **Today | Calendars** pair (Calendars promoted from an ambiguous calendar-glyph icon to a text label), the assistant entry was promoted from a pill icon to a standalone 56pt **Calen FAB** alone in the bottom-right corner (surface disc, gradient C at 28pt, one shadow step above the pills) — the screen's single primary action — and the `fromAssistant` "‹ Calen" return pill moved from the avatar slot to the FAB slot (the avatar stays put — see ai-assistant.md); the **Invitations inbox lost its floating button entirely** (month and day views; `components/InvitationsButton` deleted): it is event-driven, not frequency-driven, so its entry point moved to a badged **Invitations row in Profile** and the count now cascades — calendar avatar badge (E2EE-locked "!" takes precedence, else the pending count, 9+ cap) → Profile's Invitations row (same count) → the inbox; the "New"-tab counting rules were extracted to `hooks/useInvitationsCount` (df8c7f3+, 2026-07-31); occasion contacts hidden via `occasionsHidden` are now **omitted entirely** from the Occasions list (the old dimmed "Hidden from calendar" group was removed — they were already skipped everywhere else), and the list's `Hint` shows only when occasions exist while the empty state gained a clear "add a date to a contact" message; the copy now treats birthday as one of the contact's dates (birthday was merged into the person form/detail dates card) and says "contacts", not "People" (df8c7f3+, 2026-07-31); e-cards are now **one-time** — a card sends on its next upcoming occurrence then deactivates (`ECard.active`/`sentAt` replace the old annual `lastSentYear` guard in `runECardCheck`), the form hint reads "Sends once on `<next date>`", and the E2EE plaintext-exception disclosure is shown at **create time only**; the e-card recipients card gained an **"Add a related contact"** row that opens the occasion contact itself (`PersonForm` `focus: 'related'`, scrolled to Related names) to manage the link — the newly linked contact then appears as a recipient candidate automatically on return (recipients = the occasion contact + their related names) — and the editable card lines gained a visible edit affordance ("Tap to edit" pencil badge — tapping it focuses the greeting line with the caret at the start — plus dashed underlines); the **Print** month-grid layout now wraps event titles to **2 lines** (CSS line-clamp, no more one-line ellipsis) and prints **compact 12-hour times** ("1PM") with a Print-screen **24-hour clock** toggle ("13:00"); the **Subscribe** screen gained an optional email-driven **provider helper** (detect Gmail/iCloud/Outlook → deep-link to their calendar-link settings + steps; the user still pastes the URL); the **Calendars view** rows show a **leading** Apple-style on/off circle carrying the calendar's colour (filled check-circle shown / empty dimmed circle hidden), replacing the old leading accent bar; the per-country **Holidays editor lost its "Remove <country>" danger button** (removal stays available via Calendars → Edit Calendar → Delete); and the modal-presented **Attachment/Place preview** screens gained a top-left close ✕ (df8c7f3+, 2026-07-31); the day view (single/multi-day all-day lane + List agenda) now renders date-only **chores** as Chores-calendar items — tinted in the Chores calendar colour and badged with the chore's own MaterialCommunityIcons glyph (`AllDayItem.icon`, sourced from `Chore.icon`), replacing the muted empty-circle reminder chip; date-only **tasks** keep the muted dot (df8c7f3+, 2026-07-31); the day-view icon treatment was extended to **events** (a generic calendar glyph, `EVENT_ICON = 'calendar-blank-outline'`) and **occasions** (their `occasionIcon` kind glyph) — both the all-day lane chips and the List agenda rows now lead with the colour-tinted glyph instead of a plain colour bar (the timed hour-grid blocks are unchanged); and the **List** view gained a **"Today" divider marker** above today's header (accent lines + label, mirroring the Occasions view), with today always kept as a section when it's in-window (even empty, unless the whole window is empty) so the marker anchors the list (df8c7f3+, 2026-08-01); the List view's explicit **"Load earlier"** button was replaced by **infinite scroll upward** — scrolling within `EARLIER_THRESHOLD` (80px) of the top prepends the previous `EXTEND_DAYS` stretch, anchored by `maintainVisibleContentPosition={{minIndexForVisible:1}}` (new-arch default) so content grows above the viewport without a jump; a `loadingEarlier` ref guards re-fires until `window.start` moves, and a fixed-height header spinner shows while it settles (the scroll-restore `scrollToLocation`/`onScrollToIndexFailed` dance was removed) (df8c7f3+, 2026-08-01); the **Occasions list** was reworked from a flat forward-only run (every occasion shown at its next occurrence, so a just-passed date silently jumped to the bottom ~12 months out and there was no sense of the window being viewed) into a **today-anchored timeline** — `lib/occasions.collectOccasions(people, now?)` anchors each occasion to the occurrence nearest today and returns a signed `offset` (recently-passed within `PAST_WINDOW_DAYS` (7) → negative, today → 0, else next upcoming → positive), and the screen renders **Recently observed** (dimmed, no schedule prompt, "Sent" pill when its one-time card already went out), a **"Today · `<date>`"** marker, **Coming up** (the highlighted `COMING_UP_DAYS` (60) plan-ahead horizon carrying the e-card envelope), and a collapsed **"Later this year (N)"** tail (auto-expanded when a calendar-tapped focus occasion lives there); `whenLabel` gained past phrasings ("Yesterday" / "N days ago"); windowing extracted from OccasionsScreen into `lib/occasions.ts` + unit-tested (`lib/__tests__/occasions.test.ts`, injectable `now`) (df8c7f3+, 2026-07-31); the redundant **`marriage`** date-label preset was dropped — `anniversary` is now the sole wedding label offered in the contact date-label picker (`DATE_LABELS`), though the shared engine still recognises a legacy `marriage` label on pre-existing contacts (kind/noun/icon/e-card templates for it are retained for backward compatibility) (df8c7f3+, 2026-07-31); the **thunderstorm** weather icon composite was rebuilt on the Rainy pattern — only the glyph's lower band is rendered (blue base for the drops + a gold centre strip for the bolt) under the standard white cloud, with band/strip positions measured from the Ionicons TTF and an explicit `width: size` on every clipped inner glyph (an RN Text measures at most its parent's width and iOS clips the glyph to the Text's own bounds, which had made narrow clip windows show the wrong glyph slice — the gold right drops + stray blue cloud edge of the first attempt, then the gold bolt strip rendering nothing) (df8c7f3+, 2026-08-01); the event form's **Title** field now declares `autoCapitalize="sentences"` explicitly so the keyboard opens shifted and the first letter of a new or edited title is capitalized without reaching for shift (df8c7f3+, 2026-08-02); the **calendar-name** field on New Calendar and Subscribe now dismisses the keyboard on Done (explicit `onSubmitEditing` → `Keyboard.dismiss()`) — the name is the only typed step on either screen (everything below it is tapped), and the platform blur-on-submit default was leaving the keyboard up over the sharing/colour rows (9282d82+, 2026-08-02); **holiday alerts** — the holidays editor gained the Occasions view's notifications button, opening a new **Holiday Alerts** screen (Alert / Second alert / Alert at) whose one config is shared by every holiday calendar the user has; device-local, default OFF, muted per-calendar by that calendar's Alerts switch, fired on-device (see notifications.md) (46cd98a+, 2026-08-04); **a record write now invalidates the `['calendar']` queries at the CRUD chokepoint** — `lib/recordStore` already mirrored every create/update/delete into the replica the calendar assembles from, but nothing told the cached sources query to re-read it (30s `staleTime`, no refetch-on-focus, grid mounted as a tab), so an editor had to remember `invalidateQueries(['calendar'])` and the person form didn't: editing a contact's occasion dates repainted the Occasions list (`['people']`) while the month grid kept the pre-edit dates until the next sync pass; `recordStore` now invalidates after mirroring a write to a calendar-bearing collection (`CalendarEvent`, `MaintenanceTask`, `Chore`, `Person`, `RecipeSchedule`), coalescing bursts (bulk contact import) into one pass (46cd98a+, 2026-08-03); **a timed event no longer walks its start date forward one day per edit** — the event form read a loaded event's clock time in the device's LOCAL zone but took its calendar date by slicing the stored ISO string, which is UTC, and west of UTC a late-evening event has already rolled over (Aug 3 11:05pm EDT = Aug 4 03:05Z), so opening an 11:05pm event showed Aug 4, saving wrote Aug 4 11:05pm, and every further edit→save cycle stepped it one more day (the end, read the same way, stayed put, so the event also looked spuriously multi-day); the storage convention — all-day at noon UTC and read in UTC, timed as a real instant and read entirely in local — is now encoded once as the exact-inverse pair `eventWhenFromStored` / `eventStoredFromWhen` in `lib/calendar.ts` that the form uses in both directions, so a load→save round-trip is a fixed point (unit-tested over repeated cycles under a pinned `America/New_York`), and a same-local-day end folds back to a blank End date instead of reading as multi-day (46cd98a+, 2026-08-03); **recurring chores and maintenance tasks now repeat across the month grid** — the grid expands one chunk per month and folded them together with `mergeCalendarChunks`, which keyed tasks and chores on `_id` ALONE, so a repeating chore's twelve occurrences (same `_id`, different due dates) collapsed to whichever chunk expanded first and the chore appeared on exactly one day; the day view expands a single un-chunked range, which is why it showed the repeats all along; the merge now keys them on `_id:_instanceDate` (the stamp the shared engine puts on every expanded instance), falling back to a normalised `nextDueDate` — read through `new Date()`, since that field is an ISO string on a passed-through one-time item and a Date on a generated instance (c2d18c0+, 2026-08-04); **the two calendar-level alert configs (Occasions + holidays) are now ACCOUNT settings** — `User.occasionAlerts` / `User.holidayAlerts`, carried on `GET`/`PUT /settings`, with the AsyncStorage keys demoted to a cache: that cache is account state wiped at sign-out, so holiday alerts a user set read back fine all session and were silently off again at the next sign-in; edits now write both, load adopts the account's config (rescheduling the window when it differs), an account with no config is seeded from a device holding a non-default one, and `offsets: []` stays a real "off" distinct from an unconfigured `null` (c2d18c0+, 2026-08-04); keyboard-capitalization hints follow the app-wide input convention (mobile/CLAUDE.md): the calendar search field sets `autoCapitalize="none"` + `autoCorrect={false}`, the e-card signature line sets `autoCapitalize="words"` + `textContentType="name"`, and the event Title keeps the platform default `sentences` (2026-08-10); **event travel time gains transportation methods** — the travel-time view had exactly one answer (a traffic-aware drive), so anyone walking, cycling or taking the bus got a number that was simply wrong; the Travel Time sub-screen now opens with a four-way mode row (Drive / Walk / Transit / Bike, icon-only glyphs shared with the trip timeline's travel pills, the active mode sat in an Apple Maps-style tinted capsule, the rest bare glyphs) shown while no manual duration is set, the chosen `travelMode` rides sealed beside `travelMinutes`, and changing it recomputes exactly like editing the destination or origin does (same debounce, same never-on-open seed rule); `GET /places/travel-time` accepts `mode` + `departureTime` and now routes through the shared `routeLeg` service instead of its own hardcoded DRIVE call, which buys transit for free — schedule-aware via the Directions API with the event's start as the departure anchor (an estimate computed at midnight for a 9 AM meeting must read the morning timetable, not the night one) and a named "No transit route found" 404 where Google has no coverage; records without a mode (pre-mode saves, manual durations) read as drive times everywhere, and the mode is named on the form row and detail subtitle ("45 min · Transit · Leave by 8:15 AM") only when auto-computed and not driving — a drive time saying "Drive" is noise (2026-08-10) **Meals now read as meals on every calendar surface** — a scheduled meal rendered as the literal word "Recipe" everywhere (month grid, List, day view, search), because the content-blind record store returns a bare `recipeId` and nothing re-populated the ref; `loadCalendarSources` now joins each schedule's title out of the Recipe replica (`lib/mealSchedule.populateRecipeRefs`) and `Recipe` joined `recordStore`'s `CALENDAR_COLLECTIONS` so a rename repaints the grid; the day view's all-day lane also badges meals and the shopping day with the shared `RECIPE_ICON`/`GROCERY_ICON` (`lib/calendar`), the four surfaces that each spelled the glyph names out now share those constants, and the grocery cart passes `scrollToDate` alongside `pane`/`weekStart` so flipping to the Meal Planner lands on the shopping day, highlighted; the day view's grocery chip also stopped being a hard-coded yellow (`GROCERY_COLOR`, whose comment claimed it matched a month-grid tint that never existed) and now takes the Meals calendar's colour like every other surface (2026-08-10).
code:
  - mobile/src/screens/calendar/
  - mobile/src/components/CustomAlertSheet.tsx  # the Alert pickers' "Custom…" wheel sheet
  - mobile/src/lib/calendar.ts
  - mobile/src/lib/calendarData.ts
  - mobile/src/lib/calendarWindow.ts       # unbounded month-window math + per-month chunk merge
  - mobile/src/lib/monthGrid.ts            # month-block geometry (Apple-style blocks) + boundary bar clipping
  - mobile/src/lib/eventRepeat.ts
  - mobile/src/lib/occasions.ts            # occasion kind → title/icon/noun + list windowing (collectOccasions)
  - mobile/src/lib/recordStore.ts          # CRUD chokepoint: mirrors writes into the replica + invalidates ['calendar']
  - mobile/src/lib/recordSocket.ts         # poke-and-pull: the record-change WebSocket client (reconnect/backoff)
  - mobile/src/lib/pushSync.ts             # silent-push background replica sync + the foreground dirty flag
  - mobile/src/hooks/useRecordSync.ts      # mounts the socket + background task + foreground revalidate
  - server/src/services/recordChanges.js   # the poke bus: coalesced pokes, silent-push debounce, Mongo change stream
  - server/src/services/recordSocket.js    # /api/records/ws — the authenticated poke WebSocket endpoint
  - mobile/src/lib/householdRsvp.ts        # in-household invitees: request derivation, EventRsvp writes, notify relay calls
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
  - server/src/test/eventAttachments.integration.test.js
  - server/src/test/calendarKeys.integration.test.js
  - server/src/test/invitations.integration.test.js
  - shared/calendar/index.test.js
  - server/src/test/ecards.integration.test.js
  - server/src/services/ecardTemplates.test.js
  - mobile/src/lib/__tests__/{calendarData,calendarFeeds,calendarPrefs,calendarWindow,monthGrid,holidays,homeRegion,weatherSource,recurrence,tz,printCalendar,addons,occasions,recordStore,eventWhen,occurrenceShift,eventSave,eventAlerts,householdRsvp,recordSocket}.test.ts
  - server/src/test/recordPoke.integration.test.js
  - mobile/src/navigation/__tests__/rebindDetailBelow.test.ts
  - mobile/src/screens/calendar/__tests__/CalendarsScreen.test.tsx
  - mobile/src/screens/calendar/dayview/__tests__/dayViewLayout.test.ts
  - mobile/src/screens/viewer/__tests__/ViewerMonthGrid.monthRule.test.tsx
  - mobile/src/components/__tests__/customAlertSheet.test.tsx
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
- **Title autofocus:** opening **New Event** focuses the Title field and raises
  the keyboard, so the title can be typed without a tap. It applies to a blank
  create only — **Edit Event** does not steal focus (the title is already
  written), and neither does a create prefilled from the assistant's draft
  ("Edit in form"), where the user is reviewing the filled fields rather than
  typing a title.
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
  button all commit it; there is no discard-on-tap-away. The two endpoints
  follow an asymmetric rule — **the start moves the event, the end sets its
  duration** — and the end is never left before the start.
  - Editing the **start** (time *or* date) **always carries the end with it** by
    the same amount, in either direction, so the duration is preserved (9–10am →
    start 8am becomes 8–9am; start 2pm becomes 2–3pm). If the shifted end
    crosses midnight its **date** rolls to the next day, and it folds back to a
    same-day end when it lands on the start's own day. Changing the duration is
    the end field's job.
  - Editing the **end** (time *or* date) **changes the duration** — the start
    stays put — except when the new end lands at/before the start, which drags
    the start back by the same amount so the gap survives (8–9am → end 4am
    becomes 3–4am; if the shifted start crosses back over midnight its date
    rolls to the previous day).

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
- **An occurrence is opened, not the series.** A repeating event is ONE stored
  record whose `startDate` is the series' *first* day, but the user always arrives
  from a calendar cell. Both the detail view and the edit form therefore display
  the **occurrence they were opened from** (`date` route param) — the series' when
  shifted onto that day, preserving the clock times and any multi-day span. The
  shift is exact and reversible (`lib/calendar` `occurrenceShiftDays` /
  `shiftEventWhen`): a timed event keeps its wall clock across a DST boundary, an
  all-day event stays pinned to noon UTC. A save that rewrites the whole series
  MUST shift back first, or saving from the third occurrence would drag the entire
  series onto that day. With no occurrence day (opened from search) the shift is 0
  and the series start is shown.
- **Deleting a recurring event** (from the detail view's Delete Event control or
  the edit form's Delete) is an **Apple-style two-way choice** — a native action
  **sheet** titled "Are you sure you want to delete this event? This is a repeating
  event." offering **Delete This Event Only** and **Delete All Future Events**
  (a one-off event keeps the plain single-action confirm, "Delete Event"). It is a
  sheet rather than an alert because both outcomes are destructive, which an
  alert's two-button shape can't express; Android falls back to the equivalent
  alert. The occurrence the choice acts on is the calendar day the user opened the
  event from (the screens' `date` route param; absent — e.g. from search — it falls
  back to the series start). *This Event Only* adds that day (`YYYY-MM-DD`) to the
  event's **`exceptionDates`** list, which the shared engine skips on expansion
  (Apple's EXDATE); the day key matches the calendar's per-cell bucketing (all-day
  = UTC date, timed = local date). *All Future Events* ends the series the day
  before the occurrence by setting `recurrence.until` (past occurrences stay), or
  **deletes the whole event** when the occurrence is the series' first (nothing
  precedes it). The server can't edit sealed content, so both re-seal the whole
  event through the store (`lib/eventDelete.ts` builds the prompt;
  `calendarApi.excludeOccurrence` / `truncateSeries` re-seal).
- **Saving an edit to a recurring event** asks the same way, via an action sheet
  titled **"How should this change be applied?"** The choices offered depend on
  **what was edited**, not on the user's intent:
  - A field that describes the **occurrence** — title, notes, date/time, all-day,
    location, alerts, travel time, URL, phone, invitees — offers **Save for This
    Event Only** *and* **Save for Future Events**.
  - A field that defines the **series** — the repeat rule itself (frequency,
    interval, End Repeat, turning repeat off) or the `calendarType` — offers
    **Save for Future Events** alone: neither can mean anything for a single day.
  - A **mixed** edit takes the most restrictive answer (series-defining wins).
  - **No sheet at all** when: the event doesn't repeat; the occurrence was already
    detached by a previous *This Event Only* (an override has no recurrence of its
    own, so it edits like a one-off); the event is sealed under a shared calendar's
    key (below); or nothing actually changed (the form's own dirty flag decides,
    not a payload diff — a timed event with no stored end acquires a default one on
    the way out and would otherwise prompt on an untouched save).
  - **Which occurrence the user is on never suppresses the sheet.** A
    series-defining edit made from the series' *first* occurrence resolves to the
    same WRITE as a whole-series rewrite, but the user is still applying a change
    to every future event and MUST still be asked — Apple asks. The occurrence
    governs how a chosen scope is carried out, not whether the question is put:
    "Save for Future Events" picked on the first occurrence is performed as a
    plain in-place series update, because truncating the original there would
    leave an empty husk beside the fork. Collapsing those two concerns is what
    made a repeat-rule-only change save silently with no prompt at all.
  - **Cancel** leaves the user on the form with the edits intact.

  *Save for This Event Only* creates a **detached standalone event** on that day
  (no recurrence, no exceptions of its own) and adds the day to the original's
  `exceptionDates`. *Save for Future Events* **forks the series**: the original is
  truncated with `recurrence.until` set to the day before the occurrence, and a new
  event carrying the edits starts on the (possibly moved) occurrence day. Both are
  two writes with the create first and a **rollback** — if the second write fails
  the created record is deleted, because the half-applied states are a duplicate on
  one cell and a doubled series respectively.

  **A scoped save must land the user on what they saved.** Both scoped writes
  create a NEW record, so the detail screen sitting under the edit form is still
  bound to the ORIGINAL event id and day. Returning with a plain `goBack()` shows
  the *unedited* event — and after an override, an occurrence the series no longer
  has — which reads as "my changes didn't save" even though the month grid (which
  reads the store, not a route param) shows them. The form therefore **rebinds that
  underlying detail entry** to the new id and day as it exits
  (`navigation/rebindDetailBelow.ts`, with a fresh route key so the screen
  remounts rather than reusing the old record's queries). A whole-series save is
  unaffected — it rewrites the record in place, and the detail view's
  refetch-on-focus already covers it. The same rule applies to the chore and task
  forms, which fork the same way.

  A fork **re-anchors** the repeat rule (`lib/eventSave.reanchorRecurrence`): move a
  weekly Thursday event to Friday and the new series repeats on **Friday**. Only an
  anchor that *matched the old start* is re-pointed — a single-day `daysOfWeek`, a
  single `daysOfMonth`, a single `months`, or a `weekOfMonth`+`weekdayKind` pair
  that described the old start (where "last <weekday>" survives only if the new day
  is also the last of its kind, else it degrades to the plain ordinal). A rule the
  user authored by hand — Mon/Wed/Fri, the 1st and the 15th — is left as written.
  Inherited `exceptionDates` are split at the fork day and **shifted by however far
  the occurrence moved**, since a skipped day is relative to the series it belongs
  to.

  **Attachments follow the new record.** They hang off the event id, so an override
  or a fork would otherwise start with none — and a fork *becomes* the ongoing
  series, silently dropping the files from every future occurrence. Both scoped
  saves call `POST /calendar/events/:id/attachments/copy-from/:sourceId`, which
  duplicates the rows and the files. Nothing is re-encrypted: the per-file key is
  wrapped to the **household**, not to the event. The FILE is duplicated rather
  than sharing a `storageKey`, because DELETE unlinks the file and a shared key
  would take the other event's attachment with it. A failed copy never rolls back
  the save — it is reported ("Attachments didn't copy").
- **Occurrence scoping re-seals in the record's own key lane.** An event on an
  outside-shared calendar is sealed under that calendar's key (`enc.ks === 'cal'`)
  so collaborators can read it; the household key would lock them out. Every
  occurrence-scoped write therefore goes through `api.resealInLane`, which reads
  the stored record's `enc.ks` and seals with `sealForCalendar` when it is `cal`,
  falling back to the household key when the CalendarKey isn't held — the same
  branch a full save already takes. Shared-calendar events consequently get the
  **same prompts as any other**; withholding the capability from them (the earlier
  behaviour) traded a feature away instead of fixing the write. `setGuestListVisible`
  and `cancelEvent` route through the same helper.
- **Occurrence-scoped writes never lose deleted occurrences.** The event form seals
  the payload wholesale, so it MUST carry `exceptionDates` through on every save;
  omitting them resurrects every occurrence the user had removed with *Delete This
  Event Only*. They are dropped only when the event stops repeating.
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
- **Clearing the first alert promotes the second into its place** (`promoteSecondAlert`),
  carrying that alert's own anchor up with it and leaving the second slot empty.
  The Second Alert field renders only while a first alert exists, so anything else
  is wrong in one of two ways: leaving the second set behind the now-hidden row is
  an alert the user can neither see nor edit (and one that reappears the moment
  they set a first alert again), and silently discarding it throws away a setting
  they never withdrew. The rule holds however the first alert is cleared — the
  picker's "None" row **and** an assistant patch — and an event loaded with only a
  second alert set (written before this rule) opens with it promoted.
- **An alert's lead time is anchored either to the event or to departure, and
  which one the user chose is stored — never guessed back from the number.** On a
  timed event with a drive time (see Travel time below), each picker offers
  departure-anchored rows above the plain ones — **Time to leave (clock time) /
  5 / 10 / 15 / 30 min before leaving** — alongside **At time of event / 15 min /
  30 min / 1 hour / 1 day before**. Both framings are STORED the same way, as
  minutes before the event (leaving early = `travelMinutes` + buffer), so
  scheduling, the record and the seal are unchanged; `alertAnchor` /
  `alert2Anchor` (`'event'` | `'leave'`, defaulting to `'event'`) record only
  which framing the setting was made in. That flag is load-bearing because a
  single number names both: with a 23-minute drive, "2 hours before" and "1 hr
  37 min before leaving" are the same instant. Inferring the framing from the
  number — treating any value at or past the drive time as departure-anchored —
  showed the user back a setting they never made, and only canned values escaped
  it (a custom 2 hours re-read as "1 hr 37 min before leaving" while 1 hour, a
  canned row, read correctly). The pickers are therefore keyed by
  **anchor + minutes**, not by minutes, so the two framings of one instant are
  distinct rows; the *distinct alerts* rule above still compares the resulting
  **minutes**, so the two slots can never land on the same instant. A
  departure-anchored alert **follows the drive time**: recomputing or editing it
  keeps the alert the same distance before the NEW departure. Losing the anchor's
  basis — All day switched on, travel time switched off, the location (and with
  it the drive time) cleared — leaves the stored lead time exactly as it is but
  drops the departure framing, since there is no departure left to describe. An
  event saved before the flag existed is read back by `inferAlertAnchor`: only
  the canned departure rows (`travelMinutes` + 0/5/10/15/30) count as
  departure-anchored, so those keep their wording and every other value reads as
  what it literally is. The detail view labels both alerts through the same rule.
- **The custom alert sheet offers the same choice, at minute granularity.** Its
  amount wheel + unit control (Minutes / Hours / Days) is joined by a second
  segmented control — **Before leaving / Before event**, departure first —
  whenever the event has a drive time; the canned rows offer both framings, so
  the custom row must too, or a custom lead time is silently event-anchored and
  then re-worded against the drive time. On a slot holding **no alert yet** the
  sheet opens on **Before leaving**: once a drive time is attached, when to leave
  is what it was attached for. A slot that already holds an alert opens in **its**
  framing instead, so re-opening the sheet on a "2 hours before" alert and
  tapping Done can't quietly turn it into two hours before *leaving*. The Minutes wheel runs to **180**, not 59: the Hours wheel is whole
  hours only, so a 59-minute cap left every in-between lead time (90 minutes,
  2½ hours) unreachable from either unit. **Tapping a unit starts that unit at
  its own default** — 30 minutes / 2 hours / 2 days — rather than carrying the
  previous unit's number across: clamping 30 into the hours range landed the user
  on *23 hours*, the far end of the wheel, for a tap that should read as "now
  pick some hours". Only an explicit unit tap resets; opening the sheet on a
  saved value still shows that value. A departure-anchored value seeds the
  wheel with its **buffer** — the number the user actually set — not the stored
  minutes-before-event. On an all-day event the sheet is fixed to Days and
  neither the unit nor the anchor control is rendered.
- **Dismissing the custom sheet keeps the lead time; it is a picker, not a
  form.** A scrim tap, a drag down, or Android back saves exactly what Done
  saves — whatever the wheel is showing — matching the Starts/Ends pickers,
  which have committed on dismissal since 2026-07-28. Requiring **Done** made
  "dial 45 minutes, tap away" discard a setting the user had already made, and
  the field then read back as the alert they'd just replaced (or None). The one
  exception is a sheet **nothing was touched in**: the wheel always shows a seed
  (30 minutes, or the field's current value), and a sheet opened and dismissed
  without moving a control writes nothing, so a stray tap on **Custom…** can't
  put a 30-minute alert on an event that had none. Done still commits even
  untouched — it is an explicit "yes, this value". Because the dismissal commits
  from the sheet's slide-out callback, the value it saves is tracked as the user
  picks it, not read off the last render.
- **An all-day event's alerts are whole days, not minutes.** An all-day event has
  no start time, so minute offsets have nothing to count back from: while **All
  day** is on, both pickers offer **On the day / 1 day before / 2 days before /
  1 week before** (plus None and Custom…, whose sheet is fixed to the Days unit),
  each labelled with the hour it fires at — the user's day-alert time
  (`User.dayAlertTime`, 9am unless changed): *"On the day (9:00 AM)"*. The detail
  view labels them the same way. **Switching All day on re-bases the alerts
  already configured** (a "15 min before" becomes "on the day"; a second alert
  that collapses onto the first is dropped) — it must never leave a minute offset
  in place, and must never silently clear a configured alert. Switching it off
  changes nothing, since every whole-day offset is a legal timed offset — but it
  must still **switch off**: the re-basing helper (`alertsForAllDay`) returns only
  the two alert fields, never the object it was handed, because the switch spreads
  its result over the form patch and a wider object would put the old `allDay`
  back on top of the new value and pin the event to all-day. Travel
  time and its departure-anchored alert rows stay hidden on an all-day event, and
  switching All day on resets both anchors to `'event'`.
  The stored fields do not change — `reminderMinutes`/`alert2Minutes` remain
  minutes-before for both kinds; what changes is what they count back from. See
  the alert-anchor rule in [notifications.md](notifications.md).
- **Travel time** (`travelMinutes`, `travelDistanceKm`, `travelMode`) may be
  attached so an event's reminder accounts for getting there. The time is
  computed for a chosen **transportation method** — Drive (the default), Walk,
  Transit or Bike (`travelMode`: `DRIVE`/`WALK`/`TRANSIT`/`BICYCLE`, stored
  sealed alongside the minutes). Driving is traffic-aware; **transit is
  schedule-aware** — the form sends the event's start as the departure anchor
  (`GET /places/travel-time?mode=&departureTime=`, which routes through the
  shared `routeLeg` service in `server/src/services/geo.js`), so a transit
  estimate reflects service around the event, not whenever the form happened to
  recompute. Transit has real coverage gaps (Google doesn't license schedules
  everywhere), so a no-route answer is a named "No transit route found" error,
  not a generic failure. A record **without** `travelMode` — anything saved
  before modes existed, or a manual duration — reads as a drive time
  (`normalizeTravelMode` in `mobile/src/lib/travelModes.ts`).
  On a **new** event, travel time is
  irrelevant until a destination exists, so it defaults **on** only **once the
  event location (the destination) is set** — and then with the origin seeded from
  the user's **current location**, but only when they've **already shared**
  location with the app. The default never prompts for the permission and takes no
  GPS fix until a destination exists (`resolveCurrentAddressIfShared` in
  `lib/currentLocation.ts`, which reads the granted status without requesting it).
  It applies once, so it never overrides the user turning travel back off. With no
  destination, or no shared location, the default is **off**. Editing an existing event
  **never changes its travel time automatically** — neither the auto-on default
  nor the travel-time recompute fires. Merely opening the event (which seeds the
  saved destination and mode) must not rewrite its saved minutes; the travel time
  recomputes only when the user actually edits the destination, the starting
  point, or the transportation method.
  Travel time is anchored to the destination, so **clearing the event
  location switches travel time off** (and drops any saved/computed drive time) —
  on both the add and edit forms. This only ever turns travel off, so it never
  fights the user re-enabling it once a location is set again. On the event form the
  Travel Time row reads the travel time (with "Leave by…") once computed — with
  the mode named ("45 min · Transit · Leave by 8:15 AM") only when it says
  something the reader wouldn't assume: an auto-computed non-drive time (manual
  durations and drive times stay unadorned); **"On"**
  while enabled but not yet computed (e.g. a new event before its location is
  set); **"None"** when off. The Travel Time
  sub-screen carries a **mode row**, Apple Maps-style: four icon-only glyphs
  (Drive / Walk / Transit / Bike, MaterialCommunityIcons matching the trip
  timeline's travel pills) with the **active mode sat in a tinted capsule**
  (`colors.primary + '22'`, primary-coloured glyph) and the rest bare
  text-coloured glyphs — no borders, no labels; each button carries an explicit
  accessibility label ("Travel by transit") since the glyph alone names the
  mode visually. The row is
  shown only while a manual duration is **not** set (a manual duration ignores
  the origin and the mode alike; picking a mode is what "based on starting
  location" computes for). Below it, the sub-screen
  sets a **starting location** (origin) that the travel time is computed
  from. The origin field is pre-filled from the event's current origin (the
  default above, or whatever was last set), but is a plain
  editable address (generic "Starting address" placeholder — never labelled as
  the home field). Two one-tap shortcuts sit under it while a manual duration is
  **not** set (a manual duration ignores the origin): **Current location** — the
  opt-in device-GPS reverse-geocode path shared with the Account home-address
  field (`lib/currentLocation.ts`; same denied/unavailable/not-found fallbacks) —
  and **Home** (shown only when a home address exists and differs from the current
  origin). The event **detail view** shows a **Travel Time** row whenever a travel
  time (or manual duration) is saved — the duration as the value, with a subtitle
  joining the mode name (auto-computed non-drive only, same rule as the form row)
  and "Leave by <clock time>" (start − travel time) on a timed event whose
  departure falls on the same day.
- **The Location view has one input model at a time** (Apple Calendar-style),
  not a search field competing with an always-visible Name/Address/Phone form.
  Three states:
  - **Empty** — a single Google-Places search field ("Search for a business or
    address") with a quiet accent-tinted **"Enter an address manually"** link
    below it (the escape hatch). The field means both halves of its placeholder:
    typing a **street address** must suggest addresses exactly as typing a
    business name suggests businesses. It sends **no `type`** to
    `GET /places/autocomplete`, and the untyped lane applies **no
    `includedPrimaryTypes` filter** — that list is a filter, not a ranking hint,
    so the former `['establishment']` made a business the only thing that could
    match and an address query returned an empty dropdown with the manual
    escape hatch as the only way through.
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
    A typed address also renders the same static-map preview below the fields.
  **Every map preview on this view is tappable and opens the place in Maps**, the
  same as the event view's location map — a map that looks like the event view's
  map but does nothing reads as broken. Both use the same Google Maps search URL,
  and the Location view queries it with `locationString()` (the exact string the
  event stores), so tapping here and tapping from the event view land on the same
  place. The **✕** stays a separate tap target inside the card body, so clearing
  the selection never opens Maps.
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
  is the pre-switcher behavior. The meal and grocery glyphs come from
  `lib/calendar`'s shared `RECIPE_ICON`/`GROCERY_ICON`, the same constants the
  List view, day view, search, and the meal planner use.
  - Tapping the **grocery cart** opens the Meals view's Grocery pane on that
    day's shopping period **and queues the day as the Planner's highlight**:
    it navigates with `{ pane: 'grocery', weekStart: day, scrollToDate: day }`,
    and since only `PlannerPane` consumes `scrollToDate`, flipping to **Meal
    Planner** lands on the shopping day, highlighted. The List view's "Grocery
    shopping" row and the day view's all-day grocery item pass the same three
    params. See [kitchen.md](kitchen.md).
  A chip is **tinted, not filled** (Apple's month-view treatment): its
  background is the calendar's colour at low opacity over the black canvas and
  its title and start time are drawn **in that colour**, not in white. The text
  colour is derived, never the raw stored hex — `lib/color.tintedChip` lightens
  the hue (hue and saturation held) until the title clears **5.5:1** against the
  fill it sits on and the quieter time line clears the **4.5:1** WCAG AA floor,
  so a dark calendar colour stays legible instead of reading as a smudge. The
  **spanning bars stay solid with white text**, which is what distinguishes a
  multi-day span from a single-day chip at a glance. `ViewerMonthGrid` (free
  viewer mode) renders the identical chip.
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
  months. **Day selection styles like Apple's dark-mode calendar**: while today
  is the selection it carries the filled primary disc (white number); tapping
  any other day demotes today to a bare primary-coloured number (no disc) and
  the tapped day carries a **white disc with the number knocked out** (rendered
  in the screen's black canvas colour, so the number reads as the background
  through the disc — not the old `colors.surface` grey tint).
  Switching layers preserves the **viewed month** in both directions
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
- **Top-right** — the utility pill: view switcher, search, add. **Add is
  selection-aware in List mode**: the new-event form opens seeded with the
  List layer's selected day (the host asks the layer over the shared
  imperative handle, `getSelectedDate`), so tapping a day and then **+**
  starts the event on that day. The grid family has no selected-day concept,
  so there the form keeps its default of today.
- **Bottom-left** — a labelled **Today | Calendars** pill (hairline divider
  between). Both are text labels: Calendars is a primary destination, and a
  calendar glyph inside a calendar app is ambiguous. **Today opens today** —
  it drills into the day view for today's date (in whichever day mode was last
  used), re-centring the layer underneath on the way so backing out lands on
  today rather than wherever the user had scrolled to. It is a destination, not
  a scroll control: the month is an unbounded scroller and "take me to today"
  overwhelmingly means "show me today", so it goes the whole way.
- **Bottom-right** — the standalone **Calen FAB**: the gradient "C" glyph on a
  56pt surface disc, larger and one shadow step above the pills, alone in the
  prime thumb corner. It is the screen's single visually-dominant primary
  action; shown only while AI is enabled. (When the calendar was pushed by an
  assistant nav chip, this slot shows the "‹ Calen" return pill instead — see
  [ai-assistant.md](ai-assistant.md).)

The single **Today** button re-centres whichever layer is active *and* opens
today's day view over it.

### The month ⇄ day zoom

Month and day are **one canvas, not two screens**: same background, the same
bottom pill and Calen FAB at the same coordinates, only the content and the top
pills differ. So `CalendarDay` is pushed with the native stack animation
**off** (`animation: 'none'`) and the move is drawn by the two screens
themselves (`screens/calendar/dayTransition.ts`) as a zoom *through* the
surface — Apple Calendar's month→day feel, the motion Material calls a
shared-axis Z:

- **forward** — the month's content scales up (→ 1.08) and fades out; the day
  mounts already receded (0.92) and grows into place.
- **backward** — exactly the reverse: the day shrinks away, the month settles
  down from 1.08. It runs on *every* exit (back pill, Android back, a
  `navigate` that pops past the day), because the day view intercepts
  `beforeRemove` rather than wiring the animation onto its own button. A
  `RESET` (sign-out, lock) is never held up for it.

Three rules are load-bearing, not stylistic:

1. **The bottom chrome does not animate, on either screen.** The two copies are
   pixel-identical and identically placed, so they read as one pill that stayed
   put while everything around it moved. Animating them — or letting a native
   slide throw them across the screen and back — is exactly the drift this
   replaced.
2. **The screens swap while both are empty.** The month animates out *first*
   and navigates only once it has faded; the day fades out *first* and pops
   only once it has gone. At the swap instant both screens are the background
   colour plus that identical bottom chrome, so the hard cut has nothing to
   show.
3. **The top pills swing widest** (1.14 vs the content's 1.08) — they are the
   part that genuinely changes (avatar ⇄ back pill), so they are the part that
   visibly grows, softens out, and pops back with the new buttons. Arriving,
   they settle a hair under 1 near the end and come back up (`popIn`) — the
   overshoot is what makes it a pop rather than a glide, and it lives in the
   interpolation rather than a springy easing because the same value drives
   opacity, which must not be pushed past 1.

The month's zoom state is module-level and **survives while the day view is
up**, so returning resumes the same move backwards instead of cutting to a cold
month; the month picks it back up on focus, which is why any route out of the
day view lands the same way.

Under **Reduce Motion** the scaling is dropped for a plain crossfade (Apple's
own substitution). The timings are unchanged, so the choreography — and the
swap-while-empty rule — still line up.

A real gaussian blur is deliberately *not* used: RN's `filter: [{blur}]` is
Android-only (iOS supports brightness/opacity alone), so it would mean a native
blur module and an EAS rebuild to defocus something for 200ms. Scale + fade is
what Apple's zoom actually does and reads the same. Reanimated's shared-element
transitions (experimental, behind a feature flag in 4.x) and
`react-native-screen-transitions` were both considered and rejected: nothing
here needs to travel between two *different* layouts.

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

**Per-occurrence scoping on tasks/chores.** `expandRecurringTaskChore` honours two
fields inside a task's or chore's `recurrence`, the counterparts of an event's
`exceptionDates` + `recurrence.until`: **`skipDates`** (YYYY-MM-DD occurrences
struck out one at a time) and **`until`** (the series' last day). Both apply to
every recurrence type, and both are keyed on the **`_instanceDate` the expander
itself stamps** — comparing against a re-derived date instead would let a skip miss
by a day. An `interval` series stops walking once it passes `until` rather than
filtering each step. Records carrying neither field expand exactly as before. See
[maintenance.md](maintenance.md) for the prompts that write them.

**Scheduled meals carry their recipe's name (on-device title join).** The
opaque record store is content-blind, so a `RecipeSchedule` comes back with a
bare `recipeId` string — never the populated `{ _id, title }` ref the pre-C3b
per-collection route returned and that the shared engine, `itemsForDate`, and
every calendar surface still read. `loadCalendarSources` therefore reads the
**Recipe replica alongside the schedules** and re-attaches the ref
(`lib/mealSchedule.populateRecipeRefs`); without it every planned meal rendered
as the literal word **"Recipe"** on the month grid, in the List and day views,
and in search. An id with no matching recipe leaves `title` unset so each
reader's own "Recipe" fallback still applies. Because recipe titles are now a
calendar input, **`Recipe` is in `recordStore`'s `CALENDAR_COLLECTIONS`** —
renaming a recipe invalidates the `['calendar']` queries like any other
calendar write. Same class of defect as the planner's window filter (see
[kitchen.md](kitchen.md)): a content-blind store cannot hand back anything the
client didn't join itself.

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
  crossing a month boundary appears once, a recurring event occurrence keys by
  `_id:startDate`, and a recurring **task/chore** occurrence by
  `_id:_instanceDate` — the per-occurrence stamp the shared engine puts on
  every expanded instance, without which a repeating chore would be merged
  down to a single day). Every other consumer still calls `loadCalendarData`, now
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

### Live household sync (poke-and-pull)

A housemate's calendar write appears on the other members' devices **without a
manual refresh**. The architecture is *poke-and-pull*: real-time channels carry
only a content-blind **poke** ("something in your household changed" — no
content, no record id, no author), and the receiving device responds by running
its normal `/records/sync` cursor pull. The cursor stays the **sole data
path**, so a lost, duplicated, or reordered poke is harmless (the next pull
converges), reconnect recovery is just "revalidate once on open", and the E2EE
posture is unchanged — the server learns nothing it didn't already see.

Three lanes, all converging on the same pull (`hooks/useRecordSync`, mounted
once in RootNavigator, enabled while signed in):

1. **Foreground: the poke WebSocket** (`lib/recordSocket` ↔
   `/api/records/ws`, see [platform/api-reference.md](../platform/api-reference.md)).
   While the app is active, one authenticated socket stays open; a
   `{"type":"changed"}` frame — and every (re)connect — calls
   `scheduleRevalidate()`. Exponential backoff with jitter on failure
   (1s → 30s, reset once a connection opens); torn down when the app
   backgrounds (iOS would kill it anyway) and reopened on foreground.
2. **Background: the silent-push sync task** (`lib/pushSync`). The server
   debounces a **data-only** push (`type: 'records_changed'`, no banner —
   [notifications.md](notifications.md)) to the household's devices; the OS
   wakes the app briefly and the task pulls the cursor into the replica, so the
   calendar is already fresh at next open. Because a background sync fills the
   replica without repainting a mounted grid — and the next foreground
   revalidate would then pull *zero* new rows and skip invalidating — the task
   sets a **dirty flag** that the foreground transition consumes by
   invalidating `['calendar']`. Best-effort by design (the OS throttles silent
   pushes); the other lanes are the floor. Needs `remote-notification` in
   `UIBackgroundModes` (dev-client/EAS rebuild; no-ops in Expo Go).
3. **Every foreground transition schedules a revalidate regardless** — covering
   whatever the other two lanes missed.

`scheduleRevalidate()` (lib/calendarData) is the poke-side entry:
`revalidateCalendar()`'s 10s floor MUST NOT silently drop a poke (a poke means
the server *has* something new), so a floored call parks **one** trailing timer
at the floor's expiry — bursts coalesce into that single pending pass, and
post-poke staleness is bounded by the floor, never unbounded.

The writer's own session is excluded from the poke (its device already holds
the write locally — `recordStore` mirrored + invalidated at save time), but the
writer's **other** devices are poked/pushed like anyone else's. Resource-scoped
collaborators (a calendar/trip shared **across** households) are NOT poked in
v1 — they converge through the normal pull triggers.

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
switcher/search/add pill. **The bottom row is the month view's bottom row,
exactly** — bottom-left the labelled **Today | Calendars** pill (Today
re-anchors to today and re-centres the active mode), down to the pill metrics:
each label carries **16pt** of horizontal padding, the same either side of the
hairline divider, not the wider padding a lone Today button used to sit in.
Bottom-right the
standalone **Calen FAB**, shown only while AI is enabled. The day view is the
same full-bleed canvas as the month view, so its floating controls must not
differ from it; a control that exists in only one of the two is drift. In
particular there is **no calendar-glyph button** down here — returning to the
month is the top-left back pill's job, and duplicating it in the bottom-right
both displaced the assistant and read as a second, competing "month" affordance
(removed 2026-08-10). That sameness is also what the **month ⇄ day zoom**
(above) is built on: the bottom row does not animate on either screen, so it
reads as one pill that never moved, while only the top row and the content zoom
between the two. The Invitations inbox has no button here either (it lives
in Profile, badged via the month view's avatar). The native back-swipe stays
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
    calendar-colour fill, solid colour bar on the left edge, text in the
    calendar colour (contrast-corrected by `lib/color.tintedChip`, the same
    palette the month grid's chips use) — **clipped to each day column** (a
    midnight-spanning event yields one clipped segment per column).
    Overlapping blocks **lane-pack** (first-fit within each overlap cluster,
    equal widths). A *timed* event covering the entire day demotes to the
    all-day lane.
  - **What a block says is governed by how tall it is** (`blockDetail`), so a
    half-hour event never stacks clipped rows: at **full** height (≥56px, i.e.
    a one-hour event and up) it carries **title, location and start–end
    range**, each meta line led by its own glyph (pin, clock); at **medium**
    (≥38px) the location drops and title + range remain; below that only the
    title. The title takes a second line only where one still fits above the
    meta rows (≥78px). The range is written Apple-compact — on-the-hour drops
    the minutes and the two sides share one meridiem when they fall in the same
    half of the day (`timeRangeLabel`: "9 – 11AM", "11:30AM – 1PM").
  - An event with a **drive time set extends upward from its start**: the
    block's span begins at the **departure**, and its top slice is a **travel
    band** — the same calendar colour at a third of the block's tint, a faded
    left bar where the event's is full strength, and a hairline at the boundary
    marking where the driving stops and the event starts. The band is **named,
    not merely drawn** ("15 min travel", `travelBandLabel`), falling silent only
    on a band too short to print a line (<14px); the spoken label is always
    explicit ("30 min travel time before this event — leave by 9:30 AM"). A
    drive that would start before midnight is **clipped at the top of the
    column**, like any other span crossing a day boundary.
    The band is real occupied time, not decoration, so it participates in
    **lane packing** — a drive overlapping an earlier meeting splits the width,
    because one cannot be driving to one event and sitting in another — and in
    the day's opening scroll position (`initialScrollY` counts a block's band
    as part of it). The **height tiers above are measured on the event body**,
    not the whole span, so a travel band never buys a short event extra rows.
  - The **all-day lane** (hidden when every visible day is empty) holds
    all-day events, trips, holidays, birthdays, meals, the grocery marker —
    and **date-only tasks/chores**: they have no time of day, so the view
    never invents a slot for them. Chips are badged with a leading
    MaterialCommunityIcons glyph tinted in the item's colour: **events** a
    generic calendar glyph, **occasions** their kind icon (`occasionIcon` —
    cake, heart, ring…), **chores** the chore's own icon, **meals** the shared
    `RECIPE_ICON` and the **grocery marker** `GROCERY_ICON` (`lib/calendar`) —
    the same two glyphs the month grid's chips and the List view's rows use, so
    a meal reads as a meal on every surface. Both are tinted in the **Meals
    calendar's colour** (`calColors.recipes`, user overrides included) like
    those other surfaces; the shopping day belongs to that calendar, so a
    colour of its own would read as a separate calendar. A meal chip is titled
    with the **recipe's own name** (see the title join below), never the word
    "Recipe".
    Date-only **tasks** render as muted empty-circle chips (not a colour-badged
    item). Capped at three rows per day with "+N more" expanding.
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
  calendars** — opened from any country's editor, they land on the same prefs
  (the account's `User.holidayAlerts`, cached device-side as
  `hc_holiday_alert_prefs`) — because someone who wants a
  heads-up before a holiday wants it for every holiday they display. They apply
  to the holidays each calendar actually shows (national + selected regions +
  enabled cultural/religious), and **default to off**: holidays are numerous, so
  they are opt-in rather than something that silently fills the rolling reminder
  window. A holiday calendar's own **Alerts switch** (Edit Calendar) mutes its
  holidays. Alerts fire on-device — see [notifications.md](notifications.md).
  Because the prefs belong to the reader's account rather than to the calendar,
  a housemate reading a **shared** holiday calendar sets their own alerts even
  though the calendar's contents are the owner's to configure.

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
- Built-in calendars ship with default colours (overridable via Colours & Order,
  resettable to these defaults): Activities green `#388E3C`,
  Appointments **blue `#1976D2`** (changed from purple `#7B1FA2` 2026-07-29),
  Occasions pink `#E91E63`, Weather light blue `#0288D1`, Chores orange
  `#F57C00`, Meals teal `#00897B`, Maintenance blue `#1976D2`, Trips deep
  purple `#5E35B1`. Defined once in `lib/calendarPrefs.CALENDARS` (mirrored by
  `lib/calendar.CALENDAR_COLORS`); every default is a `COLOR_PRESETS` swatch.
- **The arrangement belongs to the ACCOUNT, not the device.** How the user
  arranged their calendars — each one's **colour**, the **order** they list in,
  which are **hidden**, which built-ins they **deleted**, and which have **event
  alerts muted** — persists on `User.calendarPrefs` via `PUT /settings`, with
  AsyncStorage as the warm read-through cache. It has to: that cache is account
  state wiped at sign-out (it holds one account's calendar names, colours and
  outside-share addresses, which must not survive into the next account on a
  shared device), so a cache-only write meant every one of these choices
  silently reverted to the app default on the next sign-in — reported
  2026-08-04 against a recoloured Chores calendar. The rules:
  - Every user-driven change writes the cache **and** pushes the whole
    arrangement to the account. The payload is absolute rather than a delta, so
    a push dropped offline can't leave the account half-applied; the next edit
    re-uploads it whole.
  - On load, the cache paints first and the account's arrangement is then
    fetched and adopted over it, field by field. A field the account has
    **never stored** means this device's own choice becomes the account's (the
    upgrade path for a user whose colours predate this); a field the account
    stores as **empty** is a value the user arrived at ("nothing hidden", "no
    overrides") and MUST win over the cache rather than being re-seeded from it.
  - A local edit made while that fetch is in flight is newer than anything the
    response can carry, and wins.
  - **The first frame carries the user's colours.** Every calendar surface
    resolves colour through `lib/calendarPrefs` (`colorOf` /
    `useCalendarColors`) and falls back to the app defaults until the prefs
    land, so a load that only starts when the calendar mounts paints the grid,
    chips, dots and section accents in the DEFAULT colours and recolours them a
    beat later — reported 2026-08-04 ("it displays the events and icons in their
    default colours for a second or two"). Two rules keep the first paint
    correct. The load is **one AsyncStorage `multiGet`**, never the
    key-at-a-time chain of ~15 sequential awaits it replaced. And the app
    **holds its splash on `useCalendarPrefsReady`** while signed in, alongside
    the unlock and first-run caches it already waits for. What "ready" waits for
    depends on what the device holds: with a **cached arrangement**
    (`hc_calendar_colors` or `hc_custom_calendars` present — the latter is
    written on every refresh, empty list included) the cache IS the arrangement,
    so it paints immediately and the server pass only corrects it; a slow or
    dead network MUST NOT hold the splash there. With **nothing cached** — the
    first launch after a sign-in, where the sign-out wipe left the account as
    the only source — it waits for that first server pass (`/settings` +
    the custom-calendar list), capped at **2s**, so a bad network costs a
    bounded wait rather than a stuck splash or a wrong-coloured calendar.
    Because this gate is in the always-mounted `RootNavigator`, it is armed by
    the signed-in flag rather than by a one-shot subscription: an account switch
    re-runs the load, which is what keeps a wiped-then-reloaded session from
    reporting "not ready" forever (the deadlock `lib/unlock` and
    `lib/viewerAccess` document).
  - The two **view modes** (month density, day-view mode) are deliberately NOT
    account state: which layout this device last displayed is device state, like
    a scroll position. Every other pref in this list needs a server home, or it
    reverts at the next sign-out.
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
- **Household invitees (in-household accept/decline).** Housemates already see
  every household event via sync, so an in-household "invite" grants nothing —
  it is a request for a response plus an instant notification. The mechanism is
  fully sealed (no new plaintext collection; see Encryption boundary):
  - The creator picks members in the Invitees screen's **"Notify household
    members"** zone (rendered only when the household has >1 member; the creator
    is excluded; member rows show an initial-disc avatar + name + checkmark
    toggle in the calendar accent). The selection is stamped into the event's sealed
    content as `householdInvitees: userId[]` (in `EVENT_ENC`, the server
    `DROP_FIELDS`, and EventLocationScreen's `CONTENT_KEYS`). It rides the
    invitee draft store like `guestListVisible` (seeded from the fetched event
    on edit, committed by a draft's save) so a whole-payload re-save preserves
    it; a saved event's Invitees ✓ re-seals it via
    `calendarApi.setHouseholdInvitees` and syncs the store.
  - Each invited member answers with their **own sealed `EventRsvp` record**
    `{ eventId, status: accepted|declined, respondedAt }` (+ the C4 `author`
    fold-in naming the responder) — one record per responder, single writer
    each, so concurrent responses never contend on the event record and a
    response can't revert a concurrent event edit (the whole-record LWW
    hazard). Changing an answer updates the same record in place. The join
    (event ↔ rsvps ↔ me) is client-side over the replica:
    `lib/householdRsvp.ts` (`deriveHouseholdRequests` is the pure, unit-tested
    core).
  - **Instant notify** is a stateless server relay
    (`POST /notifications/event-request` / `/event-response`, spec:
    [notifications.md](notifications.md)): the sending device chooses the
    strings ("Ben invited you to “Dinner” — accept or decline"; "Alan accepted
    “Dinner”"), the server validates the event Record exists in the caller's
    household and every recipient is a housemate, pushes, and stores nothing.
    Best-effort by design — the durable channel is the inbox row below. A
    response push goes to the event's sealed `author` (read on-device).
  - **Surfaces:** the invited member gets a push and a `householdEvent` row in
    the Invitations inbox (derived from the replica, 5s poll while open, badge
    via `useInvitationsCount`; Accept/Decline buttons; tapping the card opens
    the event, which is already on their calendar). The creator gets the reply
    push, and the event detail's Invitees row shows household members as
    status chips (name + accepted ✓ / declined ✕ / pending ?) ahead of the
    outside invitees, sharing the count and `+N` overflow. The event form's
    Invitees row counts both kinds (household members by name).
  - **Edits:** an in-place save that changes the event's date/time/all-day
    re-notifies every invitee who hasn't declined ("«title» changed"); RSVPs
    are **not** reset by an edit. An occurrence override / series fork writes a
    new record — its RSVPs start fresh, and no re-notify fires. Deselecting a
    member sends no revocation notice (v1). Cancelled events drop out of the
    inbox derivation; past events surface only once replied.
  - A locked vault can read previously synced rows (the inbox still lists) but
    cannot seal a response — responding surfaces an "Unlock your household data
    to respond" message instead of failing silently.
- **The Invitees screen is three titled zones**, because notifying a housemate
  and inviting an outsider are different acts on different people and a single
  undifferentiated "Invitees" list hid that: **Notify household members** (the
  member picker above), **Invite others** (the email/phone field plus the
  New / Received / Accepted / Declined status groups, which are the quiet
  uppercase `SectionHeader` eyebrows nested one level under the zone heading),
  and **Guest list** (the visibility switch — a setting, not a people list, so
  it gets its own zone rather than trailing the invitee rows). The Guest list
  zone appears **only once at least one outside invitee is staged or already
  invited**: it is a cross-household concern that housemates are not part of,
  so on a household-only event it governs nothing, and a dead control closing
  the screen invites the user to reason about a guest list that will never
  exist. Staged (not just sent) counts, because the flag is stamped onto each
  invitation as it goes out — it must be settable before the ✓/save that
  sends. A revealed hint sits **tight to the card it explains** (the screen
  passes its own `hintStyle`; `Hint`'s base bottom margin is sized for a
  standalone helper line and left the explanation floating mid-air between its
  heading and that card), so heading + hint + card read as one group. Every zone's
  explanation is folded behind the ⓘ (`HintDisclosure`), never printed above
  the controls: the prose that used to head this screen described the outside-
  invite flow only, which read as the whole screen's purpose. The empty state
  is scoped to the outside-invite zone ("No one outside your household yet.")
  so a household-only event doesn't read as empty, and it is a **single muted
  line, not the shared `EmptyState`** — that block's 52px icon stands roughly
  twice the height of the first invitee row, so the zone visibly shrank when
  someone was added, reading as a broken layout rather than as progress.
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
  (no per-occasion override) — offsets (days before) + a single time, held on
  the account (`User.occasionAlerts`) and cached device-side
  (`hc_occasion_alert_prefs`). Defaults: an alert at **noon the day
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
  everything. Gmail swaps emoji glyphs for its own small bitmap images, which
  blur when scaled to the 58px cover hero — a **Gmail-only CSS rule**
  (`u + .body .ec-hero`, matching Gmail's `<u></u><div class="body">` body
  rewrite) shrinks the hero emoji to bitmap size there; other clients keep the
  full-size native emoji. **U+FFFC object-replacement characters** (left in
  text fields by iOS dictation/inline placeholders; mail clients draw them as
  an "OBJ" box) are stripped from every author line — at write time
  (`parseBody`, so stored cards are clean) and again at render time
  (`stripObj`, covering already-stored cards). Condolence styles use only
  slow, gentle motion, and **condolence
  subjects never include the recipient's name** (celebration kinds do; custom
  labels don't). When the subject carries the name it goes **inside the
  heading's closing punctuation** — "🎂 Happy Birthday, Sam! — from Ben",
  never "Happy Birthday!, Sam". All user content is HTML-escaped, and a plaintext alternative
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
  disk when the photo or card is deleted. At send time each photo is
  **downscaled to email size** (`mailer.emailSizedPhoto`: fit within 1280px,
  re-encoded, EXIF orientation baked in; GIFs pass through to keep animation;
  a decode failure falls back to the original bytes) — a full-resolution phone
  photo (~3MB) makes Apple Mail defer the card's images into "Tap to Download"
  tiles instead of rendering them inline at the card's width. The stored
  original is untouched (the app preview serves it). The photo picker is
  **multi-select in one library visit** (`pickImages`, `selectionLimit` capped
  at the card's open slots — 3 minus the photos already on the card), not one
  photo per visit. **Saving never holds the user on the form for photos:**
  hitting the ✓ awaits only the card row itself (a small JSON create/update,
  so validation errors still surface in place), then leaves at once — photos
  picked this session upload **in the background, in parallel**
  (`lib/ecardPhotos.uploadECardPhotos`) after the form has closed. A failed
  photo upload never loses the card: the failure count comes back to a global
  alert ("Your card is scheduled, but N photos couldn't be added — open the
  card to add them again"), and the photo can be re-added from the edit
  screen.
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
  emailed non-account invites also touch `CalendarInvitation`. In-household
  RSVPs: `EventRsvp`, a **client-side collection in the opaque record store**
  (no server schema — the collection name rides inside the ciphertext;
  `EVENT_RSVP_ENC` in `mobile/src/lib/encSubsets.ts`, logic in
  `mobile/src/lib/householdRsvp.ts`).
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
- **In-household invitees and RSVPs are sealed end-to-end.** The invitee list
  (`householdInvitees`) is event content inside `enc`; each response is its own
  sealed `EventRsvp` record whose responder identity is the C4 `author`
  fold-in. Housemates hold the HDK, so there is **no plaintext justification**
  — no new server collection, no member-granular plaintext. The only server
  involvement is the transient notify relay
  (`/notifications/event-request|event-response`): client-chosen push strings
  (same exposure class as the existing invite pushes, which already carry
  titles), validated for household membership, never stored.
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
- Household event RSVP: the request derivation (invited-not-author, cancelled
  skipped, past-pending dropped vs past-replied kept, my-response-only join,
  soonest-first), the per-event responder map (latest answer wins), and the
  respond path (creates my sealed `EventRsvp`, updates it in place on a changed
  answer, throws the unlock message on a locked vault, pushes the reply to the
  creator and never to myself) — `mobile/src/lib/__tests__/householdRsvp.test.ts`.
  The relay endpoints' validation/membership contract is verified under
  [notifications.md](notifications.md).
- Recurrence expansion (the shared engine) — `shared/calendar/index.test.js`.
- Client-side calendar plumbing (feeds, prefs/density, holidays, recurrence
  helpers, timezone math, printing) — the `mobile/src/lib/__tests__/` units
  listed in `tests:`.
- The account-backed arrangement and the first-paint gate —
  `calendarPrefs.test.ts`: the account's colours/order/hidden/deleted/muted are
  adopted on the next sign-in, an account value stored as empty beats the cache,
  a device with no account copy seeds it, a recolour pushes the whole
  arrangement; and `useCalendarPrefsReady` stays shut until the account answers
  when nothing is cached, while a cached arrangement opens it **without** the
  network (a `settingsApi.get` that never resolves must not hold the splash).
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
  muted task chips + icon-badged chore chips, the meal/grocery glyphs and the
  meal chip's recipe name, lane packing, week-strip paging/selection,
  initial-scroll targets, gutter/now-badge labels) —
  `mobile/src/screens/calendar/dayview/__tests__/dayViewLayout.test.ts`.
- The on-device recipe-title join that keeps a scheduled meal from rendering as
  the literal word "Recipe" (`populateRecipeRefs`) —
  `mobile/src/lib/__tests__/mealSchedule.test.ts`; the grocery cart's
  pane-vs-highlight params — `mobile/src/screens/kitchen/__tests__/KitchenScreen.weekParam.test.tsx`.
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
