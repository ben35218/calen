---
title: Trips
status: current
last-verified: 1b68f83+ (2026-09-06); **journey times keep the 1-minute wheel** — `TimeField` app-wide now defaults to a 5-minute minutes wheel (Apple Calendar's granularity; see calendar.md's Starts/Ends rule), and the booking form's one opt-out is the flight/transit Departs/Arrives pair (`minuteInterval={1}`), because timetable times are minute-precise (2026-09-06); 1b68f83+ (2026-09-05); **"Ask Calen" moved out of the form body** — the in-form card is gone, replaced app-wide by a floating bottom-right "Ask Calen" pill opening a half-screen chat sheet (`components/FormAssistChat.tsx`); a filled turn applies its patch and closes after a beat, a turn that can't fill stays open for the clarifying question, and the conversation lives as long as the form does. Owned by [ai-assistant.md](ai-assistant.md) (1b68f83+, 2026-08-24); **a booking can be read out of its confirmation** — `POST /trips/:id/items/from-confirmation` has existed since the Vue client and was never ported to mobile (the removed web app was its only caller), so the documented endpoint had no user-facing flow at all; the ADD-booking form now opens with an **Add from a confirmation** card — Paste (which pulls the clipboard into a visible pad rather than importing blind), Camera, Library and File (`pickDocument` already permitted PDF / image / `message/rfc822`) — that posts the text or uploads the file, shimmers a `BookingSkeleton` over the form while the parse runs, and applies the returned draft through the AI assistant's own `applyPatch` so the filled fields light up; the flattening from the draft's nested shape onto the form's flat keys is pure and unit-tested (`lib/tripConfirmation`), and refuses any date/time the model malformed rather than seeding a field with it; new `tripsApi.fromConfirmationText`, file lane via `lib/upload.uploadFile` under field `file`; the card then went **collapsed by default** (title + chevron, the assistant card's own chrome) with the privacy/credit line folded behind a `HintDisclosure` ⓘ above the sources, and the "also read from the confirmation" footnote naming the hidden pass-through fields was **cut** — an import isn't special enough to earn prose above the fields, and the booking view shows those values anyway (`confirmationPassThroughLabels` removed with it); the expanded card was then stripped to its BUTTONS — the descriptive blurb and the ⓘ disclosure both cut, and camera + library merged into one **Photo** button opening the native Take Photo / Choose Photo sheet, leaving three buttons and no prose (so there is now no in-card notice that the confirmation leaves the device readable — see Open questions) (2026-08-24); d3dea32+ (2026-08-22); **a trip has no color of its own** — the per-trip `color` (a Color picker in the trip form, defaulting to purple `#5E35B1` and saved onto every trip) is gone; each trip is now painted by the **Trips calendar's** color wherever it appears (month spanning bar + day dots, day-view all-day chip, List row, calendar search, trips list card, Calen's trip picker, the home-screen widget), exactly as an event is painted by its calendar's — recoloring the Trips calendar had been leaving those surfaces on each trip's frozen default purple; the form dropped its Color section, the trip overlay (`@household/calendar`) and the `Trip`/`CalendarTripOverlay` types dropped the field, the server dropped the model column and its `TRIP_FIELDS` whitelist entry, and `server/src/scripts/stripTripColor.js` ($unset, dry-run default) clears stale values from Mongo; booking blocks are unaffected (they still wear the booking TYPE's color) (2026-08-22); d3dea32+ (2026-08-22); **a weather entry lands on the day, at the top** — `TripDetail` gained `focus?: 'weather'` beside its `date` param: an entry from a weather surface (today, the month grid's forecast segment for a trip day — calendar.md) seeds that day's itinerary as always but replaces the day's opening anchor for that one day with a hold at the top, so the day's destination forecast card is what the reader sees instead of the grid scrolled down to the first booking; the hold is keyed to the DATE and read from the route param at mount (an index set inside the focus effect is wiped in that same commit by the "paged away" check whenever the trip query answers from cache, which is why the first cut of this landed scrolled past the card anyway) and is ACTIVE — each anchor re-report re-asserts the top, since the forecast card arrives with its own query and pushes everything under it; spent as soon as the reader pages to another day or scrolls by hand (2026-08-22); **editing a trip moved out of the trip and onto its list row** — TripDetail's header lost the "Edit" text button (custom and native-glass bar-button item alike), leaving the add-booking "+" as the screen's only header action, and each card on the trips list gained the Calendars-screen trailing **ⓘ** (`information-circle-outline`, muted, `Edit <trip>` label) that pushes `TripForm` on that trip while the card body still opens the itinerary; the card is now the row container with a `tripMain` touchable holding the color bar + text (same geometry — the vertical padding moved onto that touchable so the bar still stretches) and the ⓘ beside it; the calendar month grid's trip-bar long-press still opens the same form, so no entry path was lost (2026-08-22); **the booking form's money row and flight branch were tightened** — the money card's switch is now labelled **Booked** (was "Booking confirmed"; same stored `confirmed` boolean, same first-row slot and trips accent, and the assist schema's label followed); Currency lost its own row and moved onto the **Cost line** (picker right of the amount showing the ISO code, `placeholder="Currency"`, still clearable and still joined by an off-list prefilled code) so the amount and its denomination read as one fact, with the symbol still embedded in the amount itself; the Cost label gained an **ⓘ disclosure** — the `HintDisclosure` glyph pair with label + glyph as one tap target — explaining that every booking's cost rolls into the "Your budget" total on the trip overview, converted to the base currency (cost is the only field whose effect lands on another screen); the **flight branch lost its Airline / Flight # / Seat card entirely** (transit keeps its Mode row) — the three fields ride along as hidden pass-through state exactly like `confirmation`, so an older booking's or the from-confirmation parser's values survive an edit and still render on the booking view, while the assist schema and the "Ask Calen" placeholder dropped them; and a **hotel's date rows are labelled Check in / Check out** (label-only, matching the booking view, the lodging grid blocks and the alert anchor); the airport/station picker's **first tap works again** — `PlacesAutocomplete`'s focus-time reveal and its `keyboardDidShow` listener still animated their scroll, and iOS re-fires `keyboardDidShow` on every keyboard HEIGHT change (the QuickType bar appearing as the user types), so that listener kept running with the dropdown already open and its in-flight animation ate the tap as "catch the scroll"; every reveal now reads the CURRENT "rows are showing" state through a ref (the listener's closure is created once, on focus) and jumps instead of animating whenever there is something tappable on screen (2026-08-22); **trip status is gone** — the `status` field (considering / booked / completed) and the `candidateRanges` it alone surfaced were removed end to end: the form lost its Status card (and the assist schema's `status` select), the trip view lost the tappable header badge + status action sheet + "Date options" card (the header title is plain again), the trips list and Calen's trip picker section purely by date (**Upcoming** = last day today or later or undated, **Past** = last day passed; the Considering section is gone), the calendar's trip overlay/auto-open, destination-weather swap ("booked" gate → destination + both dates), the Weather screen's "On your trip" card and the booking-alert pass (`status !== 'completed'` → last-day-passed test) all derive from dates, the AI routes stopped shipping status (trips-chat prompt line + "Compare my date options" starter; calendar-chat `list_events` field, tool description and system prompt), and the server dropped the model field, the `TRIP_FIELDS` whitelist entries and the unused `?status=` list filter — both were plaintext columns, so `scripts/stripTripStatus.js` ($unset, dry-run default) clears stale values from Mongo (2026-08-21); **the calendar's trip tap lands on the tapped day** — `TripDetail` gained an optional `date` route param (trip-local YYYY-MM-DD): when present, the screen opens straight into that day's itinerary (one-shot seed per param value once the day list resolves, so the back-to-overview chevron sticks; a date outside the trip's range opens the overview unchanged); the month grid's trip spanning bar and the List mode's trip row pass the tapped/selected day (2026-08-21); **the booking form is ordered and furnished like the event form** — its whole tail is now the event form's: money card → cost-share rows → the **Alert pair** → **Attachments** → **URL** → Notes, so alerts are the last card before Attachments and URL is the labelled section between Attachments and Notes; Confirmation # and Phone left the form (`confirmation` rides along as hidden pass-through state so an older booking's saved value survives an edit and still renders on the booking view, and the assist schema dropped it; phone is entered only via the shared Location view), while URL stayed as a real field in the event form's labelled-section shape ("Add a link…", url keyboard, no autocapitalize/autocorrect); the old "Not booked yet"/"Booked" flip-label switch became a static **Booking confirmed** switch (same stored `confirmed` boolean, true = booked, trips accent) sitting first in the money card ahead of Sharing / Cost / Currency; the Cost value renders with its currency's symbol embedded ("$450" — new `lib/currency.currencySymbol`, ISO-code fallback, edits strip the prefix before the number stores); a NEW booking prefills Currency from the trip destination's country (`@household/weather.regionForAddress` keyless geocoders — the sealed destination never touches our server — through new `lib/currency.currencyForCountry`; fills only an empty Currency, folds into the discard-guard baseline so a prefill isn't an unsaved edit, and a code outside the standard list joins the picker's options); attachments became the event form's card in the event form's slot (after Alerts, before URL, on add AND edit): an "Add attachment…" row opening the camera / photo-library / file source sheet, rows wearing the file-kind glyph with a close-circle remove behind the native confirm, a draft form staging picks in the shared queue (`lib/attachmentDraft`) that upload after the create with failed files named — sealing lane unchanged (TripKey on a shared trip's `shared_shared` booking, HDK otherwise, plaintext only with no key) (2026-08-21); **the booking form's date card is now the event form's All day / Starts / Ends card** — the standard (non-journey) booking form dropped its clearable Starts time, optional Ends pair and the End time / Duration segmented switch for the calendar event form's grouped card: an All day switch (trips-accent, alerts re-based through `alertsForAllDay` when toggled on), Starts and Ends rows whose date fields always render (Ends defaulting to the start's own date, `endDate` normalized to unset while same-day) and whose time fields render only while All day is off (toggling off reveals the 9–10 AM defaults; a timed booking now ALWAYS saves an end, a legacy end-less row reading back as one hour), with the event form's duration-preserving handlers (start edits carry the end both ways; an end dragged to at/before the start pulls the start back; journeys keep their own Departs/Arrives handlers and never carry the flag); the plain Add opens All day like a new event, a day-grid long-press draft opens timed on its pressed hour; **all-day is a sealed flag over unchanged routing columns** — `allDay` seals beside the title in `TRIP_ITEM_ENC` (no server column; every reseal must echo it, the booking view's live alert pickers included), while `start`/`end` stay midnight instants in the destination tz and a single-day all-day booking stores no `end`; all-day bookings never sit on the day grid (no midnight blocks — they ride above it as lodging-style banner rows with an "All day" note, tap→view / hold→edit, counted by the "Nothing booked" hint), all-day hotels keep the lodging banner minus the check-in/check-out grid blocks (`lodgingCheckins`/`lodgingCheckouts` skip them) and the booking view renders day labels with no clocks (and no "Times are local to" note); all-day booking ALERTS take the calendar's whole-day branch end to end — `buildBookingAlertItems` swaps the minute grid for `ALL_DAY_ALERT_OFFSETS`/`allDayAlertLabel` at the account `dayAlertTime`, the Custom… sheet goes `dayOnly`, the form assistant's Alert options follow, and delivery anchors at the day-alert hour on the booking's destination-local date (`loadBookingAlerts` resolves `startDate` onto the slim row at load time so the reader's UTC offset can't move the day) with the day lead phrase as the body (2026-08-21); **a standard booking's Location field is now the shared Location view** — the booking form's inline location autocomplete became the event form's tap-through row: a read-only field that pushes `EventLocation` seeded with the booking's location/phone/placeId, picked values flowing back via the same `locationDraft` handshake (location string, business phone — even when cleared there on purpose — and `placeId`, which lets a later edit reopen the resolved place card instead of the manual fields); journey legs keep their inline airport/station `PlacesAutocomplete` (typed pickers that also derive the leg's timezone, not an event-style location); the booking's `placeId` seals beside the location (`TRIP_ITEM_ENC`) and, since the item route has no plaintext strip for it, `sealTripItemPayload` drops the plaintext copy itself on any sealed write (the degraded plaintext lane keeps it, like the location string), with the booking view's live-alert reseal echoing it like the rest of the content (2026-08-21); **bookings now carry the calendar's Alert / Second alert pair** — every booking type gets the two slots (`reminderMinutes`/`alert2Minutes`, minutes before the booking's `start`: the journey's departure, the hotel's check-in, a standard booking's start — the data model already stores all three as `start`, and a booking is always timed, so there is no all-day/day-alert-hour branch), sealed inside `enc` beside the title (no server column, no server read — mongoose's strict schema drops the plaintext copies); the rows the form and the booking view offer come from ONE builder (new `lib/tripAlerts.buildBookingAlertItems`: the event grid plus 2/3-hour airport leads on journeys only, a zero row named by the type's anchor, saved customs synthesized back, Custom… via the shared `CustomAlertSheet` with no leave anchor — travel legs re-derive from booking PAIRS, so there is no stable departure to promise), and the calendar's slot rules carry over (clear-the-first-promotes-the-second, no second without a first); the booking VIEW manages them as live pickers exactly like the event view, writing via a reseal of the decrypted content that must ECHO the sharing branch (`lib/tripData.tripItemSharingEcho` — the item route rebuilds cost-sharing from every PUT body, so an enc-only patch would wipe participants/shares) through the shared seal-lane helper (`sealTripItemPayload`, extracted from the form), and only on a booking this device decrypted (a reseal over a contentless row would destroy the sealed title); the form assistant can set the first alert (`reminderMinutes` select in the assist schema, options = the picker grid + `-1` None via `BOOKING_ALERT_ASSIST_OPTIONS`, promote-on-clear applied to the patch); delivery is the on-device reminder pass: `lib/tripAlerts.loadBookingAlerts` reads active (non-completed) trips through the shared fetcher, caches slim decrypted rows in a `TripItemAlert` replica bucket so an offline reschedule keeps the alerts it armed last time, never throws (per-trip cache fallback), is gated on the trips add-on and muted by the Trips calendar's Alerts switch (`'trips'`), and the reminder scheduler now also re-runs on `['trips']` invalidations; the notification names the anchor in its body ("Departs in 2 hours" / "Check-in in 1 hour" / "Starts in 15 minutes") and falls back to the booking type as its title when the title won't decrypt (2026-08-21); **the overview weather card shows the real forecast when the trip is close** — the grid view's typical-weather card became one merged weather card: one row per trip day, the destination's 7-day forecast winning any date it covers (condition icon + high/low + rain %) and the 3-year average standing in elsewhere, via the new shared `@household/weather.buildTripWeather` (forecast-wins per date, per-row `source` tag, unit-tested); a mixed card labels its segments (FORECAST / TYPICAL · 3-YEAR AVERAGE) and an average never wears a condition icon, so an average can't read as a prediction; the header drops "TYPICAL" when any forecast row exists, and the card opens itself once when a forecast lands (packing-actionable) while a far-future trip's averages stay folded; both queries gained gates — the forecast is fetched only when the trip's dates can intersect today..today+6, the averages are skipped when the whole trip fits inside the forecast window (2026-08-21); **the day now starts at the hotel** — the first booking of a trip day gets a travel band out of the night's lodging, derived automatically from the hotel booking that covered the previous night (check-in strictly before the day, check-out on/after it, trip-tz date compare; first hotel with an address) via the new shared `lib/tripLodging.ts`, whose covering-date predicate also replaced TripDetailScreen's two inlined hotel-span filters (lodging banner, grid bed markers); check-in and check-out are now blocks on the day grid at their own times (`lodgingCheckins`/`lodgingCheckouts`; tap→view, hold→edit; suppress the "Nothing booked" hint; the Check in/out line wears the paired doorway glyphs `login-variant`/`logout-variant` instead of the location pin) — ordinary segments anchored at the hotel's address, so the consecutive-leg rule hands a post-check-in or post-check-out booking its leg out of the hotel and a pre-check-in booking its leg to the hotel, with no special-cased origins; no morning leg when the day opens on a journey's arrival, never flagged red, morning only (no return leg), mode-cyclable like any band; the day-open "today → now-line" anchor now compares dates on the destination's clock instead of UTC (2026-08-21); **a short travel leg is now legible** — a band shorter than its own label (a five-minute hop between two places in the same town) is drawn and packed at the label's minimum height instead of an unreadable sliver, with the true minutes still in the label; and the day's opening anchor now holds until the reader scrolls, so a forecast card arriving late can't push the grid past the first booking and clip its title (2026-08-21); **the trip view's "Ask Calen" FAB is now the calendar's FAB** — TripDetail (grid and day itinerary) floats the shared `components/AssistantButton` instead of an accent-filled `Fab` wearing `CalenChatIcon`, so the assistant disc, its press spring/haptic and its first-run halo are identical to the calendar's (mobile/CLAUDE.md's icon vocabulary updated with it) (2026-08-21); **a booking now has a view of its own** — tapping a block on the day itinerary (or the night's lodging banner) opens the new `TripItemDetailScreen`, the calendar's event view for a booking, and press-and-hold goes straight to the booking form, which is the same pair of gestures the calendar's event chips answer; the form's Delete moved onto the view as the Apple-style floating pill, and the view shares the event view's map card (`components/LocationCard`), the booking form's sharing labels (`lib/tripTypes.TRIP_SHARING_OPTIONS`) and its attachment opener (`lib/tripAttachments`) (2026-08-21); **the day itinerary now shows the trip's content** — the detail screen (and the trip/booking forms and the trip assistant with it) reads `GET /trips/:id` through the shared decrypting fetcher `lib/tripData.ts`, so a booking's title and location render instead of a block holding only its time, and the booking form finally reads the trip's (sealed) destination timezone rather than falling back to the device's; the day timeline's blocks and travel bands are now the calendar day view's own (`dayViewLayout` primitives): title/location/compact time range by block height, travel between consecutive bookings drawn upward from the destination block, red when it outruns the gap, tapping it cycling Drive→Walk→Transit→Bike; and the grid itself is now the day view's full midnight-to-midnight canvas (same gutter labels, day opens anchored on its first booking / now / 8 AM) whose empty space takes the calendar's **long-press-to-create** — pressed 15-minute slot → ghost "New Booking" → the booking form prefilled with that hour in the destination's timezone (new `TripItemForm.prefill` route param) (2026-08-21); loading states follow the app-wide shimmer-skeleton rule (mobile/CLAUDE.md's loading table): the trips list's add-on ownership gate now renders the same `SkeletonList` the list load shows (one steady skeleton instead of spinner → skeleton → content), TripDetail's initial fetch loads as the shared `SkeletonDetail`, and TripSettle's balances/payment rows as `SkeletonList` (2026-08-11); **Starts/Ends redesign follows calendar.md**: a start edit now always carries the end with it (span preserved, either direction) via the shared `endKeepingDuration`; the end field is how the span changes; itinerary-item start-**time** edits shift the end only when both clocks are set (2026-08-06); nothing in trips repeats — neither `Trip` nor `TripItem` carries a recurrence field and itinerary items never reach the calendar, so the occurrence-scope prompts events/chores/tasks answer deliberately don't apply here; a repeating event on the Trips calendar is an ordinary calendar event and follows the event rules (recorded so the absence reads as a data-model property, not a gap) (2026-08-04); the trip assistant gained chat web search (server-side web_search tool + "Searching the web…" activity label) — behavior and pricing owned by ai-assistant.md / billing-plans.md (2026-07-30); trip-item phone uses shared PhoneField, stored E.164 (2026-07-27); editing an end (trip range / booking start-end / journey Departs-Arrives) before the start drags the start back to preserve the span via shared lib/datetime.startKeepingDuration (2026-07-29); the trip and trip-item add/edit forms guard against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29); trip-share email invites now compose via the shared mail-app chooser (`useEmailComposer`/EmailAppSheet — behavior specced in households-sharing.md) instead of a bare `mailto:` (2026-07-29); the Starts/Ends duration-keeping rule is now symmetric — editing the **start** (date/time) to at/after the end pushes the **end** forward via the shared `lib/datetime.endKeepingDuration`, mirroring the existing end→start drag, on the trip date range, the booking start/end, and the journey Departs/Arrives, so the end is never left before the start (2026-07-29); trip-share outreach is now composer-only-for-non-accounts — an account-holder recipient gets the server push + in-app inbox with no composer (lookup-gated via `GET /invitations/lookup`, fail-open, "they're on Calen" note), and not-yet-joined recipient rows gained a paper-plane Remind that composes on demand (households-sharing.md policy) (2026-07-29); the Trip Name field capitalizes each word (`autoCapitalize="words"`, proper-noun rule in mobile/CLAUDE.md); the Destination city keeps PlacesAutocomplete's own keyboard config (2026-08-10); the trip and trip-booking "Ask Calen" form-assist action button is tinted with the trips accent per the section-accent rule (card chrome stays app-primary; shared FormAssist accent prop) (3cd3b36+, 2026-08-11)
code:
  - mobile/src/screens/trips/
  - server/src/routes/trips.js
  - server/src/services/tripSharing.js
  - server/src/models/{Trip,TravelLeg,TripItem,TripInvitation}.js
  - mobile/src/lib/tripKeys.ts
  - mobile/src/lib/tripData.ts
  - mobile/src/lib/tripAttachments.ts
  - mobile/src/lib/tripAlerts.ts
  - mobile/src/lib/tripLodging.ts
  - mobile/src/lib/tripConfirmation.ts
  - mobile/src/lib/currency.ts
  - mobile/src/components/TripTimeline.tsx
tests:
  - server/src/test/tripKeys.integration.test.js
  - server/src/test/tripShare.integration.test.js
  - server/src/test/tripAttachments.integration.test.js
  - server/src/services/tripSharing.test.js
  - mobile/src/lib/__tests__/tripData.test.ts
  - mobile/src/lib/__tests__/tripAlerts.test.ts
  - mobile/src/lib/__tests__/tripLodging.test.ts
  - mobile/src/lib/__tests__/tripConfirmation.test.ts
  - mobile/src/lib/__tests__/currency.test.ts
  - mobile/src/components/__tests__/TripTimeline.test.tsx
  - mobile/src/screens/trips/__tests__/TripItemDetailScreen.test.tsx
  - mobile/src/screens/trips/__tests__/TripItemFormScreen.confirmation.test.tsx
  - shared/weather/index.test.js   # buildTripWeather forecast-wins merge
---

# Trips

## Purpose

Plan trips with itinerary/booking items, split and settle expenses across
participating households, and share a trip with people outside your household.

## Behavior (normative)

- **Unsaved-changes guard:** the trip and trip-item (booking) add/edit forms
  prompt an Apple-style "Discard Changes?" sheet before leaving with unsaved
  edits (header ✕ / back / swipe-back / Android back), via the shared
  `useUnsavedChangesGuard` hook — a successful save/delete/leave exits without
  prompting. On the trip form, changes to an existing trip's outside-sharing
  persist to the server immediately and so don't count as unsaved (a new trip's
  pending invites do). See [calendar.md](calendar.md) and
  [mobile/CLAUDE.md](../../mobile/CLAUDE.md).

### Add-on gating

- The Trips home is gated by the **`trips` add-on** — a one-time household-wide
  purchase specified in
  [billing-plans.md](billing-plans.md#feature-calendar-add-ons). When the
  household doesn't own it, `TripsScreen` renders the `AddonLockedView`
  purchase interstitial instead of its content (trip detail/sharing sub-screens
  are reached only through the gated home). Data is retained while locked and
  reappears on purchase.

### Trips & itinerary

- A `Trip` has name, destination (+ placeId/timezone), date range, notes,
  `budget`, `baseCurrency`, and a `tripKeyVersion` (its own resource
  key, see Sharing). There is **no trip status**: a trip's lifecycle is derived
  entirely from its dates — the trips list splits into **Upcoming** (last day
  today or later, or no dates yet) and **Past** (last day passed), and every
  status-gated behavior (calendar weather, booking alerts, auto-open) uses the
  same date test. (The retired `status`/`candidateRanges` fields were plaintext
  server columns; removing them also shrank server-visible metadata.)
- **A trip has no color of its own.** Every surface that paints a trip — the
  month grid's spanning bar and day dots, the day view's all-day chip, the List
  mode's row, calendar search, the trips list card, Calen's trip picker, the
  home-screen widget — uses the **Trips calendar's** color
  (`colorOf('trips')` / `useCalendarColors().colors.trips`), exactly the way an
  event is painted by its own calendar. Recoloring the Trips calendar
  (Calendars → Colors & Order) therefore recolors every trip, with no
  per-trip color able to hold a stale hue. The trip form has no Color section,
  and the `Trip.color` column is retired (a plaintext field; stale values are
  cleared by `server/src/scripts/stripTripColor.js`, `$unset`, dry-run by
  default). The color a *booking* wears is unrelated and unchanged: an
  itinerary block takes its **booking type's** color (`tripTypeMeta`).
- **A trip's own details are edited from its row in the list, not from inside
  the trip** — the Calendars-screen row anatomy, applied here. Each card on the
  trips list is a body (color bar, name, destination, dates) that opens the
  trip's itinerary, plus a trailing **ⓘ**
  (`information-circle-outline`, muted) that opens the trip form on that trip.
  The trip view's header therefore carries **one** action, the accent
  add-booking "+": the trip's name, destination, dates, budget and sharing are
  properties of the *container* the reader just stepped into, so editing them
  belongs beside the container in the list, while the screen itself stays about
  the itinerary. (Long-pressing a trip's spanning bar on the month grid still
  opens the same form — see [calendar.md](calendar.md) — so a calendar-first
  reader is not sent through the list.)
- Every Starts/Ends pair (a trip's date range, a booking's start/end, or a
  journey's Departs/Arrives) follows the shared `lib/datetime.ts` rule described
  in calendar.md: editing the **start** always carries the **end** with it so
  the span is preserved (`endKeepingDuration`) — changing the span is the end
  field's job — and editing the **end** changes the span, unless it lands
  at/before the start, which drags the **start** back (`startKeepingDuration`)
  so the end never precedes the start. On a journey's Departs/Arrives pair, a
  departure **time** edit only moves the arrival when the pair had both clocks
  set (a first-set time, or a date-only arrival, leaves the arrival alone).
- **Time-wheel granularity:** booking time fields use `TimeField`'s app-wide
  5-minute wheel (calendar.md's Starts/Ends rule) — **except a journey's
  Departs/Arrives, which spin in single minutes** (`minuteInterval={1}`):
  flight and transit timetables are minute-precise (a 7:43 departure), and a
  5-minute wheel would make the real time unenterable.
- **A standard (non-journey) booking's date card is the event form's** —
  one grouped card: an **All day** switch, then **Starts** / **Ends** rows
  whose date field always shows (Ends defaulting to the start's own day) and
  whose time field renders only while All day is off. The old End time /
  Duration segmented switch is gone, and so is the clearable "no end" state: a
  **timed** booking always saves an end (a new one opens 9–10 AM; an edited
  legacy row without an end reads back as one hour long). Toggling All day
  **off** reveals the 9–10 AM defaults; toggling it **on** re-bases any
  configured alerts onto the whole-day grid (`lib/calendar.alertsForAllDay`),
  exactly as the event form does, because the booking just lost the start time
  they counted back from. A long-press-created draft opens **timed** on the
  pressed hour; the plain Add opens **All day** (the event form's own
  default). Journeys (flight/transit) keep their Departs/Arrives rows and
  never carry the flag. **A hotel's two rows are labelled `Check in` and
  `Check out`** — the same words the booking view, the day grid's lodging
  blocks and the alert anchor already use for a hotel's `start`/`end`. Nothing
  about the stored data changes; every other type keeps Starts / Ends.
- **An all-day booking stores dates, not times.** Its `start` (and, when it
  spans days, its `end`) are still real instants — midnight in the
  destination tz — so the server's plaintext routing columns never change
  shape; a single-day all-day booking saves no `end`. What marks it date-only
  is the **`allDay` flag sealed beside the title** (`TRIP_ITEM_ENC`; no server
  column — mongoose's strict schema drops the plaintext copy; absent = timed,
  which is what every legacy row reads as). Because it is sealed content,
  every reseal must echo it — the booking view's live alert pickers included —
  or the write strips the flag.
- `TripItem`s are itinerary/booking entries (title, start/end, location, address,
  confirmation, cost/currency, url/`phone` (stored E.164; the form has no phone
  field — the number is entered on the shared Location view), notes, free-form
  `details`, and
  encrypted `attachments`). CRUD: `POST/PUT/DELETE /trips/:id/items[...]`;
  `POST /trips/:id/items/from-confirmation` parses a booking out of a pasted
  confirmation (`{ text }`) or an uploaded PDF / image / `.eml` (multipart,
  field `file`) and answers with an unsaved DRAFT — metered as a `scan` credit,
  gated on `requireAiEnabled`, reached from the booking form's import card (see
  "Add from a confirmation"); per-item `attachments` upload/download/delete
  endpoints exist.
- `TravelLeg` caches computed travel between locations (mode/minutes/distance).
- **A standard booking's Location is the shared Location view**, not an inline
  autocomplete. The add/edit-booking form's Location field is a read-only
  tap-through row that pushes `EventLocation` (behavior owned by calendar.md →
  "The Location view has one input model at a time") seeded with the booking's
  current location/phone/`placeId`; the picked values flow back via the same
  `locationDraft` handshake the event form uses — the location string, the
  **business phone** (into the booking's stored phone, even when deliberately
  cleared there — the Location view is the phone's ONLY entry point, the form
  itself has no phone field), and the `placeId` that lets a later edit reopen the resolved
  place card instead of the manual fields. Journey legs (flight/transit) keep
  their inline airport/station `PlacesAutocomplete` fields — those are typed
  pickers that also derive the leg's timezone, not an event-style location.
  The `placeId` is sealed content beside the location (`TRIP_ITEM_ENC`); unlike
  the other sealed fields the item route has no plaintext strip for it, so
  `sealTripItemPayload` drops the plaintext copy itself on any sealed write
  (the degraded plaintext lane keeps it, exactly as it keeps the location
  string), and the booking view's live-alert reseal echoes it like the rest of
  the decrypted content.
- **The booking form (add + edit) is ordered and furnished like the event
  form.** Type chips → Title/Location card → the date card (or the journey's
  Departure/Arrival cards) → the money card → the multi-family cost-share rows
  → the **Alert pair** → **Attachments** → **URL** → Notes, with the tz note,
  error line and (edit only) Delete at the end. The Alert pair, Attachments,
  URL and Notes hold the event form's own tail order — alerts are the last
  card before Attachments, and URL is the labelled section between Attachments
  and Notes — so the two forms end the same way. Within that:
  - **No Confirmation # or Phone fields.** `confirmation` stays in the form
    state as hidden pass-through — an edit reads back and resaves whatever an
    older booking (or the from-confirmation parser) stored, and the booking
    VIEW still renders it — but it can no longer be typed on the form, and the
    assist schema dropped it. A confirmation import (below) fills it the same
    silent way. Phone is entered only via the Location view
    (above). URL is a real field again, in the event form's labelled-section
    shape (`Add a link…` placeholder, url keyboard, no autocapitalize/
    autocorrect) and back in the assist schema.
  - **No airline / flight # / seat fields.** A flight is placed by its
    airports and times, and the ticket itself is an attachment, so the flight
    branch has no details card at all (transit keeps its one **Mode** row).
    Like `confirmation`, the three values stay in the form state as hidden
    pass-through — an edit reads back and resaves whatever an older booking
    (or the from-confirmation parser, which still extracts them) stored, and
    the booking VIEW still renders them — but they can no longer be typed on
    the form, and the assist schema dropped them.
  - **The money card starts with a `Booked` switch** (first row, trips accent,
    static label; the stored `confirmed` boolean is unchanged, true = the
    booking has been made), then Sharing (multi-family trips only), then the
    single **Cost** row.
  - **Cost and its currency are one row.** The amount and the currency it is
    denominated in are one fact, so the currency picker sits on the Cost line
    (right of the amount, showing the ISO code) rather than in a row of its
    own. The Cost value itself renders with that currency's symbol embedded
    ("$450" — `lib/currency.currencySymbol`, ISO code as the fallback glyph,
    the bare symbol as the empty field's placeholder); an edit strips the
    prefix back off before the number stores, so `cost` stays a plain number.
  - **The Cost label carries an ⓘ disclosure** (`HintDisclosure`'s pair —
    whole label + glyph is the tap target, `information-circle-outline` filling
    in while open) saying what the number is for: every booking's cost rolls
    into the "Your budget" total on the trip overview, converted to the base
    currency. Cost is the only field on the form whose effect is on a *different*
    screen, so it is the one that has to say so.
  - **A new booking prefills Currency from the destination's country.** The
    trip's (sealed, decrypted) destination resolves to a country through the
    keyless geocoders (`@household/weather.regionForAddress` — the destination
    never touches our server) and to a currency through
    `lib/currency.currencyForCountry`. The guess fills only an EMPTY Currency
    (never an edit, never over a typed/assist value), folds into the
    discard-guard baseline (a prefill is a seed, not an unsaved edit), and a
    code outside the standard list joins the picker's options so it stays
    selectable.
  - **Attachments are the event form's card**, on add and edit alike: an "Add
    attachment…" row opening the camera / photo library / file source sheet,
    then one row per file (file-kind glyph, name, close-circle remove behind
    the native confirm). A DRAFT form stages picks in the shared queue
    (`lib/attachmentDraft`) and uploads them once the save creates the item,
    naming any files that failed so a failure isn't mistaken for a successful
    upload. The sealing lane is unchanged: per-file key wrapped by the TripKey
    on a `shared_shared` booking of a shared trip, the HDK otherwise,
    plaintext only when no key is held.

### Add from a confirmation (normative)

Most bookings arrive as a confirmation email. Re-typing one into the form is
the single most tedious thing the trips feature asks of anyone, and a flight
is the worst case: two airports, two dates, two clocks, and two timezones that
have to be right or the itinerary lies about when the day starts.

- **The card lives on the booking FORM, not on the `+`.** The trip header's
  add button still goes straight to a blank booking in one tap — the common
  path is not put behind a chooser. The **Add from a confirmation** card sits
  above the fields instead, in the recipe form's Quick-import slot and shape.
- **It is an ADD-only, AI-only, once-only card.** It renders on a new booking,
  never on an edit (it builds a booking; it does not re-read one), only while
  the account's AI switch is on, and it retires itself permanently the moment
  a draft lands — re-importing over a form the user has since corrected would
  quietly undo those corrections. It also steps aside while a parse runs, so
  the skeleton has the screen to itself.
- **It opens COLLAPSED**: a title row and a
  chevron, tapped to reveal the sources. Filling the booking in is the form's
  primary job, and four source buttons sitting open above the fields would
  read as the expected way in rather than the shortcut they are. Collapsing
  again keeps whatever is in the paste pad.
- **Three buttons, four sources, one endpoint.** Paste, **Photo** and File.
  Camera and library are one button — they are the same act ("a picture of the
  confirmation") differing only in where the picture comes from, so the choice
  belongs in the native source sheet the button opens (Take Photo / Choose
  Photo / Cancel; `ActionSheetIOS` on iOS, the `Alert` fallback elsewhere),
  not in two buttons on the card. All of them post to
  `POST /trips/:id/items/from-confirmation` — pasted text as `{ text }`, a
  picked file as multipart under the field name `file` (via
  `lib/upload.uploadFile`, like the other scans). The file lane needs nothing
  new: `pickDocument` already permits `application/pdf`, `image/*` and
  `message/rfc822`, and the route already parses an `.eml` with `simpleParser`
  and forwards its PDF/image attachments (the e-ticket) alongside the body.
- **The expanded card is its buttons and nothing else.** No blurb, no
  disclosure row — the title says what the card does and the three glyphs say
  how. Prose above the buttons was tried twice (a descriptive line, then an ⓘ
  disclosure) and cut both times: it pushed the actions down the card without
  saying anything the title and the glyphs didn't.
- **Paste shows what it is about to send.** Tapping Paste pulls the clipboard
  into a visible, editable pad and waits — it does not import blind. This is a
  deliberate extra tap: the whole confirmation is about to leave the device to
  be read, so the user gets to see and trim it first. An empty clipboard just
  opens the pad; the field's own paste gesture still works.
- **The wait is a skeleton, not a spinner.** Reading a confirmation takes
  several seconds and produces a KNOWN shape, so the form shimmers as itself —
  type chips, title/location card, date rows, money card (mobile/CLAUDE.md →
  the loading rule, "a button spinner alone under-signals a multi-second
  wait").
- **The draft is applied through the assistant's own path.** The parser's
  nested answer is flattened onto the form's flat keys by
  `lib/tripConfirmation.confirmationDraftToPatch` (pure, unit-tested) and then
  handed to the same `applyPatch` the AI form assistant writes through — so an
  import gets the all-day alert re-basing and the changed-field highlight for
  free, and the user can see at a glance which fields Calen filled and which
  it left alone. The "Ask Calen" pill then **pulses once**, because the expected
  next move after an import is a fix-up ("seat is 14C, not 12A") — and the
  import **resets the conversation**, which was about a different booking.
- **Nothing the model malformed reaches a field.** Only strictly `YYYY-MM-DD`
  dates (calendar-checked, so `2026-02-31` is refused) and `HH:mm` times are
  accepted; anything else is dropped and the form keeps its own default. A
  malformed date rendered back by a DateField is worse than an empty one — the
  field would present it as the booking's real date and the user would save a
  lie. Fields the confirmation left null are omitted from the patch entirely
  rather than sent as `''`, so a blank can never wipe something already typed.
- **All-day is inferred from the clocks.** A standard booking whose
  confirmation quotes no time at either end is date-only (`allDay` true — a
  hotel giving only check-in and check-out dates); one clock anywhere makes it
  timed. A journey never takes the flag (it has no All-day switch). A
  same-day end normalizes to `endDate: ''`, the form's own convention.
- **Journeys arrive already placed.** `buildDraft` resolves each airport or
  station through the Places lane server-side, so both legs land with a
  description AND their IANA timezone filled in. `placeId` has nowhere to go —
  a journey leg is stored by name + tz — and is dropped.
- **Fields the form has no row for stay hidden, exactly as on any other
  booking.** An import fills `confirmation` (and, on a flight, airline /
  flight # / seat), all of which the form deliberately stopped showing; they
  ride along as the same pass-through state a typed booking uses and surface
  on the booking VIEW after the save. The form does not call them out. (A
  footnote naming them shipped first and was cut: an import is not special
  enough to earn a line of prose above the fields, and the booking view is
  where those values live either way.) A hotel's `details.roomType` is parsed
  by the server but the standard save branch builds no `details`, so it is
  dropped — see "Open questions".
- **There is NO in-card privacy disclosure.** This is the one path that sends
  a booking's contents off the device readable, against the standing
  references-not-values rule (ai-assistant.md → "References, not values" and
  its carve-out), and the card says nothing about it. A line stating it
  shipped first, then moved behind an ⓘ, then was removed outright — the card
  is its three buttons. What the user is left with: the account-level AI
  switch (which removes the card entirely), the `CreditsBanner` in the card
  when the balance runs low, and the credit debit itself. Recorded here as a
  DELIBERATE product decision rather than an oversight, and carried as an open
  question below, because it is the one place the app sends sealed content out
  unannounced.
- **A failure costs nothing but the credit, and says so where the user is
  looking.** The route's own 422 already reads like something a person wrote,
  so its message wins — rendered **inside the card**, not through the form's
  shared error line, which sits at the bottom of the screen a whole form below
  the card the user is staring at. The pasted text stays in the pad and the
  form below is untouched and fully typeable. A cancelled picker does nothing
  at all — no request, no message.

### Day itinerary (the trip's own calendar) — normative

Tapping a day on a trip opens that day's hour grid. The calendar can land here
directly: the `TripDetail` route takes an optional `date` (trip-local
YYYY-MM-DD), and the screen seeds the day itinerary onto it once the trip's day
list resolves — the month grid's trip-bar tap, the month grid's **forecast
segment** for a trip day, and the List mode's trip row all pass the tapped day
(see [calendar.md](calendar.md)). Seeding happens once per param
value, so the header's back-to-overview chevron sticks, and a date outside the
trip's range leaves the overview up. An entry that came from a **weather**
surface also passes `focus: 'weather'`, which holds that one day at the **top**
of its scroll instead of anchoring it on the first booking (below): what was
tapped was the day's forecast, and the day's forecast card is the first thing on
the day, so the answer has to be on screen when it lands. The hold is **active,
and keyed to the date**, for the same two reasons the anchor it replaces is
re-applied rather than fired once: the forecast card arrives with its own query
and pushes everything under it, so each re-report has to re-assert the top rather
than merely decline to scroll; and it is read from the route param at mount,
because a hold seeded from an effect loses a race whenever the trip query answers
from cache — the "paged away, hold spent" check then runs in that same commit,
sees the still-null day, and clears the hold before the day is ever on screen.
The hold covers only that day — paging on (and back) anchors on the itinerary
like any other, and the reader's own first scroll ends it like any other day's.
**It renders trip content,
which means it must decrypt what it fetched.** Every reader of
`GET /trips/:id` — detail screen, trip form, booking form, trip assistant —
goes through the shared decrypting fetcher `mobile/src/lib/tripData.ts`, which
opens the `Trip` and every `TripItem`, loading the trip's own TripKey first
(§D2 resource lane) so a collaborator sees the itinerary too. This is not
optional plumbing: a trip's name, destination and timezone, and a booking's
title, location (+ its `placeId`), url, phone, notes and `details` are all sealed, and their
plaintext columns are nulled at the drop (`DROP_FIELDS`), so a screen rendering
the fetched row as-is shows the routing columns alone — bookings with a time and
a type icon, no title and no location. The screens share the `['trips', id]`
query key, so they must also share the fetcher: a per-screen plaintext `queryFn`
blanks the detail screen behind whichever form mounted last.

**The grid is the whole day, and it takes a long-press.** Like the calendar's
day view, the canvas runs midnight to midnight at 1px = 1min with the same
gutter labels ("12 AM", "Noon", "1 PM") — not a window cropped to the hours
already booked, which couldn't show a 7 AM breakfast being added to a day that
starts at 10 and made each day a different amount of day. Because the grid is a
full 24 hours, the day **opens anchored**: scrolled to just above its first
booking (travel lead-in included), to the now-line when the day is today, and to
8 AM on a day with nothing on it. The anchor holds while the cards above the grid
are still settling — the forecast card arriving with its query moves the grid
down, and an anchor computed against the earlier measurement lands past the first
booking and clips its title — and is released the moment the reader scrolls, for
that day. Changing day re-anchors.

**Long-pressing empty grid space drafts a booking there** — the calendar's
gesture, with the booking form on the other end of it. The pressed 15-minute slot
becomes a one-hour draft: a ghost "New Booking" block springs into that slot with
a haptic, holds a beat so the eye registers where it landed, and the form pushes
prefilled with that start and end in the **destination's** timezone (rolling onto
the next date when the last hour is pressed). The ghost outlives the push and
fades when the itinerary regains focus — the saved booking has taken its place,
or nothing has if the form was cancelled. Booking blocks sit above the canvas and
claim their own touches, so only bare grid drafts. A day with nothing booked
still gets its grid (that's the day you most need to add to), under a hint saying
so.

**A booking on the grid is a calendar event, and reads like one.** The day
timeline uses the day view's own block treatment and layout primitives from
[calendar.md](calendar.md#day-view) (`dayViewLayout`: `packLanes`, `blockDetail`,
`travelBandLabel`, the compact `timeRangeLabel`), rather than a second
implementation:

- Title, then location, then the time range, each meta line led by its glyph, on
  a contrast-corrected tint of the **booking type's** color. How many lines
  render is decided by the block's rendered height (`blockDetail`), as on the
  calendar — but a trip block's minimum height is the one at which all three
  lines fit, so even a 15-minute booking or a journey's point-in-time departure
  marker still names *where*. A trip day holds a handful of bookings, so the
  stretch costs nothing a packed weekday grid couldn't spare.
- Times are the destination timezone's, in the day view's compact form
  ("2 – 4PM"). A journey leg is the exception: its departure and arrival are in
  different zones, so those two blocks keep the zone-named label ("10:00 AM EDT")
  and each sits on its own local date.
- A booking whose title won't decrypt (a collaborator without the TripKey) is
  named by its booking type rather than rendered blank.
- **An all-day booking never sits on the hour grid.** It has no hour, and a
  midnight block would be the grid asserting a time the user never entered.
  Every day its date span covers, it rides **above** the grid as a banner row
  in the lodging banner's shape — the type's glyph and color, the title, an
  "All day" note, the same tap-to-read / hold-to-edit pair and pencil — and it
  counts against the day's "Nothing booked" hint. All-day **hotels** keep the
  lodging banner (no double banner) and earn **no** check-in/check-out grid
  blocks (`lodgingCheckins`/`lodgingCheckouts` skip them — there is no clock
  to place), while still anchoring the morning-leg and bed-marker predicates,
  which compare dates alone. The booking view renders an all-day booking's
  "when" as day labels with no clocks ("All day, Fri, Aug 22, 2026", hotels as
  "Check in <day>" / "Check out <day>") and drops the "Times are local to"
  note — dates are dates.

**The block answers the calendar's gestures: tap to read, hold to edit.** A tap
opens the booking's own view (`TripItemDetailScreen`); a press-and-hold (with the
same medium haptic the grid's create gesture uses) pushes the booking form
directly. This is the month grid's event-chip pair, and for the same reason — a
booking is overwhelmingly something you open to *check* (when is dinner, where
is it), and answering that with an edit form buried the answer in fields. The
night's lodging banner above the grid takes the same pair (its pencil still goes
straight to the form). The out-of-range and uncosted-booking lists are edit
affordances by construction — they exist to fix a date or a cost — and keep
opening the form on a tap.

**The booking view is the event view, for a booking.** It reads through the same
shared decrypting fetcher on the shared `['trips', id]` key (never its own
plaintext `queryFn`), and shows, in order: the title (falling back to the booking
type, as on the grid), a type pill and whether it's booked, the location (tap →
Maps), when it happens, then only the fields the booking actually has — journey
legs (from/to, airline, flight, seat, mode), confirmation, cost (the household's
own on a per-family bill, labelled "Your cost"), the sharing mode, URL, phone
(tap → call), attachments (tap → the same download-and-decrypt path the form
uses, `lib/tripAttachments`), notes, and the location's map card. Empty fields
are absent, not blank rows. **Edit** in the header opens the form on the day the
booking was opened from, and the page ends in the event view's floating
**Delete Booking** pill behind the native confirm.

- Times are the trip's destination timezone (the clock the itinerary renders in),
  said once under the dates rather than repeated per line. A hotel reads as check
  in / check out; a journey's two ends each name their own zone, since they are
  the one case where two clocks are in play.
- There is no mini hour-grid card as on the event view: a booking is reached
  *from* the day's hour grid, which just showed it in place.
- A booking that disappears while its view is open — deleted from the form
  pushed on top of it, or from another device — pops back to the day rather than
  leaving a page about nothing.

**Travel between bookings is drawn as time, not as a footnote.** For each pair of
consecutive bookings with locations (skipping the two halves of one journey, and
same-place hops), the app computes the leg via `POST /places/route-leg` and
extends the *destination* block **upward** from its start by that many minutes —
a fainter wash with a dashed left edge, labelled with the duration and the mode's
glyph, exactly like an event's drive time on the calendar. Consequences:

- The band is occupied time: lane-packing treats a block's span as starting at
  its **departure**, so travel that overlaps the previous booking splits lanes.
- **A leg shorter than its own label is still drawn at a legible height.** At
  1px = 1min a five-minute hop between two places in the same town is a sliver
  with nowhere to print — a band that is present and says nothing, which is
  indistinguishable from no travel time at all. So a short leg is drawn (and
  packed) at the minimum height its label needs. The *drawing* rounds up; the
  *number* never does — the label reads the true minutes, and the booking's own
  body still starts at its true time.
- **A leg longer than the gap between the two bookings turns red** with an alert
  glyph — the itinerary saying the plan doesn't fit.
- **Tapping the band cycles the mode** (Drive → Walk → Transit → Bike, the shared
  `lib/travelModes` list the event form uses), recomputing the leg. A mode with
  no route keeps a tappable chip on the block instead of a band, so a coverage
  gap can never strand the user with nothing to tap.
- **The day's first leg starts at the night's lodging.** When a hotel booking
  covered the previous night — check-in date strictly *before* the day,
  check-out on or after it, compared in the trip's timezone
  (`lib/tripLodging.overnightLodging`, the first such hotel with an address) —
  the day's first booking gets a travel band whose origin is that hotel's
  location, derived automatically with nothing to configure. A day that opens
  on a journey's *arrival* gets no morning leg (the night was spent in transit,
  not at the hotel); a day opening on a journey's *departure* gets hotel → the
  departure airport/station. The morning leg is never flagged red — no earlier
  booking constrains it — and it cycles modes like any other band (its
  accessibility label says the origin is the hotel). Morning only: the day's
  last booking gets no return-to-lodging band. The same helper's covering-date
  predicate (`lodgingCoveringDate`) is what the lodging banner and the grid's
  bed markers read, so "where are we staying" and "where does the day start"
  can never disagree.
- **Check-in and check-out are on the grid as their own blocks.** On its
  check-in day the hotel earns a block at its check-in time
  (`lodgingCheckins`), and on its check-out day one at its check-out time
  (`lodgingCheckouts` — hotels with an end, or there is no clock to place).
  Both are styled and gestured like any booking (tap → the hotel booking's
  view, hold → its form), titled with the hotel's name over a "Check in" /
  "Check out" line. That line leads with the paired doorway glyphs
  (`login-variant` in, `logout-variant` out), **not** the location pin the
  subtitle row of an ordinary block wears — the pin marks a place, and this
  line names an action; the bed on the title row already says "hotel". Because each is an ordinary segment anchored at the hotel's
  address, the consecutive-leg rule does the rest with **no special-cased
  origins**: on the check-in day a booking *before* check-in gets its leg *to*
  the check-in block (and never a hotel-origin leg — the user wasn't there
  yet), while a booking *after* check-in gets its leg **out of the hotel** via
  the block; on the check-out day a booking before check-out keeps its
  overnight morning leg plus travel back to the hotel to check out, and a
  booking after check-out leaves from the check-out block. A lodging block
  alone also counts as content: the day's "Nothing booked" hint stays away.
- The day-open anchor's "today → the now-line" comparison is made on the
  **destination's** clock (`zonedParts(now, tz)`), not the device's or UTC —
  late evening at home must not read a foreign tomorrow as today.
- Route legs send the two location strings to the server, which asks Google and
  caches the answer in `TravelLeg` — the same server-side lookup an event's
  travel time makes, and the same deliberate exception to sealed trip content.
- **Nothing in trips repeats.** Neither `Trip` nor `TripItem` carries a recurrence
  field, and itinerary items never reach the calendar at all — a trip contributes
  only its date range as a spanning overlay. So the Apple-style "This Occurrence Only / All Future" scoping that
  events, chores, and maintenance tasks answer on save and delete **does not apply
  here**, and its absence is a property of the data model rather than a gap in the
  UI. A repeating **event** whose `calendarType` is `trips` is an ordinary calendar
  event and is scoped by the event rules in [calendar.md](calendar.md);
  `calendarType` is just a field, so every calendar gets that behaviour uniformly.

**Ask Calen floats in the corner as the calendar's own FAB.** Both the trip's
grid view and its day itinerary carry the assistant entry point (when the user's
AI is enabled) as the shared `components/AssistantButton` — the same disc the
calendar month and day canvases float: an elevated fill with a light rim, the
untinted gradient `CalenGlyph`, a press spring with a haptic, and the first-run
halo pulse (`lib/calenFabIntro`, which is app-wide, so a tap here retires the
pulse everywhere). It is deliberately **not** tinted with the trips accent, the
one documented exception to the section-accent rule for a FAB: Calen belongs to
the app rather than to a feature area, reads as the same button on every screen
that offers it, and its gradient mark can't sit on a colored disc.

### Booking alerts (normative)

A booking carries the calendar event's **Alert / Second alert** pair — every
booking type, because a restaurant reservation or a car pickup is as
time-critical as a flight; what varies by type is only what the offset counts
back from, and the data model collapses even that: a journey's departure, a
hotel's check-in and a standard booking's start are all the stored `start` (a
real UTC instant, entered as destination/leg wall-clock). A timed booking's
alert fires at `start − minutes`. Consequences and rules:

- **All-day bookings take the calendar's whole-day branch.** An all-day
  booking (the sealed `allDay` flag) has no clock for minutes to count back
  from, so it gets exactly what an all-day event gets: the whole-day offset
  grid labelled with the hour it fires at (`ALL_DAY_ALERT_OFFSETS` /
  `allDayAlertLabel`, the account-level `dayAlertTime`), a days-only Custom…
  sheet (`dayOnly`), and delivery anchored at the day-alert hour on the
  booking's own **destination-local** date — `loadBookingAlerts` resolves that
  date (`startDate`) onto the slim row at load time, because the reader's UTC
  offset must not decide which day a midnight-destination-tz instant falls on.
  The notification's body is the day lead phrase ("Today" / "Tomorrow"), never
  a minutes phrase. Toggling All day on in the form snaps configured minute
  alerts onto the day grid (`alertsForAllDay`), as the event form does.
  **No leave anchor** on any booking:
  travel legs are derived from *pairs* of bookings and re-derive as the
  itinerary changes, so there is no stable departure instant to alert against.
- **One option builder for both surfaces** —
  `lib/tripAlerts.buildBookingAlertItems`, the same one-builder rule as the
  event pickers (`lib/eventAlertOptions`): None first; a zero row named by the
  type's anchor (*At departure* on flights/transit, *At check-in* on hotels,
  *At start time* otherwise); 15 min / 30 min / 1 hr; **2 hr and 3 hr on
  journeys only** (airport lead times); 1 day; a synthesized row for any saved
  custom value; Custom… last, opening the shared `CustomAlertSheet` (minutes
  wheel, no anchor control). On an all-day booking the builder swaps the
  minute grid for the whole-day one, as above. The calendar's slot rules
  apply: clearing the
  first alert promotes the second, and a second alert is never saved without a
  first.
- **The pair is sealed content** — `reminderMinutes`/`alert2Minutes` live
  inside `enc` beside the title (`lib/tripData.TRIP_ITEM_ENC`). The server has
  no columns for them and never reads them; scheduling is entirely on-device.
- **Both editing surfaces offer the pair.** The booking form (add + edit)
  carries the grouped Alert / Second Alert card after its date section; the
  booking view manages the same fields **in place**, as the event view does —
  its rows are live pickers writing straight to the booking. Because the
  fields are sealed, the view's write re-seals the decrypted content through
  the shared lane helper (`lib/tripData.sealTripItemPayload` — TripKey on a
  shared trip, HDK otherwise, same choice as the form's save), and it must
  **echo the sharing branch** (`lib/tripData.tripItemSharingEcho`): the item
  route rebuilds the whole cost-sharing state from every PUT body, so an
  alerts-only body would drop the other families and wipe a shared bill. The
  view's pickers render only on a booking this device decrypted (title
  present) — a reseal over a contentless row would destroy the sealed content
  for everyone who holds the key.
- **The form assistant can set the first alert**, as on the event form: the
  assist schema offers `reminderMinutes` as a select whose options are the
  picker's own grid plus a `-1` None row
  (`lib/tripAlerts.BOOKING_ALERT_ASSIST_OPTIONS` — derived from the same
  offsets, so the two can't drift); the patch maps `-1`/null to a cleared slot
  rather than the string fields' `''` fallback, and clearing the first alert
  through a patch promotes the second, same as the picker.
- **Delivery is the on-device reminder pass** (notifications.md). Bookings
  never reach the calendar data, so the pass loads them separately:
  `lib/tripAlerts.loadBookingAlerts` walks active trips — last day today or
  later, or undated; a finished trip has nothing left to fire, since every
  booking alert anchors inside the trip's range — via
  the shared decrypting fetcher, returns slim rows for alert-bearing bookings,
  and reconciles them into a `TripItemAlert` replica bucket; a trip whose fetch
  fails (offline) falls back to its cached rows, so an offline reschedule —
  which cancels everything before rearming — keeps the booking alerts it armed
  last time. The loader never throws, is gated on the **trips add-on** (a
  locked feature doesn't keep notifying), and booking alerts are muted by the
  Trips calendar's **Alerts** switch (calendar id `trips`) like everything else
  that calendar owns. The scheduler re-runs on `['trips']` query invalidations,
  which every booking save (form or live picker) already emits.
- **The notification names the anchor**: title = booking title (falling back
  to the type's label on a booking sealed under a key the device doesn't
  hold); body = "Departs in 2 hours" / "Departing now" on journeys, "Check-in
  in 1 hour" / "Check-in time" on hotels, "Starts in 15 minutes" / "Starting
  now" otherwise (`lib/notifications.bookingAlertBody`) — and the day lead
  phrase ("Today" / "Tomorrow") on an all-day booking, whose alert describes a
  day rather than a countdown.

### Destination weather (normative)

Both weather surfaces fetch **client-direct from open-meteo** (keyless, like
home weather in calendar.md §9.1 P5b) with the shared `@household/weather`
engine and its place-tolerant geocoder (`geocodePlace`) — the sealed
destination never touches our server.

**The overview (grid view) shows one weather card, not two.** One row per trip
day, merged by `@household/weather.buildTripWeather`: the destination's real
7-day forecast wins any date it covers, and the 3-year historical average for
that calendar date stands in everywhere else (the same forecast-wins rule the
calendar overlay's `buildRangeRecords` uses). Every row carries its `source`,
and the card renders the two honestly:

- A **forecast** row shows the condition icon, high/low, and rain probability.
- A **typical** row shows the averaged high/low and precipitation as before —
  and **never wears a condition icon**: an icon asserts a predicted condition,
  which an average doesn't have. A date with neither a forecast nor any
  archived average is not a row.
- A **mixed** card (trip partially inside the forecast window — including an
  in-progress trip, whose already-passed days fall back to typical) labels each
  source segment with an eyebrow (FORECAST / TYPICAL · 3-YEAR AVERAGE), so the
  line between prediction and average is explicit, not inferred. The header
  reads "WEATHER · {destination}" once any forecast row exists, "TYPICAL
  WEATHER · {destination}" when it's all averages.
- The card stays **collapsed by default** (far-future averages are trivia), but
  **opens itself once when a forecast row appears** — a real forecast for an
  imminent trip is packing-actionable. Closing it by hand sticks; the auto-open
  fires only when forecast rows first arrive.
- The two queries resolve independently and the card renders progressively:
  whichever lands first paints its rows, the other upgrades rows in place.

**The day itinerary keeps its full forecast card**: when the selected day is
inside the 7-day window, the day view shows that day's forecast (condition,
high/low, outfit suggestion, hourly strip) above the grid; a day outside the
window shows no forecast card there (the overview's typical row is the answer
for far days).

**Fetch gating** — neither query runs when it can't be used: the 7-day
forecast is fetched only when the trip's date range can intersect the forecast
window (today through today+6); the historical averages are skipped when the
whole trip fits inside the forecast window (every day gets a real forecast).
Far-future trip → averages only; imminent/in-progress trip → forecast plus
averages for the tail; short trip starting within the week → forecast only.

### Expenses & settlement

- Costs are split across households: `householdBudgets`, per-item `shares` /
  `householdData` / `paidByHouseholdId`. Endpoints: `GET /:id/budget`,
  `/:id/families`, `PUT /:id/my-budget`, `GET /:id/settlement`,
  `POST /:id/settle-payments` (+ delete), rendered by `TripSettleScreen`.

### Sharing outside the household (normative)

- A trip may be shared with an outside collaborator who does **not** hold your
  HDK. Two mechanisms:
  - **Resource-key sharing** (in-app collaborators): `GET/POST /trips/:id/keys`,
    `/keys/members`, `/keys/pending` seal a per-trip key to the collaborator so
    trip records decrypt for them (`lib/tripKeys.ts`, `ResourceKeyEnvelope`).
  - **Decrypt-on-share** (`PUT /trips/:id/share`, `services/tripSharing.js`): the
    client sends the decrypted `{ trip, items }`; the server re-writes them as
    **plaintext** and mints a share code. Steady-state writes then **strip
    ciphertext while shared** so an edit can't reintroduce data the collaborator
    can't read. Un-sharing (`DELETE /:id/share`) re-encrypts on next edit.
- **Invite outreach is device-composed, and only for non-account recipients.**
  `PUT /trips/:id/share` only creates the `TripInvitation` discovery record and
  returns the sharing list — the server sends no invite email or text. An
  invited **existing account** gets a push (`notify.pushToUser`, best-effort)
  plus the in-app inbox entry, and NO composer opens on the owner's device
  (the trip form checks `GET /invitations/lookup` before composing, failing
  open, and shows a "they're on Calen" note instead). Only a recipient
  **without an account** gets the composed nudge — the owner's chosen mail app
  via the shared mail-app chooser, `sms:` for phones (mobile `lib/shareInvite`
  + `components/EmailAppSheet`). Not-yet-joined recipient rows carry a Remind
  action that re-opens the composer on demand regardless of account status.
  Policy + chooser behavior specced in
  [households-sharing](households-sharing.md); same pattern as
  [calendars](calendar.md).
- `TripInvitation` handles invite accept/decline (`GET /trips/invitations`,
  `.../accept`|`decline`). Collaborator management:
  `POST /:id/leave-share`, `DELETE /:id/collaborators/:userId`.

## Data & API surface

- **Models:** `Trip`, `TripItem` (+ encrypted `attachments`), `TravelLeg`,
  `TripInvitation`.
- **Endpoints:** `server/src/routes/trips.js` (the largest router — trips, items,
  budgets/settlement, sharing, keys).
- **Client:** `screens/trips/*` (Trips, TripDetail, TripForm, TripItemForm,
  TripItemDetail, TripSettle, TripPicker, TripAssistant). The trip assistant's prompt shows
  booking confirmation codes as "on file" only (never the code itself) — see
  [ai-assistant.md](ai-assistant.md).
  - The first-run empty state names the feature's purpose (plan bookings + split
    expenses with fellow travelers), not just "plan a getaway", so a new user
    understands what a trip is for before creating one.

## Encryption boundary

Trip content is sealed by default. **Outside sharing is a deliberate plaintext
exception** (the shared trip + items become server-readable so a non-household
collaborator can read them). Trip attachments across households remain a known
design gap (a collaborator outside your household doesn't hold the key). See
[platform/crypto-e2ee.md](../platform/crypto-e2ee.md).

## Verification

- TripKey lifecycle: owner-household-only mint/rotate (compare-and-set),
  wrap-on-approve, collaborator-only member wraps, revoke → rotation, envelope
  cleanup on delete — `tripKeys.integration.test.js`.
- Sharing paths: sealed trips share without a 409 (stay sealed, D2), sealed-name
  invitation snapshots, TripKey-sealed records strip plaintext, decrypt-on-share
  for non-E2EE households, invite → accept collaborator flow, share-by-phone —
  `tripShare.integration.test.js` (+ `services/tripSharing.test.js` units).
- Attachments: encrypted upload stores crypto metadata, shared-booking uploads
  wrap Kf under the TripKey (D2), unwrapped uploads rejected —
  `tripAttachments.integration.test.js`.
- Trip detail decrypts what it fetched — `mobile/src/lib/__tests__/tripData.test.ts`:
  the trip AND every booking are opened (titles/locations readable, plaintext
  routing columns kept), a shared trip's TripKey is loaded before opening, a
  failed key load or unopenable blob still returns the trip, and a locked
  household skips the key load; same file: a sealed item write seals `placeId`
  with the content and strips its plaintext copy (which the item route wouldn't),
  while a write that couldn't seal keeps it plaintext like the location.
- The trips list's row split —
  `mobile/src/screens/trips/__tests__/TripsScreen.test.tsx`: pressing a trip
  card's body opens `TripDetail`, and pressing its trailing ⓘ opens `TripForm`
  on that trip (the trip view has no Edit action to fall back on).
- The day itinerary's blocks and travel bands —
  `mobile/src/components/__tests__/TripTimeline.test.tsx`: title + location +
  compact range render, an undecryptable title falls back to the booking type,
  a computed leg draws as a labelled band on the booking it leads into, tapping
  it cycles the mode and recomputes, a leg that outruns the gap is flagged, and
  a no-route mode keeps a tappable chip.
- The block's gestures — same file: a tap reports the booking to open (and never
  the one to edit), a press-and-hold reports the booking to edit.
- The booking view —
  `mobile/src/screens/trips/__tests__/TripItemDetailScreen.test.tsx`: the sealed
  booking is read through the shared fetcher and rendered (title, location, its
  time in the trip's timezone, booked state, confirmation, cost, notes), fields
  the booking doesn't have are absent, the header's edit action opens the form on
  the day it was opened from, and Delete Booking removes it only after the native
  confirm.
- The 24-hour canvas and its long-press — same file: the grid draws midnight to
  midnight, the day reports where it should open (first booking / 8 AM when
  empty), a press springs the ghost into the pressed 15-minute slot and then
  hands the form a one-hour draft (rolling onto the next date in the last hour),
  the ghost fades on regained focus, and a read-only timeline (no create
  handler) drafts nothing.
- A four-minute leg — same file: the band is drawn at its legible minimum and
  still names the true four minutes (the regression that made short hops
  invisible slivers).
- Budget/settlement math has no automated coverage yet (see Open questions).

- Reading a confirmation into a booking —
  `mobile/src/lib/__tests__/tripConfirmation.test.ts`: both journey legs
  flatten with their resolved timezones, a journey never takes the all-day
  flag, transit takes `mode` and drops the flight-only trio, a standard
  booking stays timed when clocks are quoted and infers all-day when none are,
  a same-day end normalizes to `''`, malformed dates/times (`June 6, 2026`,
  `2026-02-31`, `25:00`) are dropped rather than seeded, empty fields are
  omitted so a blank can't wipe the form, and a cost of zero survives.
- The import card's own rules —
  `mobile/src/screens/trips/__tests__/TripItemFormScreen.confirmation.test.tsx`:
  the card offers itself on a blank add form and is absent on an edit, it
  opens collapsed (the sources appear only once it is asked for), it holds
  three source buttons and no prose, the Photo button offers Take Photo /
  Choose Photo behind one native sheet and uploads whichever row is chosen,
  Paste shows the clipboard in the pad without sending it, "Read booking" posts the text and
  fills the form (type switching onto the journey branch, both airports
  resolved), the card retires once a draft lands, a failed parse keeps the
  pasted text and shows the server's reason, the file lane uploads under field
  `file`, and a cancelled picker does nothing at all.

## Open questions

- The confirmation import has no in-card disclosure that the confirmation's
  full contents (traveller names, addresses, ticket numbers, often a card's
  last four) leave the device readable. Every other booking field is E2EE, and
  the app's own AI rule keeps confirmation codes out of model context, so this
  path is the single exception and currently announces itself nowhere the user
  will see before tapping. Worth revisiting: a first-run-only notice, or a
  line in Privacy & security naming the flow.
- A hotel confirmation's `details.roomType` is parsed by the server but cannot
  be saved: the booking form's standard (non-journey) save branch builds no
  `details` object at all, so room type is dropped on import — and, separately,
  on any ordinary edit of a hotel that already had one. Either the standard
  branch should carry `details` through as the journey branch does, or the
  server should stop extracting a field nothing can store.
- Getting a confirmation into the app still means copying it out of Mail by
  hand. An iOS **share extension** ("Share → Calen") would make forwarding a
  confirmation the natural gesture it is on other travel apps, but it needs a
  new native target and an EAS rebuild, so it was left out of the first cut.
- Document the settlement algorithm (who-owes-whom minimization).
- Resolve cross-household trip-attachment encryption (currently plaintext on
  shared trips).
