---
title: AI assistant (Calen)
status: current
last-verified: 9282d82+ (2026-08-02); the household's **home area now fills itself from every way the home address gets set** — previously only picking an autocomplete suggestion derived it, so a GPS-filled ("Use my current location") or hand-typed address left the area empty until the user noticed the "Fill from home address" button (or until save, whose server-side backstop filled it invisibly and only when empty); `PlacesAutocomplete` gained an `onBlur(text)` pass-through and `AccountScreen` now derives on pick / GPS fill / address-field blur alike, guarded by the new pure `shouldDeriveHomeCity(address, derivedFrom)` (+ `homeCity.test.ts`) and a `cityFromAddress` ref seeded from the loaded (or decrypted) address so an idle blur or re-picking the same place never re-geocodes or clobbers a hand-set area (9282d82+, 2026-08-02); chat turns got a token-efficiency overhaul in `streamChat` (three independent cuts, no behavior change): (1) a **followups-only ending short-circuits the agentic loop** — when the model's final `tool_use` batch is nothing but `suggest_followups` and its reply text already streamed, the chips are harvested from the block and the turn ends without the acknowledgement API call that re-read the whole context to return `end_turn` (the loop still continues when real tools ran alongside or followups fired before any reply text); (2) a **moving conversation cache breakpoint** (`withMessageCacheMarker`, copy-on-write per request) rides the last content block of the last USER message so history + accumulated tool results are cache-read (~0.1× input) on every round trip instead of re-sent fresh — the last-user-message rule dodges post-`pause_turn` assistant tails whose `server_tool_use` blocks don't accept `cache_control`; 2 of 4 breakpoints used (system+tools was already cached); (3) **historical attachments are stripped server-side** — only the latest user message keeps raw base64 (`toApiContent(message, isLatestUserMessage)`); older image/PDF attachments become a "sent earlier — ask to re-attach" text note, ending the ~1.5k-token-per-image re-upload on every turn × round trip; loop behavior covered by the new fake-client harness `services/chatStream.loop.test.js` (+ `toApiContent` cases in `chatStream.format.test.js`); per-type token PRICING that makes these real-cost cuts visible in `creditsUsed` is billing-plans.md's (2026-07-31); chat is now TOKEN-PRICED — `chatStream` sums the turn's tokens and debits whole credits sized to the after-Apple token cost + margin (`recordChatCredits` → `credits.chatCreditsForTokens`; pricing owned by billing-plans.md), returns the charge as `done.creditsUsed`, and the shared `ChatScreen` shows "N credit(s)" under each assistant reply instead of raw tokens (`useChat` tracks `message.credits` + `sessionCredits`) (2026-07-30); the shared ChatScreen conversation scroll is now keyboard-aware (`hooks/useScrollAwareKeyboard`) — scrolling up to read history dismisses the keyboard (plus iOS `keyboardDismissMode="interactive"`), and scrolling back to the bottom re-opens it, but only when a scroll gesture (not a tap-away or a programmatic scroll) dismissed it (2026-07-30); composer dictation now splices the transcript in at the cursor captured at mic-press (`spliceDictation`, seam-spacing + selection replacement) instead of overwriting the whole field (2026-07-30); every chat assistant gained Anthropic's server-side `web_search` tool (max 3/turn, model-versioned variant via `webSearchTool`, `WEB_SEARCH_SYSTEM_NOTE` when-to-search nudge, `pause_turn` resume + "Searching the web…" activity hint in `streamChat`; web search is NOT charged separately — its result tokens are already in the token-priced chat debit, so `recordWebSearches` records count/cost for reconciliation only — pricing in billing-plans.md) (2026-07-30); assistant chats now persist **device-locally for 7 days** (`lib/chatHistory.ts`, per-user/per-surface AsyncStorage, base64-stripped, server stays stateless; initially shipped as 24h, widened to 7 days same day) with a header history clock → Recent-chats sheet to resume, and the destructive header "Clear" replaced by a compose new-chat action (`ChatHeaderButtons`) (2026-07-30); the Recent-chats sheet was then **unified across all four assistants** (`loadAllRecentChats` over every `hc_chat_history:<user>:*` surface, rows tagged with the tab icon via `surfaceToTab`; same-tab resume loads in place, cross-tab resume hands off through `requestResume`/`consumeResumeFor`/`peekResume` — `AssistantScreen.resumeAcross` selects the tab/trip, the target `useChat` claims the chat on mount); the sheet then gained a **keyword search** (`filterChats` — tokenized AND match over each chat's title + message text, scrollable results) (2026-07-30); replies now carry tappable place/search links (`lib/chatLinks` parsing the model's `place:`/`search:` markers per WEB_SEARCH_SYSTEM_NOTE — places open the new full-screen modal `PlacePreviewScreen` WebView on the Google Maps lookup, searches launch in the default browser; no raw URLs ever) (2026-07-30); the scroll keyboard's re-open trigger changed from "reach the bottom" to a deliberate finger-down **overscroll pull past the bottom** (>24px), working regardless of how the keyboard was closed; fling bounce overshoot doesn't count (2026-07-30); the calendar assistant gained `get_availability` — a computed free/busy planning lens (shared `deriveAvailability`) the model uses for "when am I free?"/"suggest a day" instead of enumerating events: timed events → busy hour-blocks, trips → whole "away" days, all-day events → a soft `allDayCommitments` note that keeps the day's hours free, and maintenance/chores/meals/grocery excluded as non-occupying; free time is computed in a household-local waking window (08:00–22:00, `Household.timezone`) (2026-07-30); the calendar assistant now knows the household's **home area** — a coarse `Household.homeCity` label (city + region/country, e.g. "Ottawa, Ontario, Canada") derived client-side from the saved home address (or set/overridden by hand on the Account screen) and injected into the system prompt so local suggestions ("suggest a family activity this weekend") match the actual area instead of being inferred from the timezone; the label is coarse and stored **plaintext** like `timezone` (never the street address, which stays sealed), so the server-side cloud model can read it; the area, when set, is also listed in the assistant's "what I can see" panel (`buildContextSummary`) (2026-07-30); tapping the send button now **dismisses the keyboard** (`Keyboard.dismiss()`) as the turn is sent so the reply is fully readable — the field is already emptied by `useChat.send`'s `setInput('')`, so submit drops the keyboard and clears the input together (2026-07-30); the calendar assistant's `open_create_event_form` tool gained a **`location`** parameter (and the handler emits `prefill_location`), and its schema + system prompt now direct the model to put a business/venue's name + street address in `location` and its number in `phone` rather than burying them in `description`/notes; the mobile "Save this to my calendar" direct-create path (`buildEventPayload`) now carries `location` onto the event record too (the "Edit in form" path already mapped it as a form field) (2026-07-30); tapping a **place** link now opens the native **Google Maps app** first (`openPlaceInGoogleMaps` — `comgooglemaps://` on iOS, gated by a new `comgooglemaps` `LSApplicationQueriesSchemes` entry in `app.json` + `ios/Calen/Info.plist`; `geo:` on Android) and only falls back to the in-app `PlacePreviewScreen` WebView when Maps isn't installed (2026-07-30); composer dictation now uses **`continuous`** recognition with a 10 s re-arming **silence timeout** (`SILENCE_TIMEOUT_MS`) so a mid-thought pause no longer cuts the user off, accumulates finalized segments across the session (`joinTranscript`) since continuous mode resets the recognizer's transcript per final result, and only trusts the caret snapshot while the composer is truly focused (`inputFocusedRef`) — otherwise new speech appends at the end instead of prepending at the start; the send button's imperative composer clear was also deferred to the next frame (`requestAnimationFrame`) so a controlled multiline `TextInput` on iOS reliably empties on submit instead of keeping the sent text (2026-07-30); sending while the mic is still capturing now **toggles dictation off** (`dictation.cancel()` → `abort()`, discarding the trailing result so it can't re-fill the cleared field), and the composer (text field + mic) is no longer gated on `chat.loading` so the user can type/dictate the next message while the current turn streams (it waits for the reply to send — `send` still no-ops mid-turn) (2026-07-30); the "Edit in form" prefill no longer highlights the always-present date/time/all-day fields as AI-filled — `EventFormScreen.applyPatch` gained an optional `noHighlight` key list, and the assistant-prefill effect passes `['allDay','date','startTime','endDate','endTime']` so only the fields the assistant genuinely populated (title, location, phone, notes, …) get the primary-colour outline (2026-07-30); the calendar assistant's drafted-event chips (`Save this to my calendar` / `Edit in form`) now **persist by default** instead of being consumed on any tap — `handleFollowup`'s "Edit in form" branch no longer calls `resolvePending()`, so the chips (and the draft) survive opening the form and returning; they're retired only on an actual create: the direct "Save this to my calendar" clears them itself, and saving from the pushed form fires `markAssistantEventDraftSaved()` (new `lib/assistantEventDraft` module store, watched by the assistant screen via `useAssistantEventDraftSavedTick`) which clears them — preventing a duplicate-create when the user saved in the form then returns (2026-07-30); the persist-until-created chip rule was then extended to the **chores** assistant and the draft-saved store generalized to `lib/assistantDraft` (keyed per surface — `markAssistantDraftSaved('calendar'|'chores')` / `useAssistantDraftSavedTick`): `ChoresAssistantScreen`'s "Review & add chore" chip no longer calls `resolvePending()` on tap and is retired only when `ChoreForm` saves a prefilled chore; the maintenance task-plan assistant (persistent footer) and the item-maintenance/trips assistants (plain suggestion chips only) need no change (2026-07-31); the drafted-record chips now **survive a resume from the Recent-chats sheet**, not just in-session navigation — `StoredChat` gained `followups`/`navSuggestions`/`pendingEvent`/`pendingChore`, `useChat` persists them alongside `messages` (and re-saves when they clear, so a consumed draft stores empty) and `applyResume` restores them instead of blanking them; the chores draft was moved off the screen ref into `useChat.pendingChore` (parallel to `pendingEvent`) so it persists/restores too; round-trip covered in `chatHistory.test.ts` (2026-07-31); the shared composer's primary button now **doubles as a Stop control while a turn is streaming** — during `chat.loading` it shows a stop glyph (not a spinner) and stays enabled, and tapping it interrupts the assistant via `useChat.stop` (the in-flight stream's aborter closes the `EventSource` and settles the request promise so `run`'s `finally` clears `loading`), keeping whatever streamed so far as the reply rather than discarding it; when idle it is the ordinary Send control (enabled only with text/attachments) (2026-07-31); an **unanswered user message can be resent inline** — when the last message is a user turn with no reply (the turn errored out, or was stopped before any text streamed) a resend icon appears to the left of that bubble and re-runs the conversation via `useChat.retry`; it's suppressed once a reply lands (the user bubble is no longer last) and when `quotaExceeded` (retry is futile — the buy-credits notice stands) (2026-07-31); turning **`aiUsePersonalInfo` off now also hides the calendar records from the assistant** — the device sends title-stripped free/busy availability (`availabilityForWindow` → shared `deriveAvailability`) instead of its decrypted `calendarSources`/focused event, and the server withdraws the record/edit/call tools (`list_events`, `get_event_details`, `open_edit_event_form`, `open_delete_event_form`, `call_business`, `check_call_status`), swaps in a reduced availability-only system prompt, serves the device-computed availability for `get_availability`, and reflects the narrower scope in the "what I can see" panel; the Privacy toggle helper copy states it (2026-07-31); the streaming "working" indicator (spinner + `toolActivity`) is now shown for the **whole** turn (gated on `chat.loading` alone) — it persists below the partial reply while the turn keeps generating (and surfaces mid-stream tool activity like "Searching the web…") instead of vanishing the instant the first token streamed (2026-07-31); the calendar assistant's system prompt (both full and privacy-mode variants) now opens with a **"Be concise"** directive — lead with the outcome, one or two sentences, no preamble/filler/restatement/sign-off, essential-details-only recaps — trimming response length without touching the required confirmations (2026-07-31); the shared ChatScreen conversation now **sticks to bottom only while pinned** (new `hooks/useStickToBottom`, testable `createStickToBottomTracker`) — a streaming reply follows the newest text only while the user is parked at the bottom (within 48px), and freezes in place the moment they scroll up (a floating jump-to-latest down-chevron re-engages following); pinning is sampled from user gestures only (never the frames a programmatic `scrollToEnd()` emits, which mid-animation would falsely un-pin), and a fresh user send always re-pins and snaps down while the assistant reply committing does not (df8c7f3+, 2026-07-31); every chat assistant now **verifies a business before recommending it** — a server-executed `verify_place` tool that `streamChat` auto-appends and handles inline (like `FOLLOWUPS_TOOL`, not per-route), running a single Google Places Text Search (`services/geo.js` `verifyPlaceStatus` → `places:searchText`, biased to the household's cached plaintext lat/lon) and returning `{ status, name, address, phone }` where status is operational / closed_temporarily / closed_permanently / unknown / not_found; `WEB_SEARCH_SYSTEM_NOTE` now tells the model to silently drop closed_permanently / not_found places from its shortlist (so a permanently closed place is filtered out ahead of time) and reuse the returned name/address/phone; it fails open to `unknown` on API error / missing key / per-turn `PLACE_VERIFY_MAX_USES` cap, is not credit-charged (Maps is unlimited on every tier — the cap only bounds volume), and surfaces a "Checking if it's still open…" activity hint from each assistant's `toolLabels` (df8c7f3+, 2026-07-31); FOLLOW-UP FIX (400 on verify) — the dynamic-filtering `web_search_20260209` runs each search inside a **code-execution container**, so a turn that both web-searches and ends on a client `tool_use` (verify_place, or any tool called right after a search) 400s ("container_id is required…") unless the continuation resends the same container; `streamChat` now captures the container id live from the raw `streamEvent` (`message_delta.container`, which `finalMessage()` drops) and threads it onto every follow-up/`pause_turn` request — also fixing the previously-latent case of `open_create_event_form` (etc.) co-occurring with a web search (df8c7f3+, 2026-07-31); the assistants are now **capability-aware about missing setup** — `suggest_navigation` gained a second **`setup`** destination class (`CONFIG_DESTINATIONS` in `services/navDestinations.js`, kept separate from `NAV_DESTINATIONS` so the every-turn `DEFAULT_NAV` fallback never picks one) offered **reactively** when a task hits a value the user hasn't configured: the model names what's missing and offers a **gear chip** (`kind:'setup'`, distinct from the arrow nav chip) that deep-links to the exact settings screen + field, which renders a shared `SetupCallout` banner (`components/ui.tsx`, extracted from EventLocation's phone callout) plus a field highlight; ids map to screens in `mobile/src/screens/chat/navDestinations.ts` — `setup_ai_personal_info`→PrivacyData(`focus:'aiPersonalInfo'`), `setup_home_address`→Account(`promptField:'homeAddress'`), `setup_event_phone`→EventLocation(`promptPhone`, needs the focused event via `navContext.eventId`), `setup_contact`→PersonForm(`focus:'phone'`), `setup_reminders`→Reminders(`promptEnable`), `setup_household`→Household(`promptInvite`); gap detection is server-side (augmented tool-result `setup_hint`s on `call_business`/`get_household_members`, the privacy-off reduced prompt, and the empty-home-area prompt branch in `calendarChat`); the chip payload carries only a screen id + label, no personal data (df8c7f3+, 2026-07-31); the chip model was then reworked to **inline, per-message, permanent** — chips (followups/nav) and the turn's drafted record moved off single top-level `useChat` state onto the `ChatMessage` itself (`followups`/`navSuggestions`/`pendingEvent`/`pendingChore`/`usedActions`), so `ChatScreen` renders each turn's chips under its own bubble and every past turn keeps its chips in scrollback, all still tappable (`onFollowupPress(text, msg, index)` reads the draft off that message); nothing is cleared on tap, and persistence/resume come free via the messages. The only non-clickable case is a one-shot direct-create chip already used: `Save this to my calendar` calls the new `chat.markActionUsed(index, label)` after creating, which flips it to visible-but-disabled (muted + check) so it can't duplicate — `Edit in form`/`Review & add chore` (form-openers) stay active. This **replaces** the prior persist-until-created / `assistantDraft` / resolvePending / StoredChat-level chip machinery (all removed: `lib/assistantDraft` deleted, `markAssistantDraftSaved` calls dropped from EventForm/ChoreForm, chores draft now on `useChat.pendingChore`); message-level round-trip covered in `chatHistory.test.ts` (2026-07-31); every assistant's system prompt now carries a `RESPONSE_FORMAT_NOTE` (appended centrally in `streamChat` so no route can omit it) telling the model to **never use markdown tables** — the app renders replies as plain text (`lib/markdown` has no table support, so a `| … |` table shows as raw pipes/dashes) — and to present availability/options/tabular data as short `Label: value` lines or a one-item-per-line bulleted list instead (df8c7f3+, 2026-07-31); tapping a **`nav` chip now drills in** instead of navigating away — `openNavSuggestion` pushes the target on top of the assistant so the live chat is preserved beneath it, and the `view_calendar` → headerless-root **CalendarHome** case (which a plain `navigate()` would pop the assistant behind, stranding the chat) is `push`ed with a new `fromAssistant` param that swaps the profile avatar for a "‹ Calen" return pill (plus iOS swipe-back) back into the conversation (df8c7f3+, 2026-07-31); the calendar assistant can now actually **edit and delete events on mobile** — previously `open_edit_event_form`/`open_delete_event_form` only returned a web `navigateTo` router path the RN app silently discarded, so no form ever opened, nothing was mutated, and the model (told "always confirm what you've done") hallucinated that forms had opened and events had been deleted; the tools were reworked to STAGE the action for a device-side confirm tap: `open_edit_event_form` stages `pendingEdit` → an "Open the event to edit" chip opening the native `EventForm { eventId, date }`, and `delete_event` (renamed from `open_delete_event_form`, callable once per event to batch a range) stages `pendingDeletes` → a single "Delete from my calendar" confirm chip whose tap runs the real deletes through the shared `lib/eventDelete` logic (`assistantDeletePerform` — one-off delete, or recurring `scope:'occurrence'`/`'series'` = exclude-day vs whole-series), retiring the chip on fire; both tools look the event up in the decrypted sources and refuse read-only calendars, the system prompt now forbids claiming any create/edit/delete before the user's confirming tap, and `pendingDeletes`/`pendingEdit` ride on the `ChatMessage` like `pendingEvent` (persist + resume for free) (df8c7f3+, 2026-07-31); the `fromAssistant` "‹ Calen" return pill moved from CalendarHome's profile-avatar slot to its bottom-right Calen-FAB slot (the avatar stays put; part of the calendar floating-chrome re-hierarchization — see calendar.md) (df8c7f3+, 2026-07-31); contact-import's professional web lookup is no longer a per-import opt-in toggle — choosing the AI-assisted method implies it (client always sends `enrich: true`; the import sheet's AI switch hint discloses the lookup) (df8c7f3+, 2026-08-01)
code:
  - mobile/src/screens/chat/
  - mobile/src/hooks/{useChat,useDictation,useScrollAwareKeyboard,useStickToBottom}.ts
  - server/src/routes/{calendarChat,choresChat,maintenanceChat,maintenancePlanChat,tripsChat}.js
  - server/src/routes/{calls,formAssist}.js
  - server/src/services/{chatStream,aiUsage,phoneCalls,dnc,phone,geo,navDestinations}.js
  - server/src/middleware/aiConsent.js
  - server/src/models/{PhoneCall,DncEntry}.js
  - mobile/src/lib/aiPayload.ts
  - mobile/src/lib/chatHistory.ts
  - mobile/src/lib/chatLinks.ts
  - mobile/src/lib/homeCity.ts
  - mobile/src/screens/profile/AccountScreen.tsx
tests:
  - server/src/test/aiPrivacy.integration.test.js
  - server/src/services/phoneCalls.test.js
  - server/src/services/navDestinations.test.js
  - server/src/middleware/usageMeter.tokens.test.js
  - mobile/src/lib/__tests__/{aiPayload,aiWindow,chatHistory,chatLinks,homeCity}.test.ts
  - mobile/src/hooks/__tests__/{useScrollAwareKeyboard,useDictation}.test.ts
  - mobile/src/screens/chat/__tests__/navDestinations.test.ts
---

# AI assistant (Calen)

## Purpose

"Calen" is the in-app assistant, surfaced per area (calendar, chores,
maintenance-plan, trips). It answers questions, drafts records, and can place
**outbound phone calls** (e.g. cancel/reschedule an appointment) via Vapi. It
runs on Anthropic Claude (default to the latest models — see `docs/` claude-api
reference).

## Behavior (normative)

### Chat surfaces

- Each area exposes a chat router at `/api/<area>/chat` with a common shape:
  `GET`/`POST /context` (the records the assistant may reason over) and
  `POST /` (the streamed turn, SSE via `services/chatStream.js`). The shared
  mobile `ChatScreen` drives all of them.
- Because content is E2EE, the server can't read records to build context. The
  device decrypts only the consented records and sends them with the request
  (the `POST /context` variant accepts client-supplied decrypted records);
  responses are not stored.
- **Prompt caching (both breakpoints, `services/chatStream.js`).** Every API
  call in the agentic loop caches TWO prefixes (of the 4 breakpoints the API
  allows): (1) the system prompt + tool definitions as one block
  (`buildCachedSystem` — tools render before system, so a breakpoint on the
  last system block covers both), and (2) a **moving conversation breakpoint**
  (`withMessageCacheMarker`) on the last content block of the **last user
  message**, applied copy-on-write per request so markers never accumulate in
  the stored history. The moving marker makes round trip N read round trip
  N−1's history + tool results at the ~0.1× cache-read rate instead of
  re-sending them as fresh input, and a follow-up turn within the 5-minute
  ephemeral TTL reads the whole prior turn. The marker targets the last USER
  message (not the last message outright) because after a `pause_turn` the
  tail is an assistant message holding `server_tool_use`/web-search blocks,
  which don't accept `cache_control`; a user message's last block is always
  text/image/document/tool_result — all cacheable.
- **Response style — the calendar assistant is terse.** Its system prompt
  (`calendarChat.buildSystemPrompt`, both the full and privacy-mode variants)
  opens with a "Be concise" directive: lead with the outcome/answer, keep
  replies to a sentence or two, and drop preamble, acknowledgements, filler
  ("Great!", "I'd be happy to"), request restatements, narration of intent, and
  sign-offs. Recaps of a drafted event or confirmed action carry only the
  essential details (date, time, place), not a full description; expand only
  when the user asks. This governs length/tone only — it does not remove the
  required confirmations (recap-before-save, "nothing is saved until you tap").
- Follow-up chips come from the `suggest_followups` tool inside the same
  streamed turn (`services/chatStream.js`). The tool is fire-and-forget: when
  the model ends its turn with ONLY `suggest_followups` calls and its reply
  text has already streamed, `streamChat` harvests the chips from the
  `tool_use` block and ends the turn WITHOUT the acknowledgement round trip
  (the `{"ok":true}` tool result is never sent — the extra API call re-read
  the whole context just to return `end_turn`). The loop still continues
  normally when real tools ran alongside (their results matter) or when
  followups fired before any reply text (the model must still write the
  reply). `POST /form-assist` powers one-shot "fill this form from a
  photo/text" flows.
- **Web search**: every chat assistant (calendar, chores, item maintenance,
  task plan, trips) carries Anthropic's **server-side `web_search` tool**
  (`webSearchTool(model)` in `services/chatStream.js` — the `_20260209`
  dynamic-filtering variant on Sonnet/Opus, the basic `_20250305` on Haiku;
  `max_uses: 3` per turn), so Calen can look up current real-world information
  — businesses, hours, prices, ideas — when the household's data can't answer.
  Searches execute inside the API call (no `executeTool` handler);
  `streamChat` handles the `pause_turn` stop reason (server tool loop cap —
  append the partial assistant turn and re-send to resume), surfaces a
  "Searching the web…" activity hint from `server_tool_use` stream events,
  and tallies `usage.server_tool_use.web_search_requests` only to record the
  per-search cost for reconciliation — it is NOT charged separately, since the
  search's result tokens are already in the token-priced chat debit (see Usage
  metering). A one-line system note
  (`WEB_SEARCH_SYSTEM_NOTE`, appended by every chat route) tells the model
  when to search and to never search for the household's private data.
- **Tappable places & search suggestions**: the same system note instructs the
  model to mark up two link forms — `[Name](place:Name, City)` for a specific
  business/venue/public place, and `[search "query"](search:query)` for a web
  search the user could run — and to **never emit raw URLs** (the client
  builds every URL, so a malformed or hostile URL can't ride a reply).
  `lib/chatLinks.ts` parses replies into text/link segments (markdown
  flattened; a half-streamed trailing marker is held back so raw markup never
  flashes mid-stream) and `ChatScreen` renders them as pressable link text:
  a **place** first tries to hand the lookup to the **native Google Maps app**
  (`openPlaceInGoogleMaps` — iOS `comgooglemaps://?q=…` gated by `canOpenURL`
  against the `comgooglemaps` `LSApplicationQueriesSchemes` entry, Android the
  `geo:` intent); when Maps isn't installed / can't take the link it falls back
  to `PlacePreviewScreen` — a full-screen modal WebView on the Google Maps place
  lookup (`https://www.google.com/maps/search/?api=1&query=…`, no Places API
  key), title = the tapped name, header compass opens the same lookup externally
  (Maps app/browser); closing the modal resumes the conversation exactly where
  it was. A **search** launches the query in the
  user's default browser (`Linking.openURL` on a Google search URL). Ordinary
  markdown links keep flattening to plain text.
- **Plain-text replies, no tables**: the app has no markdown renderer —
  `lib/markdown` only flattens headings, bullets, bold/italic, inline code, and
  links, so a markdown table arrives as unreadable raw pipes and dashes. Every
  assistant's system prompt therefore carries a `RESPONSE_FORMAT_NOTE` (appended
  centrally in `streamChat`, so it can't be forgotten per route) telling the
  model to **never use markdown tables** and to present availability, options,
  or any tabular data as short labeled lines (`Label: value`) or a simple
  one-item-per-line bulleted list instead.
- **Place verification (open / permanently closed)**: web search and the model's
  own knowledge can surface a business that has since closed, so before Calen
  recommends a specific business or venue it calls **`verify_place`** — a
  server-executed tool `streamChat` auto-appends to every assistant (like
  `FOLLOWUPS_TOOL`, not declared per-route) and handles inline. It takes a
  free-text `query` (name + city, e.g. `"Republica Café, Ottawa ON"`), runs a
  Google Places **Text Search** (`services/geo.js` `verifyPlaceStatus` →
  `places:searchText`, one call, biased to the household's cached plaintext
  lat/lon), and returns `{ status, name, address, phone }`. `status` is
  `operational`, `closed_temporarily`, `closed_permanently`, `unknown` (Google
  publishes none — treat as OK), or `not_found` (no match). The
  `WEB_SEARCH_SYSTEM_NOTE` directs the model to **silently drop** any place that
  is `closed_permanently` / `not_found` and offer a different one — so a
  permanently closed place is filtered out of the shortlist ahead of time — and
  to reuse the returned name/address/phone when naming the place or pre-filling a
  form. The lookup **fails open**: an API error, a missing key, or hitting the
  per-turn cap (`PLACE_VERIFY_MAX_USES`) yields `status: 'unknown'` so an outage
  never suppresses good suggestions. Like the other internal Places calls it is
  **not credit-charged** (Maps is unlimited on every tier); the per-turn cap only
  bounds runaway volume. The client shows a "Checking if it's still open…"
  activity hint (each assistant's `toolLabels`).
  - **Code-execution container threading**: the dynamic-filtering
    `web_search_20260209` variant runs each search *inside* a code-execution
    container, so when a turn also ends on a client `tool_use` (verify_place, or
    any tool the model calls right after searching) `streamChat` must resend the
    history with the **same `container` id** or the API 400s ("container_id is
    required when there are pending tool uses generated by code execution"). The
    id is only exposed on a raw stream event (`message_delta.container`) —
    `finalMessage()` drops it — so `streamChat` captures it live from
    `streamEvent` and threads it onto every follow-up/`pause_turn` request. This
    also covers the previously-latent case of any client tool (e.g.
    `open_create_event_form`) being called in the same turn as a web search.
- **Navigation & setup shortcuts** (`services/navDestinations.js` ↔
  `mobile/src/screens/chat/navDestinations.ts` — the `view` ids must stay in
  sync). The `suggest_navigation` tool lets the model offer a **one-tap chip**
  under its reply that deep-links into the app; the chip only records a
  suggestion, it never navigates on its own. Two kinds:
  - **`nav`** (arrow chip) — "go look at / act on" a screen. Each surface has a
    small catalog (`NAV_DESTINATIONS`); the prompt tells the model to end every
    reply by offering the single most relevant one (with a `DEFAULT_NAV`
    fallback via `ensureActionableNav`, skipped when a review/save chip is
    already the next step). Tapping a nav chip **drills in** — the target is
    pushed on top of the assistant so the live conversation is preserved beneath
    it, and every target carries a back affordance to return to the chat. Most
    screens use their own header back button; the one exception is
    `view_calendar` → **CalendarHome**, which is the headerless app root and
    already sits below the assistant on the stack, so `openNavSuggestion`
    `push`es a fresh instance flagged `fromAssistant` rather than `navigate`ing
    (which would pop the assistant off and strand the chat). A `fromAssistant`
    CalendarHome swaps its bottom-right Calen FAB for a "‹ Calen" return pill
    (and iOS swipe-back) that pops back into the conversation with full state —
    the return affordance sits where the chat was launched from, and the
    profile avatar stays put.
  - **`setup`** (gear chip) — **guided configuration for an actionable gap.**
    When a task needs a value the user hasn't configured, the assistant is
    **capability-aware**: instead of a dead-end "you need to set X", it names
    what's missing and offers the matching setup chip, which deep-links to the
    exact settings screen **and field** — arriving with a `SetupCallout` (a
    tinted banner stating why the user is there) plus a highlight on the field
    to fill (`components/ui.tsx SetupCallout`). Surfacing is **reactive only**:
    a chip appears when a task actually hits the gap (a tool result reports the
    value is missing, or the prompt state shows it unset) — there is no
    proactive scan of everything unconfigured. Setup destinations live in a
    **separate** `CONFIG_DESTINATIONS` map (an `all` group applied to every
    surface + per-surface groups) so the "offer one next-step every turn"
    fallback never picks a setup screen; a setup chip **replaces** the usual
    next-step chip the turn it applies (still one chip). The chip payload
    carries only a screen id and label — **no personal data** — consistent with
    the data-minimization rules below. The current setup destinations:

    | id | Chip | Surfaces | Offered when | Deep-links to |
    |----|------|----------|--------------|---------------|
    | `setup_ai_personal_info` | Turn on personal info | all | request needs events/household/contacts but "Use personal & contact info" is off | Privacy & data → AI card (`PrivacyData { focus: 'aiPersonalInfo' }`) |
    | `setup_household` | Set up your household | all | user wants to share/assign/invite but no household members exist | Household (`{ promptInvite: true }`) |
    | `setup_home_address` | Add your home address | calendar, trips | weather/local/travel ask with no home area set | Account (`{ promptField: 'homeAddress' }`) |
    | `setup_event_phone` | Add business phone | calendar | `call_business` on a focused event with no phone on file | that event's location form (`EventLocation { eventId, promptPhone: true }`) |
    | `setup_contact` | Add this contact | calendar | user wants to call/email a professional not saved / with no number | Person form phone section (`PersonForm { type:'service', focus:'phone' }`) |
    | `setup_reminders` | Set up reminders | calendar | user wants alerts but reminders are off / no time set | Reminders (`{ promptEnable: true }`) |
- **Chat history is device-local, 7 days** (`lib/chatHistory.ts`): the four
  main assistant surfaces (calendar, chores, maintenance-plan, and per-trip
  chats — `historyKey` on `useChat`) persist conversations to AsyncStorage as
  they grow, keyed per user AND per surface so accounts sharing a device never
  see each other's chats. **Nothing is stored server-side** — the chat API stays
  stateless (a resumed chat simply re-POSTs its `messages` like any turn), so no
  transcript exists off-device beyond the in-flight request. Retention is 7 days
  from last activity (pruned on read and write; capped at 50 per surface);
  attachment base64 payloads are stripped before persisting (the server
  renders any history attachment without live bytes as a text note — see the
  historical-attachment rule under Data minimization). Each assistant
  turn's **chips + drafted record ride on the message itself** (`ChatMessage`
  carries `followups`/`navSuggestions`/`pendingEvent`/`pendingChore`/`usedActions`
  — see the drafted-record chips bullet below), so persisting the messages
  persists — and a resume restores — every past turn's inline affordances,
  including which one-shot chips were already used (rendered disabled). Header
  actions
  (shared `ChatHeaderButtons`): a **history clock** opens a Recent-chats sheet
  and the old destructive "Clear" is now a **compose (new chat)** action — it
  rotates the conversation id and resets the screen; the previous conversation
  stays resumable from history until it expires. Signed out (no user id),
  nothing persists.
- **The Recent-chats sheet is unified across all four assistants**
  (`loadAllRecentChats` reads every `hc_chat_history:<user>:*` surface for the
  signed-in user): calendar, chores, maintenance-plan, and every per-trip chat
  appear in one list, newest first, each row tagged with its **assistant's tab
  icon** (`surfaceToTab` → `ASSISTANT_TABS`, tinted with that area's accent) and
  a "`Tab · 3h ago · N messages`" line. Tapping a row **resumes** it: a chat on
  the surface already showing loads **in place** (`resumeChat`, guarded on
  `surfaceKey`); a chat from another assistant **hands off** — the target tab is
  selected (and, for a trip chat, its trip pre-selected from the `trips:<id>`
  key so the picker is skipped), then the target surface's own `useChat` claims
  the conversation on mount via a one-shot resume channel
  (`requestResume`/`consumeResumeFor`/`peekResume` in `chatHistory.ts`). Inside
  the unified `AssistantScreen` the hand-off is an in-place body swap
  (`onResumeExternal` → `resumeAcross`); from a standalone surface (a trip's own
  assistant) it navigates into `AssistantScreen`, which reads the parked request
  to pre-select the trip. Resuming restores the transcript and credit total, not
  per-turn ephemera (follow-up chips, drafted records), and bumps the chat's
  timestamp so it won't expire mid-conversation. A **keyword search** field at
  the top of the sheet filters the list live (`filterChats`): each
  whitespace-separated token must appear (case-insensitive) in a chat's title OR
  any of its messages, so the match is on **conversation content**, not just the
  title, and multiple words narrow (AND, any order). The sheet is sized tall
  (list height ~72% of the screen, sheet capped at 92% — roomy but not
  full-screen) and the rows scroll within it; the query resets each time the
  sheet closes.
- **Scroll-aware keyboard** (shared across every chat surface via
  `hooks/useScrollAwareKeyboard`): a scroll gesture that moves **up** through
  the conversation dismisses the keyboard so the whole screen reads history
  (iOS additionally gets the native finger-tracking dismissal,
  `keyboardDismissMode="interactive"`). The keyboard is **summoned back only
  by a deliberate finger-down pull PAST the bottom** (into the overscroll
  bounce, > 24px) — merely scrolling to the bottom never opens it (the user
  usually wants to read the newest message first), and neither does screen
  open, the new-message auto-scroll, or a fling whose momentum overshoots
  into the bounce after the finger lifted. The summon gesture works however
  the keyboard was closed (scroll-dismiss or tap-away), re-pins the newest
  message when the keyboard rises, and the bounce spring-back never counts
  as scrolling up.
- **Stick-to-bottom while a reply streams** (shared via
  `hooks/useStickToBottom`): the conversation auto-follows the newest streaming
  text **only while the user is parked at the bottom** (within 48px). Scroll up
  to read and the view **freezes where you left it** — tokens keep arriving
  below but the screen holds still — instead of being yanked back down on every
  chunk. Scrolling back to the bottom (or tapping the **jump-to-latest** button —
  a floating down-chevron that appears whenever you're scrolled up, hidden on the
  empty state) re-engages following and snaps to the newest text. Pinning is
  sampled from **user gestures only** (drag / fling settle), never from the
  frames a programmatic `scrollToEnd()` emits — mid-animation the offset lags the
  true bottom, and trusting it would falsely un-pin and kill the follow. A **fresh
  user send always snaps to the bottom and re-engages** following (you want to see
  your message and the reply landing under it); the assistant reply committing at
  end-of-turn does **not** force a scroll if you've scrolled up. The pin/unpin
  state machine is factored into a testable `createStickToBottomTracker`
  (`useStickToBottom.test.ts`).
- **Submit dismisses the keyboard.** Tapping the send button dismisses the
  keyboard (`Keyboard.dismiss()`) as the turn is sent, so the incoming reply is
  fully readable without a manual tap-away. The composer's text field is
  cleared by the send itself (`useChat.send` → `setInput('')`) **and** flushed
  imperatively via the input ref (`inputRef.current?.clear()`) — a controlled
  multiline `TextInput` doesn't reliably push the empty value to the native
  field when it blurs on the same tick as the keyboard dismissal, so the ref
  clear guarantees the visible text goes away. On submit the input empties and
  the keyboard drops together.
- **Working indicator persists for the whole turn.** While `chat.loading` a
  thinking bubble (spinner + optional `toolActivity` label) is shown on the
  assistant side for the entire turn — below the last user message before any
  text arrives, then below the partial reply once it begins streaming (the turn
  is still working: more text may come, or a mid-stream tool like "Searching the
  web…" whose activity would otherwise be invisible once text has started). It
  clears when the turn resolves and the streamed text is committed as the reply.
  (It is not gated on `!streamingText`, which previously hid it the instant the
  first token arrived.)
- **Send button becomes a Stop button mid-turn.** While a turn is streaming
  (`chat.loading`) the composer's primary button swaps its up-arrow glyph for a
  **stop** icon and stays enabled; tapping it interrupts the assistant
  (`useChat.stop` → the in-flight stream's aborter closes the `EventSource` and
  settles the request promise, so `run`'s `finally` clears `loading`). Whatever
  the assistant had streamed so far is **kept** as its reply (the same partial
  salvage the stream-error path does), not discarded. `stop` is a no-op when
  nothing is running. When idle the button is the ordinary Send control, enabled
  only when there's text/attachments to send.
- **Unanswered user message can be resent inline.** When the last message is a
  user turn that never got a reply — the turn errored out, or the user stopped it
  before any text streamed — a **resend** icon appears to the left of that user
  bubble; tapping it re-runs the same conversation (`useChat.retry`, which
  re-sends `messages` when the last one is a user turn). It shows only when the
  bubble is genuinely unanswered: a delivered turn always appends an assistant
  message (so the user bubble is no longer last) and hides it, and an
  out-of-credits turn (`quotaExceeded`) can't be retried so it's suppressed there
  too (the buy-credits notice stands instead). This is in addition to the error
  box's own Retry link.

### Voice input — dictation (normative)

The shared `ChatScreen` lets the user **dictate** to Calen on every assistant. A
mic button in the composer (`hooks/useDictation.ts`) starts on-device speech
recognition (`requiresOnDeviceRecognition: true`, `expo-speech-recognition`); the
live transcript streams into the text field so the user reviews/edits before
sending. Recognition is **`continuous`** — a natural mid-thought pause no longer
ends the session (which cut users off and dropped the next words); it keeps
listening until the user taps the mic again or a **silence timeout**
(`SILENCE_TIMEOUT_MS`, 10 s, re-armed on every speech result) auto-finalizes an
abandoned session. Continuous mode streams one utterance segment at a time and
resets the recognizer's transcript after each final result, so the hook
accumulates finalized segments and re-joins the live one (`joinTranscript`) —
the composer always receives the whole utterance since mic-press, preserving the
single-shot splice contract. Dictation **augments the field, never replaces it**:
the text around the cursor is snapshotted when the mic is pressed and each
interim result is spliced in at that spot (`spliceDictation` — a space is added
at either seam unless the neighboring text already has one; a selected range is
replaced). The caret snapshot is **only trusted while the field is actually
focused** (`inputFocusedRef`); when it isn't — the common speak-pause-tap-again
flow, where a programmatic transcript can leave the reported caret at 0 — words
append at the **end** instead of prepending at the start. So dictating into a
half-typed message keeps what was typed.
Tapping **send while the mic is still capturing toggles dictation off**
(`dictation.cancel()` — `abort()` discards the in-flight utterance so a trailing
final result can't re-populate the just-cleared field). The composer stays live
**while a turn is streaming**: the text field is editable and the mic is
enabled during `chat.loading` (only the screen-level `disabled` gate silences
them), so the user can type or dictate the next message in the background — it
simply waits until the reply lands to be sent (one turn at a time; `send` no-ops
while `loading`).
**Nothing is sent until they tap send** — it is ordinary typed input by
voice, running through the exact same `POST /<area>/chat` request (same E2EE-safe
`buildBody`, same tools, same token metering) with **no new server path and no
audio leaving the device**. Microphone + speech-recognition permission is
requested on first use; denial surfaces a settings prompt, not a crash. Dictation
is transcription only — it adds no cost of its own; a sent message costs the same
as if it were typed. `aiEnabled` hard-gates the surface. (There is no hands-free
"voice mode" / spoken read-back — that was removed.)

### Consent & data minimization (normative)

- AI is **consent-gated**: the `aiEnabled` / `aiUsePersonalInfo` prefs hard-gate
  every surface — with AI off, the assistant is unusable and scans/extracts are
  blocked. Every AI surface shows a "sent to Anthropic" indicator. Both toggles
  live in the **Artificial intelligence** card under Profile → Privacy & data
  (`PrivacyDataScreen`), alongside the other privacy controls — not on the
  billing/Credits screen.
  `aiEnabled` is **also enforced server-side**: the pref syncs to
  `User.aiEnabled` and `middleware/aiConsent.js` returns 403 on every AI route
  when it is off, so a client that bypasses the app UI cannot spend AI actions.
  `aiUsePersonalInfo` gates the surfaces that put contact/personal detail in a
  prompt: the calendar assistant omits the people roster, form-assist omits its
  contacts context, and **AI-assisted contact import** (which classifies contact
  names/companies) is hidden in favor of Direct import — turning that surface off
  requires this pref on as well as `aiEnabled`.
  `aiUsePersonalInfo` off **also withholds the calendar records themselves**
  (normative): the device stops sending its decrypted `calendarSources` (and any
  focused event) and instead sends only **title-stripped free/busy availability**
  (`availabilityForWindow` → the shared `deriveAvailability`, with event titles,
  all-day names, and trip names removed). The server, seeing
  `includePersonalInfo: false`, **withdraws the record tools** — `list_events`,
  `get_event_details`, `open_edit_event_form`, `delete_event`,
  `call_business`, `check_call_status` — from the tool list (and refuses them in
  `executeTool` as defense-in-depth), swaps in a reduced system prompt, and serves
  the device-computed availability for `get_availability`. So with the toggle off
  the assistant can plan around when the user is free/busy, create brand-new
  events, and use weather/web/navigation, but never sees event titles or details
  and can't read, edit, cancel, or place calls about a specific event. The
  assistant's "what I can see" panel (`buildContextSummary`) reflects the reduced
  scope (availability only), and the Privacy toggle's helper copy states it.
- Payloads are **minimized** (`mobile/src/lib/aiPayload.ts`): database
  identifiers are stripped and replaced with per-conversation aliases before
  anything leaves the device. No account identifiers are sent; requests egress
  from the server, not the user's IP. See
  [operations/transparency.md](../operations/transparency.md).
- Payloads are also **query-scoped** (Signal-parity G4): the calendar assistant
  sends only a conversation-derived **date window** of decrypted sources
  (recurrence-safe), not the whole calendar — so a single question never ships
  the full history.
- **Friends & family are name-only.** For people of type `family`/`friend`, no
  field other than the name (plus a family/friend grouping and an is-you marker)
  may appear in any AI payload — no birthdays, ages, addresses, relationships,
  or notes. Consequences accepted by design: the assistant cannot see
  the birthdays calendar, and form-assist cannot fill a friend's address.
  **Professionals (`service` contacts) share the business details the user saved
  them for** — service (their `relationship`, e.g. "plumber"), business name, and
  address. Phone and email stay "on file" (see references-not-values below): the
  calendar assistant sees only `phoneOnFile`/`emailOnFile` presence flags, never
  the values. (Form-assist, whose contacts context is professionals-only, sends
  professional phone as a value for form-filling; the calendar chat does not.)
- **Home area is coarse, not the street address.** The calendar assistant's
  system prompt includes the household's **general area** — `Household.homeCity`,
  a city-level label (city + region/country, e.g. "Ottawa, Ontario, Canada") —
  so location-aware suggestions match where the household actually is instead of
  the model guessing from the timezone. This is the one geographic value put in a
  prompt, and it is deliberately coarse: the **street address is never sent**
  (it stays sealed under E2EE and is only used, client-side, to derive the city).
  `homeCity` is derived client-side from the saved address (same keyless
  geocoders as `householdTimezone`, so an E2EE household resolves it without the
  address touching our server) and can be edited/overridden by hand on the
  Account screen. **Setting the home address any way fills the area
  automatically** — picking an autocomplete suggestion, filling it from GPS
  ("Use my current location"), or typing one by hand and leaving the field —
  each doing exactly what the "Fill from home address" button does, so the area
  is never left empty just because the address wasn't picked from the dropdown.
  The automatic fill only runs when the address actually changed from the one
  the shown area came from (`shouldDeriveHomeCity`), so an idle focus/blur or
  re-picking the same place never re-geocodes or clobbers a hand-set area; the
  manual button (offered whenever the area is empty and an address is set) always
  re-derives on demand, and saving a changed address still fills an empty area
  server-side as a backstop for a geocode that failed or never ran. It is stored
  **plaintext** like `timezone` — coarse enough to be non-sensitive, and readable
  by the server so the cloud model can use it.
  When set, the area is also surfaced in the assistant's **"what I can see"
  panel** (`buildContextSummary` → `context.sees`) as "Your general area — <city>
  (for local suggestions; never your street address)", so the capability card
  honestly reflects that the assistant knows roughly where the household is.
- **Rosters and record bodies are fetched on demand, not front-loaded.** The
  calendar system prompt contains no people; the model calls
  `get_household_members` when a conversation needs them — returning household &
  friends by name only, plus any saved professionals with their business details
  (phone/email as "on file" flags). `list_events` returns titles/dates/recurrence
  only; `get_event_details` returns one event's description/location on request.
- **Planning runs off availability, not event enumeration.** The calendar
  assistant exposes `get_availability(from, to)` — a computed **free/busy** view
  the model reaches for on planning questions ("when am I free?", "suggest a day
  for X", "find an open weekend") instead of reasoning over every event itself.
  It derives from the same client-decrypted, query-scoped sources as
  `list_events` (shared engine `deriveAvailability`, see
  [calendar.md](calendar.md)) and reports each day as `free` / `partial` / `busy`
  / `away` with busy hour-blocks + free gaps inside a household-local waking
  window (08:00–22:00, timezone from `Household.timezone`). The busy/free rule —
  **normative**:
  - **Busy (hour blocks):** timed events (activities + appointments).
  - **Away (whole day):** trip date ranges.
  - **Soft flag (day noted, hours kept free):** all-day events surface as an
    `allDayCommitments` note but do **not** block the day — an all-day entry may
    be a genuine commitment or just a label, so it is surfaced for the user to
    judge, never auto-blocked.
  - **Never counted:** maintenance tasks, chores, meals, grocery days, and
    occasions are reminders/plans, not occupied time, and are excluded entirely.

  Availability is also **privacy-positive**: a free/busy block leaks far less
  than an event title, so this lens is the minimal shape for the planning
  questions it serves. `list_events`/`get_event_details` remain the path when the
  user wants to know *what* is scheduled or the model needs an event id to edit,
  delete, or call about — **but only while `aiUsePersonalInfo` is on.** With that
  toggle off, availability becomes the *sole* calendar lens: the device sends
  title-stripped free/busy in place of the records, `get_availability` serves it,
  and the record tools are withdrawn (see the `aiUsePersonalInfo` bullet above).
- **Drafted events use the structured fields, not free-text notes.**
  `open_create_event_form` prefills the create form (the user still reviews and
  saves — nothing is written directly). When an event happens at a business,
  venue, or address, the model puts the **place name + full street address in the
  `location` field** and the **business number in the `phone` field** (which
  Calen later dials for cancel/reschedule) — never buried in `description`.
  `description` is for extra notes only. Details a web search surfaced (venue
  name, address, phone) are carried into `location`/`phone` the same way. Both
  the "Save this to my calendar" (direct create) and "Edit in form" paths
  preserve `location`/`phone` onto the event record (`location` and `phone` are
  first-class event fields — see [calendar.md](calendar.md)). On "Edit in form",
  the fields the assistant actually populated (title, location, phone, notes, …)
  are **highlighted** as AI-filled, but the always-present date/time/all-day
  fields are **not** — every event carries those (the form seeds defaults), so
  outlining them as "AI changed this" is noise, not signal.
- **Edits and deletes are staged server-side and confirmed by a tap — never
  silently applied, never falsely claimed.** The server tools only STAGE the
  action; the mutation happens on the device when the user taps the confirm chip
  (`CalendarAssistantScreen.handleFollowup`). The model's system prompt forbids
  claiming an event was changed or deleted before that tap.
  - `open_edit_event_form` (looks the event up in the decrypted sources, rejects
    read-only calendars) stages `pendingEdit` and pins an **"Open the event to
    edit"** chip that opens the native edit form (`EventForm { eventId, date }`)
    on the user's device; the user makes and saves the change there. (It no longer
    returns a web `navigateTo` route — that path did nothing on mobile, which is
    what let the model believe a form had opened when none had.)
  - `delete_event` stages a deletion into `pendingDeletes` and is meant to be
    called **once per event** — several in one turn accumulate under a **single**
    "Delete from my calendar" confirm chip so "clear my calendar next week"
    removes them all in one tap (a "Cancel, keep events" chip falls through to an
    ordinary send). On confirm, each staged event is resolved against the
    decrypted sources (raw ids match the resolved staged ids) and deleted through
    the **same `lib/eventDelete` logic as the native form** — a one-off is a plain
    delete; a recurring event removes just the `occurrenceDate` day (`scope:
    'occurrence'`, the default) or the whole series (`scope: 'series'`), the model
    choosing (or asking) which. The confirm chip is retired (`markActionUsed`)
    after it fires so it can't double-delete; only Activities/Appointments events
    are eligible (maintenance/chores/meals/grocery/trips are read-only here).
- **Chips are inline, per-turn, and permanent in scrollback.** Every assistant
  turn's chips — suggested replies, action chips (`Save this to my calendar` /
  `Edit in form` / `Review & add chore`), and nav/setup suggestions — render
  **under that turn's own bubble**, not as a single row at the bottom tied to the
  latest turn. They ride on the `ChatMessage` (`followups`/`navSuggestions`, plus
  the turn's drafted record in `pendingEvent`/`pendingChore` and any spent chips
  in `usedActions`), so as the conversation scrolls, **every past turn keeps the
  chips it offered at the time**, and all of them stay tappable — a chip on an
  older turn acts on *that turn's* draft (`onFollowupPress(text, msg, index)`
  reads `msg.pendingEvent`/`msg.pendingChore`, never a single shared "latest
  draft"). Because chips live on messages, persisting/restoring the conversation
  (history + resume) carries them automatically; there is no separate chip state
  and no clearing on tap.
  - **The one exception is a direct-create chip once used.** `Save this to my
    calendar` creates the event immediately, so re-tapping it would duplicate.
    After it fires, the screen calls `chat.markActionUsed(index, label)`, which
    records the label in that message's `usedActions`; the chip then renders
    **visible but disabled** (muted, a check glyph, no press) — it stays in the
    transcript as a truthful record of what was done, but can't run again.
  - **Form-opening chips are never disabled.** `Edit in form` and
    `Review & add chore` only open a prefilled form (the form owns the save), so
    re-tapping is harmless and they remain active. (Trade-off: the app does not
    try to detect a save made *inside* the form to also disable the sibling
    create chip — only the one-tap create guards itself.)
  - **Surfaces without action chips need nothing extra:** the **maintenance
    task-plan** assistant stages proposed tasks in a persistent footer, and the
    **item-maintenance** and **trips** assistants pin only ordinary suggestion
    chips (tapping one sends a turn) — all of which now simply live inline on
    their turns like everything else.
- **References, not values.** Phone numbers and booking confirmation codes never
  enter model context — the model sees `"on file"` presence flags; the real
  values stay on the server/client for dialing and display. Call transcripts
  don't exist at all (not retained at Vapi — see Phone calls below);
  `check_call_status` returns the outcome summary only.
- **History is capped**: the streamed turn sends at most the last 20 chat
  messages to the model.
- **Historical attachments are notes, not bytes.** Only the LATEST user
  message in the capped history carries raw attachment content
  (`toApiContent`'s `isLatestUserMessage`); every older attachment is replaced
  server-side with a short text note naming the file ("sent earlier in this
  conversation — ask the user to re-attach"). The model saw the bytes when
  that turn originally ran; re-uploading them re-tokenized ~1.5k tokens per
  image on every subsequent turn × round trip for nothing.
- **Follow-up chips come from the same conversation** (a `suggest_followups`
  tool the model calls at the end of its turn) — no separate model call
  re-sending the transcript, and a followups-only ending short-circuits the
  loop (no acknowledgement round trip either).
- **Web-search enrichment rides the AI-assisted consent.** Contact import's
  professional lookup (which sends business name/address/phone into live web
  searches) runs whenever the user chooses the AI-assisted method — there is
  no separate per-import toggle; the import sheet's AI switch hint discloses
  the lookup, and turning the AI switch off avoids it entirely. Classification
  itself sends each contact's **name and company only** (phone/email/birthday
  merge back on the server from the original request, unseen by the model).
- **Chat web search queries are model-composed and user-driven.** The chat
  assistants' `web_search` tool sends model-written queries to a live search
  engine; it fires in service of what the user just asked (no background
  searching), rides the already-minimized chat context (aliased payloads —
  the model never holds raw identifiers to leak into a query), and the system
  note instructs the model to search only for public real-world information,
  never the household's private data. `aiEnabled` gates the surface like the
  rest of chat.

### Phone calls

- `POST /calls/cancel-event` and `POST /calls/event-action` place a Vapi call for
  an event; outcomes are captured lazily (no webhook) into `PhoneCall`
  (`GET /calls`, `GET /calls/:id`); `POST /calls/:id/ack`, `PATCH /calls/:id/link`.
- **Call outcomes never surface on the Calen assistant view** — no "recent calls"
  list and no unseen-result badge on the Calen icon. The user resolves each
  outcome on the event view (and the calendar dimming below); the assistant stays
  a pure chat surface.
- A call is a **deliberate plaintext exception**: the event title/date and the
  business number necessarily leave encryption to make the call, and the outcome
  summary is stored for the household. See
  [platform/crypto-e2ee.md](../platform/crypto-e2ee.md).
- **No call artifacts are retained anywhere.** The Vapi `artifactPlan` disables
  audio recording AND transcript storage — live transcription still powers the
  conversation and the post-call analysis, but nothing survives the call except
  the outcome summary. Consequently there is no transcript in the app either:
  the Interaction view shows status/outcome/summary only, and `GET /calls/:id`
  returns the record without transcript/recording fields.
- **The summary is PII-constrained.** Because the summary is the only surviving
  record (stored plaintext, household-visible, and re-entering model context via
  `check_call_status`), its `summaryPlan` prompt restricts it to outcome facts —
  confirmed or not, the agreed new time, any fee, next steps — and bars identity
  details spoken by either party (no names, phone numbers, emails, addresses,
  birthdates, or account/reference/confirmation numbers; parties are "the
  business" and "the client").
- **The user's contact details are per-call opt-in.** The caller's name is
  always given; their phone/email (for the business's identity check) ride along
  only when the user enables "Share my contact details if asked" on the Event
  Action screen (`shareContact` on `POST /calls/event-action`) or tells the chat
  assistant to (the `call_business` tool's `shareContactDetails` input). Default
  is off; the legacy `/calls/cancel-event` route never sends them.
- **Recipients can stop future automated calls (do-not-call).** Every outbound
  number is checked against a **platform-wide suppression list** before dialing
  (`services/dnc.js` `isSuppressed`, called inside `placeCall`). A suppressed
  number is refused on every entry point — `/calls/cancel-event`,
  `/calls/event-action`, and the chat `call_business` tool — with a clear
  do-not-call error and **no call is placed** (`DoNotCallError`, `code:
  'DNC_SUPPRESSED'`). Scope is by phone number, not by household: the recipient's
  right to be left alone is against Calen as a whole, so one opt-out blocks every
  household. The agent also **discloses it is an AI assistant** at the start of
  every call (the cancel/reschedule intros), so the recipient knows what they're
  opting out of.
- **How a number gets suppressed.** (1) **On the call** — if the person asks not
  to be called again / to be removed / to stop calling, the agent acknowledges
  and invokes the `record_do_not_call` Vapi function tool, which posts to the
  unauthenticated, shared-secret `POST /calls/vapi/webhook` (`X-Vapi-Secret`) and
  suppresses **the number actually dialed** (`call.customer.number`, taken
  server-side — never a model-supplied number) immediately; it also sets
  `dncCaptured` on the originating `PhoneCall` row (matched by Vapi call id).
  (2) **Backstop** — a `structuredDataPlan.doNotCallRequested` flag on the call
  analysis is honored on the next lazy `PhoneCall` refresh (`applyVapiToRow`,
  which also sets `dncCaptured`), covering the case where the real-time webhook
  isn't wired (no `PUBLIC_BASE_URL`/`RENDER_EXTERNAL_URL`).
  (3) **Admin/support** — an admin adds/releases numbers from the portal
  (`GET/POST /api/admin/dnc`, `DELETE /api/admin/dnc/:id`). (4) **Inbound SMS
  `STOP`** is a designed-in source (`source: 'inbound-sms'`) but deferred until a
  messaging-capable number exists — the app has no server-side SMS provider
  today (the Vapi number is voice-only; event SMS invites are sent from the
  organizer's own device).
- **The suppression list is a deliberate plaintext-exception operational model**
  (`DncEntry`): it must be server-queryable before any call, so it can't be
  sealed. It stores an **HMAC-SHA256 of the E.164 number** (keyed by
  `DNC_HASH_SECRET`, falling back to `JWT_SECRET` outside production) as the
  match key, plus the **last four digits** for admin display — never the raw
  number. Suppress is idempotent (upsert on the hash); adds and releases are
  audited (`dnc_suppressed`, `dnc_released`, actor + source + last4 in meta,
  never the full number).
- **The user is told, both after and before.** A do-not-call outcome is
  surfaced to the requesting user in two places, so a suppressed number is never
  a silent surprise: **(after)** when the recipient opts out on a call, the
  call's outcome/Interaction view shows an explicit notice ("This business asked
  not to receive automated calls. Calen won't call this number again.") driven by
  the per-call `dncCaptured` flag — independent of whatever the free-text summary
  says. **(before)** the event's call screen (Event Action) pre-checks the number
  against the list (`GET /calls/suppressed?phone=`, a boolean — attempting the
  call already reveals the same bit via the 403) and, when suppressed, **disables
  the "Call to Cancel/Reschedule" button** and explains why, so the user doesn't
  set up a call that can only fail. The chat `call_business` path still surfaces
  the `DoNotCallError` message conversationally.
- **Resolving the outcome** the user acts on the captured result, they don't just
  dismiss it. The primary place to resolve is **the event view** (the call-status
  card), so no drill-through is needed; the same actions also exist in the call
  detail / Interaction view (reachable via "View call details", and by tapping
  the notice card in Invitations, which has no event context). The Invitations
  notice card carries no inline action of its own — it only shows the outcome
  and opens the Interaction view on tap, where the user resolves/dismisses. After a confirmed **cancellation** the
  event-view card shows the conclusion + **View call details** + **Dismiss**; the
  event stays dimmed/struck on the calendar and is removed via the event's normal
  **Delete** button. **Dismiss acknowledges the call**, which clears the marking
  everywhere (calendar un-dims, the event-view card reverts to the normal Cancel-
  or-Reschedule state) — it does not delete the event. When the user does delete
  the event from the Interaction view, navigation pops **past** the deleted
  event's detail/action/form screens (the cancel-from-event flow) rather than
  returning to the now-dead detail view. A confirmed
  **reschedule** offers **Update event time**
  (opens the event form, as the agreed time isn't applied automatically) or
  **Dismiss**. A call that
  **couldn't confirm** can be retried, and a cancel that couldn't confirm can still
  be marked cancelled by hand. Every path acknowledges (`ack`) the notice. The
  event-view card shows the business called and the call summary in context.

### Usage metering

- Every AI call is priced into the caller's **prepaid credit balance**:
  `services/aiUsage.js` patches the Anthropic SDK so one-shot flat-priced
  actions auto-record their tokens. **Chat is token-priced**: `chatStream.js`
  sums the turn's tokens across the agentic loop, debits whole credits sized to
  the turn's after-Apple token cost plus a slight margin (`recordChatCredits` →
  `credits.chatCreditsForTokens`; pricing owned by
  [billing-plans.md](billing-plans.md)), and returns the charge to the client as
  `done.creditsUsed` — the shared `ChatScreen` shows **N credit(s) under each
  assistant reply** (credits spent, never raw tokens). Enforcement is the balance
  pre-check → `402 CREDITS_EXHAUSTED`; weekly counters survive as analytics only.
- **Phone calls debit the same credit balance at a per-second call rate** —
  Vapi bills calls per-minute and the LLM tokens are negligible, so seconds are
  priced at `credits.callRatePerMinute` instead of the token rate. When a call
  ends, `phoneCalls.js` charges its `durationSeconds` once
  (`recordCallSecondsById`; `PhoneCall.metered` guards re-charging). Placement
  is pre-checked against **one minute** of call cost (`meterCallSeconds` on the
  direct routes; `creditStatus` + `callDebitMc` inline in the chat
  `call_business` tool) → `402 CREDITS_EXHAUSTED` / an "out of AI credits" tool
  error when the balance can't cover it. See
  [billing-plans.md](billing-plans.md).
- **Web searches are NOT a separate charge** — a `web_search` runs inside the
  chat turn, so the extra result tokens it injects are already billed by the
  token-priced chat debit; charging a per-search credit would double-bill them.
  `streamChat` tallies `usage.server_tool_use.web_search_requests` across the
  turn and `recordWebSearches` records the weekly `usageWebSearches`
  count/raw-fee counters for reconciliation ONLY (no debit). See
  [billing-plans.md](billing-plans.md).

## Data & API surface

- **Model:** `PhoneCall` (callId, event essentials, status, `summary`, outcome,
  seen/ack timestamps). `Household.homeCity` (plaintext, coarse home-area label)
  feeds the calendar prompt; read/written via `GET`/`PUT /settings` (`homeCity`).
- **Config:** `ANTHROPIC_API_KEY`, `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`.
- **Client:** `screens/chat/*` (ChatScreen, AssistantScreen, per-area assistant
  screens), `lib/aiPayload.ts`.

## Verification

The privacy invariants are tested **where they are enforced** —
`aiPrivacy.integration.test.js` runs the real app with fakes only at the network
edge (the Anthropic SDK's `messages.stream` and the Vapi HTTP call are captured,
so every assertion is against the exact outbound payload):

- Server-side `aiEnabled` gate: with the pref off, every chat/scan/call endpoint
  returns 403 and nothing reaches Anthropic or Vapi; read-only call bookkeeping
  stays available; flipping it back restores chat.
- Friends/family name-only: a full-fielded roster reaches the model only via
  `get_household_members`, names (+ professional business details, "on file"
  flags) only — no birthday/address/phone/email/notes value appears in any model
  payload, and no roster name appears in the system prompt.
- `includePersonalInfo: false` withholds the roster from the model entirely.
- `includePersonalInfo: false` also **hides the calendar records**: the record
  tools (`list_events`, `get_event_details`, `open_edit_event_form`,
  `delete_event`, `call_business`, `check_call_status`) are absent from
  the offered tool list and refuse if invoked, the reduced system prompt says
  free/busy only, and `get_availability` returns the device-computed
  (title-stripped) availability that was sent — no event title reaches the model.
- References not values: the focused event and `list_events` expose
  `phoneOnFile` presence flags; the numbers never enter model context.
- Per-call contact opt-in: without `shareContact`, the Vapi prompt says
  name-only and carries no user phone/email; with it, details ride as
  share-if-asked. The legacy cancel route never sends them. Every placed call
  disables recording + transcript retention and carries the PII-constrained
  summary prompt. Call placement refuses an event outside the caller's scope.

Client-side payload minimization (alias stripping, query-scoped date windows) is
unit-tested in `mobile/src/lib/__tests__/{aiPayload,aiWindow}.test.ts`; call
metering in `services/phoneCalls.test.js` and token metering in
`middleware/usageMeter.tokens.test.js`.

## Open questions

- Enumerate which write-tools the assistant can invoke per surface (create event,
  add task, etc.) and their confirmation UX.
- **ZDR (G3, ops):** request a zero-data-retention arrangement for the Anthropic
  org (console/support request — not a code change). Until granted, API inputs
  are subject to Anthropic's standard API retention (not used for training).
  (Vapi retention is handled in code: the `artifactPlan` disables recording and
  transcript storage per call.)
- **Verify on the next live call** that Vapi's post-call analysis still lands
  with `transcriptPlan` disabled and the custom `summaryPlan` — both the
  PassFail evaluation (the confirmed-cancel → event-cancelled flow depends on
  it) and that the summary reads as outcome-only with no identity details.
