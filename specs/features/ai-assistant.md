---
title: AI assistant (Calen)
status: current
last-verified: f8e4627 (2026-07-29)
code:
  - mobile/src/screens/chat/
  - mobile/src/hooks/{useChat,useDictation}.ts
  - server/src/routes/{calendarChat,choresChat,maintenanceChat,maintenancePlanChat,tripsChat}.js
  - server/src/routes/{calls,formAssist}.js
  - server/src/services/{chatStream,aiUsage,phoneCalls,dnc,phone}.js
  - server/src/middleware/aiConsent.js
  - server/src/models/{PhoneCall,DncEntry}.js
  - mobile/src/lib/aiPayload.ts
tests:
  - server/src/test/aiPrivacy.integration.test.js
  - server/src/services/phoneCalls.test.js
  - server/src/middleware/usageMeter.tokens.test.js
  - mobile/src/lib/__tests__/{aiPayload,aiWindow}.test.ts
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
- Follow-up chips come from the `suggest_followups` tool inside the same
  streamed turn (`services/chatStream.js`); `POST /form-assist` powers one-shot
  "fill this form from a photo/text" flows.

### Voice input — dictation (normative)

The shared `ChatScreen` lets the user **dictate** to Calen on every assistant. A
mic button in the composer (`hooks/useDictation.ts`) starts on-device speech
recognition (`requiresOnDeviceRecognition: true`, `expo-speech-recognition`); the
live transcript streams into the text field so the user reviews/edits before
sending. **Nothing is sent until they tap send** — it is ordinary typed input by
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
- **Rosters and record bodies are fetched on demand, not front-loaded.** The
  calendar system prompt contains no people; the model calls
  `get_household_members` when a conversation needs them — returning household &
  friends by name only, plus any saved professionals with their business details
  (phone/email as "on file" flags). `list_events` returns titles/dates/recurrence
  only; `get_event_details` returns one event's description/location on request.
- **References, not values.** Phone numbers and booking confirmation codes never
  enter model context — the model sees `"on file"` presence flags; the real
  values stay on the server/client for dialing and display. Call transcripts
  don't exist at all (not retained at Vapi — see Phone calls below);
  `check_call_status` returns the outcome summary only.
- **History is capped**: the streamed turn sends at most the last 20 chat
  messages to the model.
- **Follow-up chips come from the same conversation** (a `suggest_followups`
  tool the model calls at the end of its turn) — no separate model call
  re-sending the transcript.
- **Web-search enrichment is opt-in.** Contact import's professional lookup
  (which sends business name/address/phone into live web searches) runs only
  when the user enables it for that import; classification itself sends each
  contact's **name and company only** (phone/email/birthday merge back on the
  server from the original request, unseen by the model).

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
  `services/aiUsage.js` patches the Anthropic SDK so one-shot calls auto-record
  (token count + model id → credit debit); streaming records in
  `chatStream.js`, passing the stream's model. Enforcement is the balance
  pre-check → `402 CREDITS_EXHAUSTED`; weekly counters survive as analytics
  only — see [billing-plans.md](billing-plans.md).
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

## Data & API surface

- **Model:** `PhoneCall` (callId, event essentials, status, `summary`, outcome,
  seen/ack timestamps).
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
