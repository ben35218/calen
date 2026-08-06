---
title: Billing — app unlock, AI credits & add-ons
status: current
last-verified: f6874e9+ (2026-08-05); **`ViewerUnlock` now self-heals when the session turns out to be unlocked** — if no unlock action of its own is in flight and the request-sent state isn't showing, the screen loads the shared CalendarKeys and leaves for the calendar the moment `useSessionLocked` reports open; this backstops the registration race fixed in auth-identity.md (the gate could mount the shell mid-enroll, read "locked" once into `initialRouteName`, and strand a just-registered invitee on the restore screen over an empty "Nothing shared with you yet" card while their invite sat pending — the auto-accept lives on `ViewerCalendarScreen`, which never mounted) and covers the paths that still enter unsettled (passkey login's post-auth unlock, post-reset); the self-heal deliberately never fires in the request-sent state (post-re-key the session IS unlocked but nothing is wrapped to the new identity yet), and a single `leaving` latch keeps it, the manual-unlock exit, and the approval poll's replace from navigating twice; 2 new tests in ViewerUnlockScreen.test.tsx (2026-08-05); c2d18c0+ (2026-08-04); **add-on ownership moved from the household to the USER** (`Household.addons` → `User.addons`, the former now LEGACY and read by nothing). Storing it on the household detached the entitlement from whoever paid: RevenueCat keys every purchase to `app_user_id` = the user id, but the grant landed on a container that user could leave — so leaving (or being removed) minted a fresh household with an empty set and silently dropped add-ons the member had bought themselves, recoverable only by tapping Restore and invisible until they thought to. Ownership is now per-user and the household-wide EFFECT is derived at read time as the union across members (`ownedAddonsFor`), so one member's purchase still unlocks the lane for everyone, a household still pays once, and a purchase survives joining/leaving/removal with no join-time bookkeeping (the union-on-approve added earlier the same day is deleted). Per-user *effect* was rejected: these records live in the shared household store, so a non-owning member's device already holds them — gating per user would be unenforceable (client-side only; the record store is opaque) and would charge a couple twice for one shared feature on top of the per-user unlock. Free claims no longer require a household (they land on the claimer); the webhook's "no household → ack and wait for a Restore" branch is gone; the admin override targets the caller; `GET …/users` now reports what a user OWNS (finally distinguishing a buyer from someone who lives with one) and `GET …/households` reports the union plus per-member provenance. Wire contract unchanged (`status.addons` is still `string[]`), so shipped builds keep working. Migration: `scripts/backfillUserAddons.js` (dry-run by default) grants each household's set to every current member and MUST run BEFORE the deploy — deploying first unions an empty set and strips every customer's add-ons until it runs (2026-08-04); 46cd98a+ (2026-08-04); the viewer grid's **month-boundary rule** follows the unlocked grid's change — the ordinary `colors.border` hairline (not a 1px primary line), drawn per day cell over the month's own days only, so no rule hangs over the blank cells leading into the 1st (46cd98a+, 2026-08-04); the viewer month grid now lays its weeks out as **month blocks** — the same Apple-style layout the unlocked grid took on (each month its own grid, the neighbouring month's days blank in a boundary week, spans clipped at the boundary, the 1st marked with the abbreviated month name in the app primary above the row's opening rule); the geometry is shared with the unlocked grid via `lib/monthGrid.ts`, spec'd in [calendar.md](calendar.md) → "Month blocks" (2026-08-04); the viewer month grid now carries the **today anchor** — it opens on today and stays pinned there until the viewer drags it or jumps to a month, because a cold launch re-measures the week rows in stages after the first frame is positioned and the old one-shot snap used offsets that were already stale (calendar.md owns the rule; 6 tests in ViewerMonthGrid.todayAnchor.test.tsx) (2026-08-03); 9282d82+ (2026-08-02); **the viewer restore-access screen was rebuilt around a clear top-to-bottom reading order** — the route name is now printed NOWHERE (nav bar registered `title: ''`, bare back chevron; no body heading either — "Restore access" named the destination the user tapped, not the situation they're in) and the screen opens with the STATE instead: a 64pt lock `IconAvatar` over a plain-language headline ("This calendar is locked" / "Your shared calendars are locked") that is ITSELF the `HintDisclosure` label — the ⓘ sits inline after it, the whole line taps, and the per-lock explanation (relaunch "just needs you to prove it's you" vs post-reset "your new password can't unscramble…") lives behind it; the separate "Why is it locked?" row and the what-happens-next line under the headline are both GONE (one asked a question the glyph implies, the other only described the buttons already on screen), then the shared calendars by name in a bare card (the "Shared with you" eyebrow is GONE — the headline already said it, and a padlocked row per named calendar is self-evident), then a "How to get back in" action block (the screen's one surviving eyebrow, given a `spacing.lg` top margin so it breaks from the card instead of reading as part of it); the actions now resolve to **exactly one filled primary** (best path that can actually work — passkey, else password, else request access) with everything below it `ghost` or a text link, and **all typing moved into `BottomSheet`s** (password + recovery code, each one field / one button / its own inline `FormError`, stale errors cleared on every sheet open+close) instead of unfolding inline forms that shoved the remaining options down the page; hint copy was tightened ("scrambled for privacy", no "outsiders"), and the **ⓘ is now the documented app-wide hint-disclosure glyph** (mobile/CLAUDE.md — an eye means "show a masked value", not "explain this", so `HintDisclosure` and any hand-rolled reveal such as ContactImportScreen's switch rows keep the information circle); **a pending access request now survives a sign-out** — "Request sent" was component state, so signing out and back in dropped the viewer onto a blank calendar whose sync note gave no sign the request existed; `serialize` in server/src/routes/calendars.js now returns the REQUESTER'S OWN seat stamps (`keyChangedAt` / `accessRequestedAt`, nobody else's — the collaborator list is still stripped), carried through `CustomCalendarRecord` → `calendarPrefs.fromRecord`, so `ViewerUnlockScreen` re-opens on the confirmation, `ViewerCalendarScreen` `replace`s there when a request is outstanding with nothing readable AND paints only a bare loader meanwhile (the grid used to flash an empty month with the sync-delay note over it as the first thing a returning user saw; the note still serves the no-request case), and the confirmation polls the list every 15s so the owner's approval (which clears both stamps) sends the user on to `ViewerHome` — guarded so a not-yet-loaded list on first paint can't be mistaken for approval; the request-sent confirmation was tidied into one centred column and now CARRIES the `ViewerUpgradeBanner` (the options screen still doesn't) — once the request is away the user cannot act on the problem at all and the app holds nothing for them, so the offer answers "what do I do now?" instead of competing with a fix; its ⓘ label took the hero's balanced-glyph treatment, having stretched full width and read as a left-aligned form row with the glyph stranded at the screen edge, and the label shortened to "Why does someone else do this?"; **the data-loss confirm no longer fires for a pure viewer** — a locked user with no calendar of their own has never been able to create content (hard paywall), so the server guard's only Record is the auto-seeded "You" Person and the alert told someone who saved nothing that "1 items you saved in Calen" would be destroyed; the client now pre-confirms (`confirmDataLoss: true`) when `!unlocked && no own calendar`, and the warning still stands for anyone owning a calendar (the refunded ex-payer); the request-sent state is now TERMINAL — "Back to calendar" removed (the re-key leaves a new identity nothing is wrapped to yet, so it landed on an empty grid that reads as lost data), leaving Sign out as the only way onward; a **Sign out** link was added at the foot of the restore-access screen (same quiet muted treatment as the paywall's) — when that screen is the whole shell the calendar's overflow menu is unreachable, so sign-out had nowhere to live and a viewer signed into the wrong account had no exit but deleting the app; two button relabels — **"Unlock with Face ID" → "Unlock with passkey"** (the same credential is Touch ID on a home-button device and the system sheet names the modality itself, so the old label was wrong for some users; the screen's no-jargon test now forbids standalone "key" rather than the substring, since "passkey" is the credential's real name) and **"Request access again" → "Request access"**; **the re-key no longer asks for a password in the common case** — the two paths that verify a password server-side and still end up locked (`POST /auth/reset`, `ensureEnrolledOnLogin`'s failed-unlock branch) now hand it to the new memory-only `rememberSessionPassword`, `rekeyIdentity` accepts `null` to use it, and "Request access" fires straight off the button (spinner in place, no sheet) when `hasSessionPassword()`; the field could NOT simply be deleted — it is the wrapping key, not a checkpoint (see the normative section + crypto-e2ee.md "Re-key"), so instead it moved out of the user's way, with the sheet kept as the fallback for a session holding nothing and its copy re-framed to say what the password is for (placeholder "Your current password"); the accepted tradeoff is that a re-key no longer re-authenticates the holder of an already-unlocked phone; 8 new tests pin the headline + its singular/plural, that the hero carries nothing but the headline and its ⓘ, that the per-lock explanation is correct behind it, that the re-key password reads as the new key rather than an identity check, that nothing is typeable until an option is picked, and that each explanation folds independently (2026-08-02); **navigation presentation audit** — `BuyCredits` keeps its modal presentation but now dismisses with the shared `HeaderCloseButton` ✕, and the viewer shell's `ViewerPrint` changed from push to **modal** with the same ✕, matching the unlocked app's `PrintCalendar`; presentation rules live in mobile/CLAUDE.md (2026-08-02); 9282d82+ (2026-08-02); **fixed cross-account add-on leakage + the stale-lock repaint gap** — (follow-up same day: `AppNavigator` now mounts `useBilling` at the unlocked app's root, because after the sign-out clear a fresh session booted locked-by-default and NOTHING fetched `/billing/status` from the month grid — the add-on lanes stayed empty until the user visited Calendars/Profile; every signed-in shell now mounts the hook at its root) —  `hc_owned_addons` (the device mirror of the owned add-on set) survived sign-out, so a viewer session's EMPTY set became the next owner sign-in's boot state and `applyAddonLocks` zeroed their Occasions/Chores/Meals lanes; worse, the owned set is SNAPSHOTTED into the ['calendar','sources']/['viewer','sources'] query results (loadCalendarWindowSources), so when the correct set later landed nothing repainted — the lanes stayed empty until an unrelated invalidation (the user saving an event). Now `resetOwnedAddons()` clears the cache+key at logout (next session boots at the safe locked default) and `cacheOwnedAddons` invalidates the ['calendar']/['viewer'] trees when the set actually CHANGES (identical refetch echoes stay quiet); `commitCustom` does the same for the embedded `accessibleCustomIds` snapshot (2026-08-02); 9282d82+ (2026-08-02); the viewer shell's **"No shared calendars yet" verdict is now gated on the server list having answered** (`useCustomCalendars().loaded`, backed by a new `customServerLoaded` flag set when `refreshCustomCalendars()` completes) — the list loads asynchronously, so an empty list before it lands meant "still loading", and the shell was telling a viewer who DID have a shared calendar that they had none; a `CenteredLoader` covers the gap (the root cause of the wrong verdict was sign-out not clearing the calendar prefs cache — see auth-identity.md's sign-out teardown) (2026-08-02); 9282d82+ (2026-08-02); the viewer shell's `UnlockPaywall` route now renders the paywall EXACTLY as the gate does — transparent, title-less header instead of the "Unlock Calen" bar, so the pushed instance differs from the full-screen one only by its floating back button; the screen computes its own top inset (safe area + a 56pt reserved back-button band) with `contentInsetAdjustmentBehavior="never"` so the two mounts can't drift (2026-08-02); `UnlockPaywallScreen`'s offer block rebuilt around ONE control — the price is stated once on the CTA (the duplicate "One-time purchase · $X.XX per person" line above it is gone), the terms moved beneath the button as muted micro-copy, **Restore purchase demoted from a bordered `ghost` Button to a text link** in the Terms/Privacy row (dropped entirely once activation is `active`), and **Sign out** likewise demoted to a quiet muted link — three equal-weight rounded rectangles became one filled CTA plus links; the "one-time purchase" wording no longer repeats in the closing disclosure (which is now just the prepaid-credits note); new `screens/plan/__tests__/UnlockPaywallScreen.test.tsx` pins the single-price rule, the micro-copy, Restore's discoverability + post-activation removal, and that exactly one `Button` primitive renders (2026-08-02); free viewer mode is now a two-layer read-only CALENDAR, not an agenda: the shell's home opens on `ViewerMonthGrid` — a read-only cousin of the unlocked app's Details month grid (unbounded month window + month/year jump sheet + labelled chips and multi-day span bars, tap a chip/bar for the event, tap a day for its full list in a sheet), with the old upcoming-events agenda kept as the second layer (`ViewerAgendaList`, now anchored by the app's own "Today" marker from `dayview/AgendaView` — accent rules + tinted header, and today always gets a section so the marker holds even on a quiet day) behind a view toggle whose choice persists per device (`hc_viewer_view`, grid = first-run default); both layers are fed by ONE replica read the host holds (`['viewer','sources']` → `loadCalendarWindowSources`, expanded synchronously per layer) and both still draw ONLY `mine:false` calendars' events; the shell's floating chrome splits navigation from the offer — the grid's sticky "Month Year" jump label promoted INTO the top button row (leading edge; header is two rows now, "Shared with you" there in list mode), ONE trailing pill with a FIXED menu glyph (overflow ellipsis — never a state-reflecting toggle; the checkmark reports the active view) opening an `AnchoredMenu` (Calendar ✓ / List / Print / Sign out — so sign-out finally has a home in grid mode; the view rows reuse the unlocked app's own glyphs, `view-stream-outline` + `format-list-bulleted`; no upgrade row — the banner owns that path), a persistent bottom **upgrade banner** (open-padlock + "Unlock Calen" + value line, PRICELESS by design — the cost belongs on the paywall, not on the way to it) instead of the top-left question pill (nav slots are for navigation; a nav-shaped promo is mis-tapped and then unseen), and Today floating just above the banner, so `ViewerHome` runs `headerShown:false`; Print is a new viewer-scoped sheet (`ViewerPrintScreen` / `ViewerPrint` route, seeded with the month on screen) that reuses `buildPrintHtml` client-side but builds its checklist from the shared calendars ALONE and empties the viewer's own lanes before rendering — it deliberately does not reuse `PrintCalendarScreen` (built-in lanes, holiday calendars, add-on ownership, own visibility prefs) (2026-08-02); splash-deadlock fix — `clearUnlockCache`/`clearViewerContentCache` now reset to a KNOWN false instead of null: sign-out → next sign-in on the same launch left `useViewerContent().loaded` false forever (nothing re-reads after a clear; `useBilling` can't mount behind the splash), so a viewer logging in spun on the splash until an app relaunch (2026-08-02); free viewer mode: the shell's Invitations inbox is retired — pending calendar shares now **auto-accept** on `ViewerCalendarScreen` entry/focus (a viewer never sees Accept/Decline; the owner remains the only party who can un-share), and the waiting hint reworded to "events appear the next time its owner opens Calen" (no owner-facing confirm prompt exists — the wrap is silent, and it now runs on EVERY owner unlock, fresh login included) (2026-08-02); FREE VIEWER MODE (new normative section) — a locked non-admin user with viewer content (≥1 accepted calendar collaboration or ≥1 pending calendar invitation) gets the read-only `ViewerNavigator` shell instead of the hard paywall: `GET /billing/status` gains `viewer: { calendarCollaborations, pendingCalendarInvitations }` (`calendarSharing.viewerContentCounts`, address-matched so pre-signup invites count), mirrored on-device by the new `lib/viewerAccess.ts` (`hc_viewer_content`, unlock-cache doctrine: safe-default paywall, cleared on sign-out), RootNavigator's gate branches `needsUnlock` on the cached signal and holds the splash for both caches; the shell = shared-calendar agenda (`ViewerCalendarScreen`, `mine:false` only) + `ViewerEventScreen` + reused Invitations inbox + UnlockPaywall-as-route + sign-out, with a per-calendar waiting hint until the owner wraps the CalendarKey; paywall remains client-side — the server instead enforces view-only WRITES via the /records calendar-lane 403 (calendar.md) (2026-07-31); chat billing now prices tokens PER TYPE — `tokenRatesPer1M` families became `{ input, output, cacheRead, cacheWrite }` $/1M objects at Anthropic's real prices (sonnet `{3, 15, 0.3, 3.75}`, haiku `{1, 5, 0.1, 1.25}`, default `{6, 30, 0.6, 7.5}`), `chatStream` sums each API call's usage per type (`credits.usageBreakdown`) and `recordChatCredits` debits from the breakdown, so cache reads bill at ~0.1× input instead of the retired blended rate that over-billed them ~33× (a heavy calendar turn drops from ~50–70 credits to single digits with identical behavior); `tokenCostMc` is polymorphic (breakdown object or legacy number) and honors a legacy blended NUMBER rate on every type so a stale cached config can never crash or misprice mid-deploy; `getSingleton` migrates numeric rate entries (known families → per-type defaults, unknown → number on all four types); admin PUT + editor validate/edit the per-type shape and reject bare numbers on write; `recordTokens` additionally accumulates per-type splits `usageTokens[period].byType.*`; `totalTokens` stays the display/analytics sum only (2026-07-31); Credits screen spend/history split — the "By feature this week" analytics card is repurposed into **"Where your credits go"**: it now reports credits SPENT per feature this week (biggest-first, with a "Spent this week" total) from a new `status.spend` map (server aggregates the caller's usage-debit ledger rows since the period start, action→credits, fractional for prorated calls), and the **History** card is filtered client-side to purchases & grants only (usage debits are summarized in the spend card, never itemized in History); the shared `Button` primitive gained an optional `style` override so the plan card's "Manage subscription" ghost button gets top spacing from the card copy; chat is now TOKEN-PRICED — a chat turn debits whole credits sized to its summed-token provider-cost AFTER Apple's cut plus a slight margin, ceiled (`credits.chatCreditsForTokens`; knobs `credits.appleFeePct` default 0.15 = App Store Small Business, `credits.chatMargin` clamped [1.0, 1.5] default 1.0 — the ceil is the margin, realized ~100–150%): `meter('chat')` still pre-checks + counts but no longer flat-debits (chat is the sole member of `credits.TOKEN_PRICED_ACTIONS`), `chatStream` debits once per turn via `recordChatCredits` (ledger action `chat`) and returns the charge as `done.creditsUsed`, the shared `ChatScreen` shows "N credit(s)" under each reply instead of tokens, and the rate card labels chat "Varies with length" (the nominal `actionCosts.chat` survives only for sort order, never debited); validation adds `appleFeePct` in [0,1) + `chatMargin` in [1.0,1.5], `getSingleton` backfills both; the per-search web-search charge (`actionCosts.webSearch`) is now REMOVED — web search runs inside a chat turn so its result tokens are already in the token-priced chat debit; `recordWebSearches` records count/cost for reconciliation only (never debits), `getSingleton` strips a stored `actionCosts.webSearch`, and the rate card drops the web-search row; the rate card now pins the token-priced **chat row FIRST** (flat rows ascending, per-minute call pinned last); the admin AI-credits editor gained editable `appleFeePct`/`chatMargin` (same validation bands) and **excludes `chat`** from the flat action-price grid (2026-07-30); [superseded] chat web search was briefly a flat-priced action — `actionCosts.webSearch` (default 3 credits) debits per search Anthropic's server-side `web_search` tool executes inside a chat turn (max 3/turn), ON TOP of the flat chat price, charged once per turn via `recordWebSearches` (ledger action `webSearch`, weekly `usageWebSearches` counter + raw `webSearchRatePerSearch` $0.01/search fee feeding the reconciliation endpoint's cost side), with a "Web search · N credits/search" rate-card row and "Web searches"/"Web search" usage/ledger labels (2026-07-30); account deletion × billing (new normative section) — deleting an account never cancels the Apple-billed Calen AI plan: when the plan is active the client interposes a keep-billing warning (with the Manage-subscription affordance) before the destructive confirm, the confirm names any forfeited credit balance, the account-deleted email repeats the cancel-in-Apple-settings reminder, deletion best-effort-purges the RevenueCat subscriber when `REVENUECAT_SECRET_API_KEY` is set, and a `TRANSFER` whose losing id no longer resolves (account deleted before Restore) now grants the unlock to the gaining user instead of silently stranding a paying customer behind the paywall (2026-07-30); `manualParse` now meters ONLY the manuals AI routes (auto-lookup + extract-tasks) — the plain manual upload and save-from-URL routes were incorrectly debiting the flat 40-credit price for zero-AI file storage (meter() removed from both), and the action's labels renamed "Import(s) & parsing" → "Owner's manual parsing" (2026-07-30); action labels renamed to match what's actually metered — `scan` is "Photo scan(s)" (items-from-photo + recipes-from-photo; receipts are plain E2EE attachments, never AI-scanned) and `generation` is "Recipe generation" (generate-from-description + suggest-recipes; nothing generates plans) across the price/usage/ledger labels, and the paywall + onboarding "scans receipts" bullets now say "scans photos" (2026-07-30); the "What things cost" card is now a rate card — rows sort by the server's live price ascending (ties alphabetical by label) with the per-minute call row pinned last, replacing the hard-coded display order (2026-07-30); Calen AI plan manage-subscription flow — client-derived three-state plan card (renewing / cancelled-but-active / inactive), native manage sheet + managementURL/App-Store fallback, refresh on focus & foreground (2026-07-30); the inactive plan card's value framing now asserts the advantage without a computed percentage — "N credits every month — more credits per dollar than any pack" (the catalog still drives whether the plan beats the packs) (2026-07-30); the Calen AI plan post-purchase poll (`useAiPlanActivation`) now completes only when the plan is active AND the balance has risen past the pre-purchase snapshot, not on `aiPlan.active` alone — the webhook flips `aiPlanActive` before it `$inc`s the balance, so gating on active alone could freeze a stale pre-credit balance in the cache until the next focus refetch (History updated but the balance didn't); `useAiPlanPurchase.buy()` now passes the pre-purchase `creditBalanceMc` to `activation.start()` (same balance-rise doctrine as the credit-pack poll) (2026-07-30); Credits History card is now BOUNDED — it renders at most `HISTORY_PREVIEW` (5) most-recent rows and, when more grants exist, a "See all history" drill-in to a new **CreditHistory** screen (month-grouped `SectionList`, pull-to-refresh, empty state); both the card and the screen share the `useCreditLedger` hook (query key `['billing','ledger']`) so "See all" opens from the warm cache, and the ledger fetch now passes `grants=1` — the server gained a `?grants=1` mode on `GET /credits/ledger` that filters `kind:'usage'` server-side and raises the window to 200 (the unfiltered default still returns usage rows, limit 50, for reconciliation), so a heavy AI user's grant history isn't pushed out of the window by usage-row volume; the client keeps a defensive usage filter; `LEDGER_LABEL`/`ledgerAmount` moved to `screens/plan/shared.ts` (shared by both surfaces); drive-by fix — `useAiPlanPurchase.restore()` now also passes the pre-restore balance to `activation.start(previousMc)` (it was calling the now-1-arg poll with none) (2026-07-31); **free viewer mode gained a way back in** — the shell's new `ViewerUnlock` route (passkey, a quiet "I have a recovery code" link, then "Request access again" listing each shared calendar BY NAME) replaces a dead end where a viewer who reset a forgotten password could only reach unlock UI by paying $4.99; the locked note no longer says "sign in again" (a reset re-wraps nothing, so it could never work) and now routes here (9282d82+, 2026-08-02); the viewer restore-access screen is now the SHELL for a locked viewer (ViewerNavigator opens on it, gesture-back off) and was rewritten for a nontechnical reader — "Shared with you" + calendar names first, one jargon-free sentence, every explanation folded behind an ⓘ HintDisclosure (whole label row tappable), and a password unlock offered only when `e2eePasswordStale !== true` (the relaunch lock, not the post-reset one). It carries NO body title (the nav bar already says "Restore access"; printing it twice pushed a heading between the user and their calendar) and NO upgrade banner (beside the one thing they're trying to do it reads as an upsell for the problem — and buying the unlock decrypts nothing); the banner stays on the calendar home via the shared ViewerUpgradeBanner (9282d82+, 2026-08-02)
code:
  - mobile/src/screens/plan/
  - mobile/src/lib/purchases.ts
  - mobile/src/lib/planState.ts
  - mobile/src/lib/addons.ts
  - mobile/src/lib/unlock.ts
  - mobile/src/lib/viewerAccess.ts
  - mobile/src/hooks/useBilling.ts
  - mobile/src/navigation/ViewerNavigator.tsx
  - mobile/src/screens/viewer/
  - mobile/src/components/CreditsBanner.tsx
  - mobile/src/components/QuotaBlockedNotice.tsx
  - server/src/routes/billing.js
  - server/src/routes/monetizationConfig.js
  - server/src/models/MonetizationConfig.js
  - server/src/models/CreditLedger.js
  - server/src/services/credits.js
  - server/src/services/aiUsage.js
  - server/src/middleware/usageMeter.js
tests:
  - server/src/test/billingWebhook.integration.test.js
  - server/src/routes/billing.test.js
  - server/src/services/credits.test.js
  - server/src/middleware/usageMeter.tokens.test.js
  - mobile/src/lib/__tests__/addons.test.ts
  - mobile/src/lib/__tests__/unlock.test.ts
  - mobile/src/lib/__tests__/viewerAccess.test.ts
  - mobile/src/screens/viewer/__tests__/ViewerCalendarScreen.test.tsx
  - mobile/src/screens/viewer/__tests__/viewerShared.test.ts
  - mobile/src/lib/__tests__/planState.test.ts
  - mobile/src/screens/plan/__tests__/CreditsScreen.test.tsx
  - mobile/src/screens/plan/__tests__/UnlockPaywallScreen.test.tsx
  - mobile/src/screens/plan/__tests__/shared.test.ts
  - mobile/src/screens/plan/__tests__/packStore.test.ts
  - mobile/src/screens/plan/__tests__/AddOnsScreen.test.tsx
---

# Billing — app unlock, AI credits & add-ons

## Purpose

Monetization is three one-shot mechanisms plus ONE optional subscription, all
via RevenueCat / native in-app purchase:

1. **The app unlock** — a $4.99 one-time non-consumable, **per user**, behind a
   hard paywall.
2. **Prepaid AI credits** — consumable packs funding a **per-user balance**
   that both AI usage and assistant phone calls draw down at **flat published
   per-action prices** (margin built into the prices, not computed per call).
3. **The Calen AI plan** — an optional $4.99/month auto-renewable subscription
   that grants a monthly credit allowance at a better per-credit rate than any
   pack. Never required: packs remain the top-up and the non-subscriber path,
   and every AI feature works identically either way (credits are credits).
4. **Feature-calendar add-ons** — one-time purchases **owned per user, applied
   household-wide** (plus free opt-in claims), unchanged in spirit from the
   pre-credits era.

The admin app configures the whole economy centrally (`MonetizationConfig`).
Config saves are validated server-side (positive margin, non-negative
rates/prices, integer pack credits, `appleFeePct` in [0, 1), `chatMargin` in
[1.0, 1.5] → 400 on violation) and audited as
`config_changed` with the leaf-level diff of what moved; the portal shows the
same diff for review before saving. The portal itself is specced in
[admin-portal](admin-portal.md).

## Behavior (normative)

### RevenueCat identity

- The RevenueCat `app_user_id` is the **user id** (was: household id). The
  mobile app configures/logs in the RC SDK centrally in `RootNavigator`
  (`configurePurchases` + `Purchases.logIn` on account switch; `logIn` also
  aliases legacy installs keyed to the household id). Purchases degrade to a
  "not configured" state until the RC keys exist (Expo Go / dev builds).
- `POST /api/billing/webhook` (public, verified by `REVENUECAT_WEBHOOK_SECRET`)
  resolves the event's `app_user_id` to a **User** (by `revenueCatId`, falling
  back to `_id`) and partitions each event into exactly one path:
  1. **The Calen AI plan** — matched FIRST (entitlement `calen_ai` /
     `aiPlan.productId`) so its subscription lifecycle can't leak into the
     one-time paths.
  2. **Credits** — matched by *product id* against the pack catalog
     (consumables carry no entitlement); never falls through.
  3. **Unlock** — matched by the `app_unlock` entitlement (product-id
     fallback).
  4. **Add-ons** — matched by `addon_*` entitlements; applied to the user's
     household.
  Anything left over — including legacy subscription-era `premium`/`unlimited`
  events and their lifecycle tails — is **acked as ignored** so RC never
  retries. Unknown users are acked (`matched: false`). `TRANSFER` (Restore
  under a different account) is handled before the partition: it moves the
  unlock flag from the losing user to the gaining one (consumed credits and
  household add-ons stay where they were applied). When the losing id resolves
  to **no user** — the account was deleted before the Restore — the unlock is
  granted to the gaining user anyway: RevenueCat fires `TRANSFER` only when
  real store transactions moved to that id, and the hard paywall means any
  Calen receipt contains the unlock, so dropping the event would strand a
  paying customer behind the paywall. `TRANSFER` never touches plan state; an
  active Calen AI plan re-attaches on its next `RENEWAL`/`EXPIRATION` event,
  which arrives under the gaining id.

### The app unlock (hard paywall)

- Product `app_unlock_499` ($4.99 display fallback; the store's localized
  price is authoritative), RC entitlement **`app_unlock`**, sold as the single
  lifetime package of the `current` offering. Grants set `User.appUnlocked`
  (+`appUnlockedAt`/`unlockProductId`); a refund (`CANCELLATION` +
  `CUSTOMER_SUPPORT`; `EXPIRATION` defensively) revokes.
- **Per-user**: every member buys their own unlock with their own Apple ID.
  (Apple cannot scope purchases per device; family members sharing one Apple
  ID effectively share the unlock via Restore — accepted.)
- **Hard paywall**: signup/login and household join stay free; a signed-in
  user without the unlock gets the full-screen `UnlockPaywallScreen` (feature
  bullets, localized price, Buy, **Restore Purchases**, Terms/Privacy links —
  App Review 5.2.5 — and a sign-out escape) instead of the app
  (`RootNavigator` three-way gate). The gate is **skipped** when RC isn't
  configured (dev builds) and for `admin`-role accounts.
- **The offer block has ONE control.** The price is stated exactly once — on
  the CTA itself (`Unlock Calen — $X.XX`), never also as a line above it — and
  the purchase terms sit *under* the button as muted micro-copy ("One-time
  purchase, per person · tied to your account, not a subscription"), which is
  both the non-duplicating layout and where App Review expects the disclosure:
  adjacent to the CTA. Everything else on the screen is a **text link**, not a
  bordered button: **Restore purchase** joins Terms of Use / Privacy Policy in
  one small link row (still discoverable per App Review 3.1.1 / 5.2.5, without
  competing with the CTA), and **Sign out** is a quiet muted link at the
  bottom. Three same-weight rounded rectangles read as three equal choices;
  a paywall must have exactly one thing that looks pressable-and-important.
  Restore is dropped from the row once activation reports `active` (there is
  nothing left to restore). Link rows carry `paddingVertical` for the tap
  target — a 13px `Text` alone is too small to hit.
- The unlock state is mirrored to the device (`lib/unlock.ts`,
  `hc_app_unlocked`) from every sighting — login/register/`/me` payloads
  (`user.appUnlocked`) and `GET /billing/status` — so an unlocked user opens
  the app offline. Unknown + uncached reads as **locked**; the cache MUST be
  cleared on sign-out so another account on the device can't inherit it.
- Post-purchase the client polls `GET /billing/status` until `unlocked` flips
  (`useUnlockActivation`, 3s/45s webhook-gap pattern; timeout reassures).
- Admin override: `POST /api/monetization-config/unlock` `{userId, unlocked}`
  (audited `unlock_changed`) — the tester escape hatch.

### Free viewer mode

Someone broadcasting a calendar shouldn't force their audience to buy the app.
A signed-in, locked (no unlock), non-admin user **with viewer content** gets a
read-only **viewer shell** (`ViewerNavigator`) instead of the paywall; a locked
user with none sees the paywall unchanged.

- **Eligibility (the gate signal):** viewer content = ≥1 accepted
  outside-calendar collaboration OR ≥1 pending calendar invitation addressed to
  the user. `GET /billing/status` reports it as
  `viewer: { calendarCollaborations, pendingCalendarInvitations }`
  (`calendarSharing.viewerContentCounts`; pending invitations match by
  `toUserId` OR email OR phone so a pre-signup invitee counts on their very
  first session, before the lazy claim).
- **Device mirror:** `lib/viewerAccess.ts` (`hc_viewer_content`) caches the
  folded boolean from every status sighting (`useBilling` queryFn + activation
  polls), exactly like the unlock cache: unknown + uncached reads as **no
  content** (safe default → paywall), offline shell entry works once cached,
  and the cache MUST be cleared on sign-out. A brand-new invitee's first login
  may render the paywall for one status round-trip — the paywall mounts
  `useBilling`, whose first fetch caches the signal and re-renders the gate.
  **A clear resolves to a KNOWN false, never back to "unloaded"** (both
  caches, 2026-08-02): RootNavigator and its `useUnlocked`/`useViewerContent`
  hooks stay mounted across a sign-out → next sign-in and nothing re-reads
  the cache after a clear, so a null'd state reported `loaded: false` forever
  and held the splash spinner for the next signed-in account — the billing
  fetch that would re-cache the signal lives in `useBilling`, which only
  mounts once the gate renders a screen (deadlock; only an app relaunch
  recovered). Cleared and fresh-install mean the same safe default anyway:
  locked / no content until the first status fetch corrects it.
- **The shell is deliberately tiny:** a read-only shared-calendar home
  (`ViewerCalendarScreen` — only `mine:false` calendars and their events; the
  viewer's OWN household lanes stay behind the paywall, which also covers a
  refunded ex-payer's own data), a slim read-only event detail
  (`ViewerEventScreen`), a viewer-scoped print sheet (`ViewerPrintScreen` —
  a **modal** with a ✕, the same finish-and-dismiss rule as the unlocked app's
  `PrintCalendar`), the upgrade banner pushing the same `UnlockPaywallScreen` as
  a route, and sign-out. Nothing else is reachable.
- **A locked viewer lands on `ViewerUnlock`, and it IS the shell.** When the
  session can't decrypt (`useSessionLocked` — the session key, NOT
  `useE2eeLocked`, which asks whether the viewer's *own* household is active and
  would answer "fine" while they stare at ciphertext), `ViewerNavigator` opens on
  `ViewerUnlock` with the swipe-back gesture off. Routing them to the calendar
  instead would be a month of empty cells with a note taped to it, and the only
  useful action buried in a menu. `initialRouteName` is read once at mount, which
  is what makes this safe both ways: the lock state is settled before the shell
  can mount — RootNavigator holds the splash until auth bootstrap (including its
  silent biometric/passkey attempt) settles, and the live password sign-in /
  register paths finish their E2EE enroll **before** `setUser` flips the gate
  (auth-identity.md "Sign-in paths") — and once the user is back in, the
  navigator does not re-mount and yank them out. **The screen also self-heals:**
  if the session turns out to be unlocked while it shows — no unlock action of
  its own in flight, no request-sent state — it loads the shared CalendarKeys
  and leaves for the calendar on its own. Before the settle + self-heal pair, a
  brand-new invitee's very first registration stranded here: the billing status
  (which flips the gate to the shell) usually landed before the sign-in's
  Argon2 enroll finished, so the navigator mounted "locked", pinned this as its
  initial route, and the unlock completing moments later moved nothing —
  showing "Nothing shared with you yet" to a user whose invite was sitting
  pending the whole time (the auto-accept lives on `ViewerCalendarScreen`,
  which never got to mount). The self-heal never fires in the request-sent
  state: post-re-key the session IS unlocked, but nothing is wrapped to the new
  identity yet, and the calendar would read as lost data.
  Reaching it from an already-open shell (the locked note, the menu's **Restore
  access**) pushes it normally, back chevron and all — so "done" means
  `goBack()` when there's a route beneath and `replace('ViewerHome')` when there
  isn't.
- **The screen is written for someone who has never heard the word "key."** It
  reads top to bottom in the order of the user's questions, one block per
  question:
  1. **What's wrong** — a lock disc (`IconAvatar`, 64pt) over a plain-language
     headline that names the state outright ("This calendar is locked" /
     "Your shared calendars are locked"), and nothing else. The state is legible
     before a word is read. **The headline IS the `HintDisclosure` label**, so
     the ⓘ sits inline immediately after it and the whole line is the tap
     target. The label node carries an empty 24pt slot (the glyph's 18px + the
     row's 6px gap) *before* the text to balance that glyph, so the **words** sit
     on the view's true centre line rather than the text+glyph pair being
     centred as a block with the headline pushed half a glyph to the left; the explanation behind it still tracks which lock this is (the
     relaunch lock "just needs you to prove it's you", the post-reset lock says
     the new password can never unscramble what the old one protected, so the
     owner shares it again). There is deliberately **no separate "Why is it
     locked?" row and no what-happens-next line** under the headline: the former
     spent a line asking a question the glyph already implies, and the latter
     ("Pick an option below to get back in") only described the buttons already
     on screen. Three stacked blocks of text before the first action is what
     makes a nontechnical user conclude the app is broken.
  2. **What it affects** — the calendars shared with them, by name, in a plain
     card with **no eyebrow above it** (names are plaintext on the calendar
     record, so they render while the events don't). The headline has just said
     these are the locked shared calendars; a "Shared with you" label restates
     it and stacks a third block of text between the user and the actions.
     Named rows, each with a padlock, are self-evident.
  3. **What to do** — the actions, under the screen's one surviving eyebrow,
     "How to get back in", which carries a `spacing.lg` top margin
     (`SectionHeader` has none of its own) so it reads as the break between
     what's locked and what to do about it rather than part of the card above.

  Every further explanation is folded behind a `HintDisclosure`, whose whole
  label row is the tap target (an 18px glyph is well under 44pt, and a question
  printed beside an untappable glyph traps the user who needs the answer) and
  whose revealed hint is at most a sentence or two. Prose above the buttons is
  what makes a nontechnical user conclude the app is broken; the same user shown
  two buttons taps one. Two things this screen deliberately does NOT carry:
  - **No route name anywhere — the hero headline is the only title.** The
    navigation bar is registered with an empty title (`title: ''` in
    `ViewerNavigator`, leaving a bare back chevron) and the body carries no
    heading of its own. "Restore access" named the destination the user tapped,
    not the situation they're in; printing it — in the bar, the body, or both —
    spends the top of the screen restating what they already know. The hero
    ("This calendar is locked") does the job a title should.
  - **No upgrade banner on the options screen**, unlike every other screen in
    the shell. Next to the one thing the user is trying to do it reads as an
    upsell for the problem itself — *pay us and maybe your calendar comes back*
    — which isn't even true: buying the unlock does not decrypt anything. The
    **request-sent confirmation is the exception** and carries the standard
    `ViewerUpgradeBanner`: once the request is away the user cannot act on the
    problem at all, and the app holds nothing for them until someone else
    responds, so the offer stops competing with a fix and becomes the honest
    answer to "what do I do now?". The line is *can the user still try
    something* — while they can, the offer waits.

  What it DOES carry, at the very bottom, is **Sign out** — the same quiet muted
  link the paywall demotes it to, an escape hatch rather than an offer. When
  this screen is the whole shell the calendar's overflow menu is unreachable, so
  sign-out has nowhere else to live; without it, someone signed into the wrong
  account, or who can complete none of the options here, has no way out but
  deleting the app.

  Actions, in order:
  1. **Passkey** — instant, involves nobody. Labelled **"Unlock with passkey"**,
     never "with Face ID": the same credential is Touch ID on a home-button
     device, and the system sheet names the right modality itself, so claiming
     one is wrong for some users and redundant for the rest. Expect it to be
     absent on TestFlight/beta builds (no associated-domains entitlement), so it
     can never be the only path offered.
  2. **Password** — shown **only** when `e2eePasswordStale !== true`. That flag
     separates the ordinary relaunch lock (no password in memory; the factor
     still opens the key) from the post-reset lock (the factor is wrapped under
     the old password and provably cannot). Offering it after a reset would BE
     the dead-end loop this screen exists to end; withholding it in the relaunch
     case would send someone with a working password off to bother the calendar's
     owner.
  3. **"Request access"** — re-keys ONCE and asks every owner. One action
     over the whole list, never one button per calendar: the new identity key
     replaces the single key every envelope was sealed to. **Its password field
     is not a "confirm it's you" checkpoint and must never be removed as one:**
     `rekeyIdentity` → `enroll(password)` mints the new identity keypair and
     wraps its private half under that password
     (`crypto.createPasswordFactor`), and that envelope IS the password factor
     the account unlocks with from then on. Drop the field and the new identity
     carries only a recovery-code factor — the viewer gets their calendar back
     and is locked out again on the very next relaunch, recreating the dead end
     this screen exists to end. **But it does not have to be typed here**, and
     usually isn't: a reset — or a sign-in whose unlock fails — leaves the app
     holding a password the server just verified, so `hasSessionPassword()` is
     true and the button re-keys on the spot, no sheet, spinner in place. The
     sheet is the fallback for a session holding nothing (a relaunch days later:
     token restored, nothing typed), and its copy then says what the password is
     *for* ("Use the password you sign in with now. It becomes this phone's key…")
     rather than asking someone to prove themselves. The memory-only hold and
     the tradeoff it accepts are specified in
     [../platform/crypto-e2ee.md](../platform/crypto-e2ee.md) "Re-key".
     An account holding its own encrypted records is warned — in items, not
     key-talk — before the re-key abandons them, **but a pure viewer never sees
     that warning.** A user who has not bought the unlock has never been able to
     create anything (the app is behind a hard paywall), so the only `Record` on
     their account is the "You" Person the client auto-seeds at boot
     (`lib/selfPerson`) — which the server's guard counts, telling someone who
     saved nothing that "1 items you saved in Calen" are about to be destroyed.
     A warning with no decision behind it is just a scare, so the client
     pre-confirms the guard (`confirmDataLoss: true` up front) when
     `!unlocked && no calendar of their own`. Owning even one calendar of their
     own means real content and the warning stands — which is what keeps the
     refunded ex-payer case honest. Access returns when the owner approves; see
     [households-sharing.md](households-sharing.md) and
     [../platform/crypto-e2ee.md](../platform/crypto-e2ee.md). The confirmation
     state **outlives the component and the session**: `GET /api/calendars`
     reports the requester's OWN seat stamps (`keyChangedAt`,
     `accessRequestedAt` — never anyone else's; the collaborator list stays
     unserialized), so a viewer who signs out and back in returns to the
     confirmation instead of a blank calendar whose ordinary sync note
     ("events appear the next time its owner opens Calen") gave no sign their
     request existed. `ViewerCalendarScreen` `replace`s to `ViewerUnlock` when a
     request is outstanding and nothing is readable yet — and while that hand-off
     is in flight it renders **nothing calendar-shaped**, just a bare backdrop
     with a loader. Letting the grid paint for those frames flashed an empty
     month with the waiting note floating over it: chrome that explains an
     ordinary sync delay, shown to someone whose request is genuinely pending,
     as the first thing they see after signing in. (The note itself stays for
     the case it exists for — a fresh share the owner hasn't wrapped yet, where
     no request is pending.) While waiting, the
     screen re-fetches the calendar list every 15s — approval clears both stamps
     server-side, and that poll is the only thing that would ever notice — then
     `replace`s to `ViewerHome`. That exit fires only after a pending request has
     been *observed* clearing, never on a first paint whose list hasn't loaded,
     which would bounce the user straight back to the empty calendar. It is laid
     out as
     **one centred column** — check, title, body, the ⓘ line, then the way out —
     because there is nothing to scan or compare, only a status to read; the ⓘ
     label therefore takes the same balanced-glyph treatment as the hero
     headline, since a bare string label stretched full width and read as a
     left-aligned form row with the glyph stranded at the screen edge. Its only
     actions are the upgrade banner on the bottom edge and Sign out. It
     deliberately does NOT offer "Back to calendar": the re-key left this account holding a brand-new
     identity that no calendar has been wrapped to yet, so that button landed
     the user on an empty grid which reads as the app having lost their data.
     There is nothing to go back to until an owner approves.
  4. **"I have a recovery code"** — a quiet link, not a button. Every viewer was
     *made* to save one at signup (the mandatory `RecoveryCodeModal` is mounted
     at the app root, outside this gate), so offering it costs nothing and
     rescues anyone who kept it; leading with it would make the screen read as a
     dead end for the many who didn't.

  Two rules hold that list together:
  - **Exactly one filled primary button** — the best path that can actually
    work, given what's available (passkey, else password, else request access).
    Everything below it is a `ghost` or a plain text link. A stack of
    equal-weight rounded rectangles asks a stuck user to make a decision instead
    of giving them an obvious next tap; the same rule the paywall follows.
  - **Typing happens in a `BottomSheet`, never unfolded inline.** "Unlock with
    password" and "I have a recovery code" each open a focused sheet with one
    field, one button, and its own inline `FormError`. Unfolding a form mid-page
    shoved the remaining options down the screen the moment the user reached for
    one, and left the page a different length in every state; the page stays a
    short, stable list of choices. Stale errors are cleared on every sheet open
    and close, so one path's failure never greets the user inside the next one.

  Before this existed the only unlock UI lived in Profile → Privacy & data,
  behind the paywall: a viewer's sole route back to a calendar someone shared
  with them was to buy the app.
- **The pushed paywall IS the gate's paywall.** The `UnlockPaywall` route
  carries a **transparent, title-less header**, so the screen is identical to
  what a locked user with no shares sees full-screen from the gate — the only
  addition is the floating back button, the one thing this instance needs. A
  titled bar over it would make one offer read as two different screens.
  Because the screen mounts both ways, it computes its own top inset (safe
  area + a reserved back-button band) with
  `contentInsetAdjustmentBehavior="never"`, so neither mount can drift from
  the other.
- **The home is a calendar, with the agenda behind a toggle.** Someone
  broadcasting a season schedule is read as a *calendar*, so the shell opens on
  a month grid, not a list:
  - **Grid layer (`ViewerMonthGrid`, the default):** a read-only cousin of the
    unlocked app's Details density — the same unbounded month window
    (`lib/calendarWindow`: opens on today's week, grows at either edge, the
    sticky month label's jump sheet teleports anywhere), the same **month
    blocks** (`lib/monthGrid`: each month its own grid, the neighbouring
    month's days blank in a boundary week, spans clipped at the boundary, the
    1st marked with the abbreviated month name in the app primary above the
    row's opening rule, which is the ordinary `colors.border` hairline drawn
    per cell over the month's own days only — calendar.md owns the rule) —
    including the
    **today anchor**: the grid opens with today's week under the header and
    **stays pinned there**, re-snapping on every offset change and content
    re-measure until the viewer drags it or jumps to a month (a programmatic
    scroll never releases the pin; tapping Today re-pins). A launch resolves
    its inputs in stages after the first frame is positioned, so a one-shot
    snap lands on offsets that are already stale — see calendar.md for the
    full rule, which `CalendarScreen`'s grid shares — labelled event chips
    (capped at three per cell, then "+N more") and labelled multi-day span
    bars. A chip or bar opens `ViewerEvent`; a day opens that day's full list
    in a sheet. There is no long-press create/edit, no weather lane, and no
    chores / tasks / meals / trips / occasions / holidays — a viewer sees
    events on calendars shared TO them and nothing else. It is a separate
    component, NOT a parameterization of `CalendarGrid`: every path that grid
    offers leads somewhere paywalled.
  - **List layer (`ViewerAgendaList`):** the day-grouped upcoming-events agenda
    (56 days). Its header carries the waiting/locked hint and nothing else —
    no roster of shared calendars: each row already wears its calendar's
    colour, and the list reads as "what's coming up", not "whose". Days are grouped by the date the event
    lands on and headed "Monday – Aug 3"; **today is anchored by the same
    marker the app's own agenda uses** (`dayview/AgendaView`) — accent rules
    either side of a "Today" label, with today's header tinted primary — and
    today always gets a section when there is anything to show at all, so the
    marker holds the list even on a quiet day. Today drives `scrollToToday`
    (`itemIndex: 0` addresses the section header, so an empty today is still a
    valid target).
  - Both layers stay mounted and crossfade in place (the list mounts lazily on
    first use) so the chrome never moves and each keeps its scroll position.
    The chosen layer persists per device (`hc_viewer_view`; the grid is the
    first-run default).
  - **One replica read feeds both.** The host holds the single
    `['viewer','sources']` query (`ensureSharedCalendarKeys` →
    `loadCalendarWindowSources`, `sync:'background'`); each layer expands the
    range it needs synchronously (`expandCalendarRange`), so the grid's window
    can grow without a refetch and both layers agree on what's on screen.
- **The shell's chrome** floats over the layers (`ViewerHome` therefore runs
  `headerShown: false`) and splits along the platform's own division of labour
  — **navigation on top, the offer on the bottom edge**:
  - **Top, leading:** the "Month Year" jump label, in **both** layers. The grid
    draws its own inside its sticky header — which now lives *in* the button
    row rather than a row of its own (the calendar gets that row back), so the
    host's slot there is empty and non-interactive and grid taps reach it. The
    list has no sticky header, so the host draws the same button for it,
    labelled with the month under the top of the list. A month picked from the
    list scrolls the agenda there when its rolling window covers that month,
    and otherwise switches to the grid and jumps it — month travel past the
    agenda's horizon is a calendar job.
  - **Top, trailing:** ONE pill carrying a **fixed menu glyph** (the iOS
    overflow ellipsis — a stable affordance, never a state-reflecting toggle),
    opening an `AnchoredMenu` — Calendar ✓ / List, then Print and Sign out.
    The upgrade path is deliberately NOT duplicated here: the banner owns it,
    and a promo row inside a utility menu is noise. The rows reuse the unlocked app's own view
    glyphs (`view-stream-outline` for the grid — the viewer grid *is* that
    Details view, read-only — and `format-list-bulleted` for the list), so the
    switcher survives the upgrade. Print and sign-out are rare, high-intent
    actions and deliberately do not get top-level icons; the checkmark, not
    the button, reports which view is active.
  - **Bottom edge:** a persistent **upgrade banner** — open-padlock glyph,
    "Unlock Calen", the value line, chevron — opening the same
    `UnlockPaywallScreen` a locked user *without* shares sees full-screen, and
    the shell's ONLY upgrade affordance. It states the value but deliberately
    **carries no price**: the cost belongs on the paywall, where the purchase
    is actually made, not on the way to it. The offer is a banner and NOT a nav
    button on purpose: the top-left slot is the platform's back/identity
    affordance (a promo there gets mis-tapped), and a promo shaped like nav
    chrome is read as a control and stops being seen. The shell still mounts
    `useBilling` — for its cache side effect alone, so a purchase made
    elsewhere, a refund, or an un-share re-routes the gate.
  - **Bottom-left:** **Today**, floating just above the banner, driving
    whichever layer is active (the unlocked app's corner). In grid mode the
    waiting/locked hint floats above it; in list mode it sits in the list
    header.
  - With **nothing shared** (the gate signal came from a pending invitation, or
    the owner un-shared their last calendar) an empty grid would explain
    nothing, so a "No shared calendars yet" state covers both layers, the view
    rows / Print / Today are withheld, and only the banner, the paywall row and
    sign-out remain. That verdict is gated on `useCustomCalendars().loaded` —
    the flag that the SERVER list has answered at least once this session, not
    merely that a cache was read. The calendar list arrives asynchronously, so
    an empty list before it lands means "still loading", and rendering the
    verdict early told a viewer who genuinely HAD a shared calendar that nobody
    had shared one with them. Until it lands the overlay shows a
    `CenteredLoader` instead.
- **Print (`ViewerPrintScreen`, route `ViewerPrint`)** renders on-device via
  the shared `buildPrintHtml` (E2EE — the HTML must be built client-side) and
  hands off to the OS print dialog / a shared PDF. It opens on the month the
  grid was showing, and its checklist is built from the **shared calendars
  alone**; the viewer's own lanes are emptied out of the payload before
  rendering, on top of `collectPrintItems`' selected-id filter. It deliberately
  does not reuse `PrintCalendarScreen`, whose checklist is assembled from the
  built-in lanes, holiday calendars, add-on ownership and the user's own
  visibility prefs — all paywalled surfaces here.
- **A viewer never triages invitations (2026-08-02):** the shell has NO
  Invitations inbox. Pending calendar-share invitations are **accepted
  silently** on shell entry and every focus (`ViewerCalendarScreen`'s
  auto-accept pass: `GET /calendars/invitations` → accept each `pending` row —
  accepting needs no crypto — then re-pull the calendar list, try the member
  wrap, and refetch billing status so the gate signal stays truthful), so a
  shared calendar simply appears in the list. Per-invitation accepts are
  best-effort; an offline miss retries on the next focus. A viewer therefore
  can't decline a share (the owner can un-share); the Accept/Decline inbox
  flow remains for unlocked users only.
- **Waiting state:** a freshly accepted share has no CalendarKey wrapped to
  this device until the owner's next unlocked session — any unlock path,
  fresh login included (`maintainKeyHygiene` → `reconcileCalendarKeys` from
  the auth store's keys-ready hook; there is deliberately no owner-facing
  prompt, the wrap is silent); the shell shows a per-calendar "events appear
  the next time its owner opens Calen" hint until `ensureSharedCalendarKeys`
  can unwrap the member envelope.
- **Transitions are cache-driven both ways:** buying the unlock flips
  `unlocked` (activation poll) → full app; a refund flips it back → viewer
  shell (if shares remain) or paywall. The shell's auto-accept pass (and the
  unlocked inbox's accept/decline) refetches billing status so the signal
  stays truthful.
- **The paywall stays client-side.** No server data route checks
  `User.appUnlocked` — a viewer's reads are authorized exactly like any
  outside collaborator's (calendar `accessFilter` / records resource lane);
  what the server DOES enforce is that `view`-access collaborators cannot
  write (see calendar.md — the `/records` calendar-lane 403). The on-device
  reminder scheduler runs for viewers too (shared-event alerts) — deliberate.

### Prepaid AI credits

- **Unit:** 1 credit = $0.01 of retail value. Balances live on
  `User.creditBalanceMc` in integer **millicredits** (1 credit = 1000 Mc) so
  tiny per-call debits never need float `$inc`s. UI shows whole credits
  (floored), and floors display at 0.
- **Chat is TOKEN-PRICED (the one variable action).** A chat turn's cost grows
  with the conversation length, so a flat price is unfair on short chats and
  underwater on long ones. Instead `chatStream` sums the turn's tokens across
  the whole agentic loop **PER TOKEN TYPE** (input / output / cache read /
  cache write — `credits.usageBreakdown` over each call's API `usage`) and
  debits **whole credits** sized to cover the turn's token provider-cost
  (`tokenCostMc` over the per-type breakdown, the same margin-free reference
  the flat actions estimate for reconciliation) **after Apple's storefront
  cut, plus a slight margin, ceiled to the next whole credit** —
  `credits.chatCreditsForTokens`. Per-type pricing is load-bearing, not a
  nicety: cache reads cost ~0.1× input and chat turns are cache-read heavy
  (the system+tools prefix is cached and re-read on every round trip), so the
  retired blended rate over-billed cache reads ~33× and made heavy turns read
  as 50–70 credits when their real cost was a few:

  > `credits = ceil( margin × costMc / (1000 × (1 − appleFeePct)) )`, min 1 for any
  > turn that spent tokens, 0 for a zero-token turn (fail open on cost).

  The knobs live in `credits.appleFeePct` (Apple's commission, default **0.15**
  — App Store Small Business Program) and `credits.chatMargin` (target markup on
  the after-Apple cost, **clamped [1.0, 1.5]**, default **1.0** — the ceil itself
  supplies the margin). The realized margin lands **~100–150%** of the token cost:
  the low end for long turns (the ceil is a small fraction of a big charge), the
  high end for short ones (absolute pennies). `meter('chat')` still pre-checks the
  balance and counts the turn but does **NOT** flat-debit — the debit is
  `recordChatCredits` once per completed turn, ledgered as action `chat`, and the
  whole-credit charge is returned to the client in the stream's `done` event as
  `creditsUsed` (the shared `ChatScreen` renders "N credit(s)" under each
  assistant reply — the app shows **credits spent, never raw tokens**). Chat is
  the only member of `credits.TOKEN_PRICED_ACTIONS`; `actionCosts.chat` survives
  only as a nominal anchor (kept out of the admin action-price editor) and is
  never debited. **Web search inside a chat is NOT a separate charge** — it
  runs inside the turn, so its result tokens are already in the chat debit;
  charging a per-search credit would double-bill them. `recordWebSearches` still
  records the count + the small per-search API fee for reconciliation, but debits
  nothing (see Provider-cost recording).
- **Debit math (flat published prices):** every OTHER action debits the FLAT
  per-action price from `credits.actionCosts` (whole credits: `scan: 3`,
  `generation: 3`, `manualParse: 40` — manual parsing runs on **Sonnet** over
  long documents and is priced rare-but-heavy, and it meters ONLY the AI
  routes (`auto-lookup`, `extract-tasks`); a plain manual **upload** or
  **save-from-URL** spends no model tokens and MUST NOT be metered or debited,
  `aiHelper: 1`;
  `callPerMinute: 20` prorated per connected second, ceiled at the
  millicredit) — **one debit per
  completed action**, charged by `meter()`'s finish handler on a 2xx, however
  many model calls the action made. Flat prices exist so users can predict
  spend, a new model id can never misprice a debit, and pricing is a knob
  decoupled from provider cost. An unknown action debits 0 (fail open on
  cost, never on features). The target margin (`credits.margin`, default 2.0)
  is built into the prices when they're set, not computed per call.
- **Usage debits are ledgered** (`CreditLedger.debit` — kind `usage` +
  `action`, negative `deltaMc`, no idempotency key): every balance movement
  has a row, so "where did my credits go?" is answerable from the app and
  reconciliation can sum debited revenue per action. A ledger failure falls
  back to the bare balance `$inc` — the balance must never drift from actual
  spend.
- **Provider-cost recording (reconciliation only):** `tokenRatesPer1M`
  (raw $/1M **per token type** — each model family maps to
  `{ input, output, cacheRead, cacheWrite }`, matched by model-family
  substring; defaults are Anthropic's real prices, e.g. sonnet
  `{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }`. A legacy
  stored NUMBER — the retired blended shape — is still honored by
  `tokenCostMc` (applied to every type, reproducing the old math) until
  `getSingleton` migrates it: known families take the current per-type
  defaults, unknown admin-customized families keep their number on every
  type. The admin PUT rejects bare numbers so the doc converges),
  `callRatePerMinute` (raw Vapi $/min), and `webSearchRatePerSearch` (raw
  Anthropic web-search fee, $0.01/search; the extra result tokens a search
  injects are already captured by the token counters) are the COST reference.
  For the flat actions they never drive a debit; `tokenRatesPer1M` is the one
  exception in that it ALSO supplies the raw cost the token-priced `chat` debit
  is built from (`chatCreditsForTokens`, above). `recordTokens` accumulates
  `usageTokens[period].costMc/byActionCostMc` (margin-free Mc; Mc/100000 = $,
  costed per token type via `usageBreakdown`) plus per-type token splits
  (`usageTokens[period].byType.{input,output,cacheRead,cacheWrite}`)
  per model call; `recordCallSecondsById` does the same on
  `usageCallSeconds[period].costMc` and debits the flat call price
  (`PhoneCall.metered` guards re-charging); `recordWebSearches` records
  `usageWebSearches[period].{count,costMc}` for reconciliation only — it
  **debits nothing** (web-search result tokens are already in the chat debit;
  the residual per-search API fee shows here as a small unbilled cost that
  drags chat's margin).
- **Margin reconciliation:** `GET /api/monetization-config/reconciliation`
  `?period=YYYY-MM-DD` (admin) sums debited revenue (usage-ledger rows in the
  weekly window, by action) against the estimated raw provider cost (the cost
  counters) → `marginMultiple` (≈ 2.0 = flat prices hold the target margin).
  This is how `actionCosts` gets tuned against real spend.
- **Enforcement** (`middleware/usageMeter.js`): `meter(action)` pre-checks
  `creditBalanceMc > 0` → **402 `CREDITS_EXHAUSTED`** (payload: `action`,
  `balance`, `packs` hint) when spent. A call's cost is known only after it
  runs, so the last call may overdraw slightly (balance can dip negative) and
  the NEXT call is blocked. Placing a phone call pre-checks **one minute** of
  call cost (`meterCallSeconds` on the call routes; the chat `call_business`
  tool pre-checks inline) — calls can't stop mid-sentence at zero. Weekly
  windows survive as ANALYTICS only (the "Where your credits go" card and admin
  charts); nothing is enforced weekly. All usage counters (action counts incl.
  chat-surface breakdown, tokens, call seconds) are written per-USER only —
  the household-level counters were retired with the per-user restructure
  (`Household.usage*` is frozen legacy data; fleet analytics sum the user
  counters). Fail-open doctrine stands: a metering bug must never take down a
  feature.
- **Packs** are consumable IAPs in the RC **`credits` offering**, matched by
  product id: `credits_499` ($4.99 → 500), `credits_999` ($9.99 → 1050),
  `credits_1999` ($19.99 → 2200) — volume bonus on bigger packs; catalog in
  `MonetizationConfig.credits.packs` (prices are display fallbacks).
- **Grants are ledgered and idempotent** (`CreditLedger`): kinds `purchase` /
  `starter` / `plan` / `refund` / `admin`; the unique sparse `transactionId` index is
  THE webhook idempotency gate (insert the row first, then `$inc` the
  balance; `grant()` awaits index readiness). Purchases key on the store
  `transaction_id` (falling back to the RC event id); a refund debits the same
  amount under `<txn>:refund` and MAY drive the balance **negative** — no
  clamp; enforcement blocks at ≤ 0 and new credits top up the hole first.
  Usage debits are NOT ledgered (high volume) — fire-and-forget `$inc`s.
- **Starter grant:** registration grants `credits.starterCredits` (default
  100) once per user (ledger key `starter:<userId>`), best-effort — a grant
  failure never fails signup — so the AI can be tried before the first pack.
- **Admin exemption** (`admin.unlimitedAi`, default true): admin-role users
  skip the pre-checks only; usage is still tracked and debited. Status reports
  them `unlimited: true` and clients render "Unlimited" instead of a balance.
- Admin override: `POST /api/monetization-config/credits`
  `{userId, credits, note}` — ledgered (kind `admin`, deliberately not
  deduped) and audited (`credits_adjusted`).

### The Calen AI plan (optional monthly subscription)

- **Product** `calen_ai_monthly_499` ($4.99/month display fallback), an
  auto-renewable subscription with RC entitlement **`calen_ai`**, configured in
  `MonetizationConfig.aiPlan` (`productId`, `price`, `monthlyCredits`,
  `entitlement`). Sold from its own RC **`ai_plan` offering** (never in
  `current` or `credits`).
- **Each paid period grants `monthlyCredits`** (default 600 — a better
  per-credit rate than any pack, the subscriber advantage):
  `INITIAL_PURCHASE` and every `RENEWAL` grant via `CreditLedger.grant` (kind
  `plan`), idempotent on the store transaction id (every renewal carries a
  fresh one; re-deliveries dedupe). Granted credits are ORDINARY balance —
  they never expire and survive plan expiry; there is no separate plan bucket
  and no feature gated on the plan itself.
- **Lifecycle** (`planUpdateForEvent`, pure/exported): a refund
  (`CANCELLATION` + `CUSTOMER_SUPPORT`) claws the period's grant back
  (`<txn>:refund`) and deactivates; `EXPIRATION` deactivates without touching
  credits; `UNCANCELLATION` reactivates; auto-renew toggles and billing-grace
  noise are acked with no change until expiry. State lives on
  `User.aiPlanActive` / `aiPlanExpiresAt`, set by the webhook.
- `GET /billing/status` reports `aiPlan { active, productId, price,
  monthlyCredits, expiresAt }`; the CreditsScreen renders the plan card from
  it (subscribe CTA when inactive; active state shows the renewal grant).
- **Post-purchase the client polls until the credits land, not just until
  `active` flips.** The webhook applies a plan purchase in two writes — it sets
  `User.aiPlanActive` FIRST, then `CreditLedger.grant` `$inc`s the balance a
  moment later — so a poll that gated on `aiPlan.active === true` alone could
  complete on a snapshot caught mid-grant, freezing a stale pre-credit balance
  into the cache until the next focus refetch (History would still update,
  because the ledger is refetched after the poll completes). `useAiPlanActivation`
  therefore takes the pre-purchase balance snapshot and completes only when
  `aiPlan.active === true` AND `creditBalanceMc` has risen past it (same balance-
  rise doctrine as the credit-pack poll), so the "your monthly credits have been
  added" success copy and the displayed balance are truthful together.
- **Managing / cancelling (client-side).** An auto-renew-off cancellation is a
  no-op server-side until expiry (see Lifecycle), so `aiPlan.active` alone
  cannot distinguish "will renew" from "cancelled but still active". The **only**
  source of that intent is the RC SDK's CustomerInfo
  (`entitlements.active['calen_ai'].willRenew` / `expirationDate`). The client
  folds the server base with that snapshot in a pure `deriveAiPlanState`
  (`lib/planState.ts`) into **three display states**, degrading to the server
  base whenever RC is unavailable (dev builds, offline, missing entitlement) so
  a false "cancelled" is never shown:
  - **renewing** — active + `willRenew` true (or no readable entitlement): the
    "renews with N credits on ⟨date⟩" card, today's behavior.
  - **cancelled** — active + `willRenew` false: a distinct "Cancelled — plan
    benefits until ⟨date⟩. Your credits are yours forever." card.
  - **inactive** — server reports not active: the subscribe CTA.
  Both active states carry a **Manage subscription** affordance (iOS-only — no
  Play Store product exists) that opens the native Apple manage-subscriptions
  sheet (`Purchases.showManageSubscriptions()`; wrapped in `lib/purchases.ts`
  with the same not-configured guard as the other calls), where cancel AND
  re-subscribe both happen. Fallback chain when the sheet is unavailable:
  `customerInfo.managementURL` → `Linking.openURL(<Apple subscriptions URL>)`.
  Returning from the sheet refetches RC CustomerInfo **and** billing status (on
  screen focus and app foreground) so a cancellation or reactivation shows
  without an app restart. The server is untouched by this flow.

### Account deletion × billing

Account deletion (`DELETE /auth/account`, mechanics owned by
[auth-identity](auth-identity.md)) is billing-aware, but it can never touch
the store relationship — only Apple can cancel an auto-renewable
subscription. Normative behavior:

- **The client warns before the wipe.** When `status.aiPlan.active`, the
  Delete-account flow MUST interpose a warning BEFORE the destructive
  confirm: deleting the account does not cancel the subscription — Apple
  keeps billing it. The warning offers **Manage subscription** (the native
  manage-subscriptions sheet with the Apple-subscriptions-URL fallback, same
  affordance as the plan card), **Delete anyway** (proceeds to the normal
  confirm), and Cancel. Billing status unavailable (offline, fresh cache)
  degrades to the plain confirm — deletion is a right (Apple 5.1.1(v)) and
  MUST NOT be blocked on a billing read.
- **The confirm names forfeited credits.** When the remaining balance is
  positive, the destructive confirm states that the N remaining credits are
  forfeited — credits are prepaid value, and silent forfeiture reads as
  theft.
- **The good-bye email repeats the reminder.** `deleteUserAndData` passes
  `hadActiveAiPlan` (the user's `aiPlanActive` at wipe time) into the
  `account_deleted` email (content owned by
  [email-lifecycle](email-lifecycle.md)) so the cancel-it-in-Apple-settings
  pointer survives after app access is gone.
- **RevenueCat subscriber purge (best-effort).** When
  `REVENUECAT_SECRET_API_KEY` is configured, deletion issues RevenueCat's
  `DELETE /v1/subscribers/{id}` for the user id and any stored
  `revenueCatId` alias — data minimization matching the full-wipe promise.
  This removes RevenueCat's copy of the purchase history; it does NOT cancel
  the store subscription. Unconfigured or failing → skipped silently; the
  purge MUST never fail or delay the account deletion itself.
- **Post-deletion webhooks are acked.** Events keyed to the dead id resolve
  no user and are acked `{matched: false}` — RevenueCat never retries into a
  loop, and a renewal billed between deletion and a later re-signup grants
  nothing (the period's credits are gone with the account; the store
  relationship is the user's to end).
- **Restore after re-signup works.** A returning user (new user id, same
  Apple ID) gets the unlock back via the deleted-losing-id `TRANSFER` rule
  above, and the plan re-attaches on its next renewal event. Nothing is ever
  charged twice: the unlock is a non-consumable and Restore is free.

### Feature-calendar add-ons

- Add-ons come in two classes, both acquired on the **"Add-ons" store screen**
  (`screens/plan/AddOnsScreen.tsx`) and both **opt-in — never default-added**:
  - **Paid** — Meals (`recipes`), Maintenance (`maintenance`), Trips
    (`trips`): one-time purchases, $2.99 catalog fallback each (the store's
    localized price is authoritative).
  - **Free** — Occasions (`birthdays`), Chores (`chores`): included with the
    app at **catalog price 0**, but a household MUST explicitly add them
    ("Get", in an **"Included free" section rendered first** — above the
    bundle and paid cards, so the zero-friction claims lead the screen and the
    locked free calendars' "Add for free" entry lands on target; a
    "One-time purchases" eyebrow then opens the paid region; ordering is
    state-stable — claimed cards stay put as "Added") via
    `POST /api/billing/addons/claim`
    — any authenticated member; validated against the catalog's price-0 items
    so a paid key can never be claimed; idempotent (`$addToSet`). Free add-ons
    are never sold through the store and never touch RevenueCat. (The retired
    `addon_birthdays` entitlement from the pre-release paid era is ignored by
    the webhook.)
  Only **Activities, Appointments, and Weather ship enabled** by default. The
  screen MUST be titled "Add-ons" — never "App Store" (App Review 5.2.5) — and
  MUST show Restore Purchases and the Terms/Privacy links near the purchase
  CTAs.
- An **owned add-on whose calendar this device has locally deleted** (built-in
  delete is a device pref, not a server state) MUST NOT show the green
  "Added/Purchased" check — that reads "all set" while the calendar is hidden.
  Its card instead shows an accent-tinted `+` restore affordance that runs the
  **same device-local restore** as the Add Calendar chooser's Deleted
  Calendars rows (`restoreDefault`: un-delete + events visible again; no
  server call), after which the card returns to the check state.
- **Ownership is per user; the effect is household-wide.** Ownership lives in
  **`User.addons`** (calendar-id keys) because that is who buys: RevenueCat keys
  every purchase to `app_user_id` = the user id. Granted/revoked ONLY by the
  webhook (`addonUpdateForEvent`, exported/tested), the claim route, or the admin
  override `POST /api/billing/addons`. `GET /billing/status` then returns the
  **union across household members** (`ownedAddonsFor`), so any one member's
  purchase unlocks the lane for everyone and a household still pays once for a
  feature its members share.
  - **Why not per-user effect.** The records these add-ons surface live in the
    shared household store, sealed under the household key — a non-owning member's
    device already holds them. Gating per user would draw a curtain over data the
    device has, which is unenforceable (the record store is opaque, so enforcement
    is client-side) and incoherent to users who share everything else. It would
    also charge a couple twice for one shared feature, on top of the per-user
    unlock they each already bought.
  - **Why not per-household ownership.** A household is a container you can leave.
    Storing the entitlement there detached it from the buyer: leaving minted a
    fresh household with an empty set, silently dropping add-ons the departing
    member had paid for themselves (recoverable only by tapping Restore, and
    invisible until they thought to). Removal did the same to the removed member's
    own purchase. Per-user ownership makes a purchase survive joining, leaving,
    and removal, with no join-time bookkeeping — `Household.addons` is retired to
    LEGACY, read by nothing.
  - **Migration.** `scripts/backfillUserAddons.js` copies each household's set onto
    its members (idempotent `$addToSet`; dry-run by default). It MUST run
    **before** the deploy — it only writes `User.addons`, which the old code
    ignores, whereas deploying first would union an empty set and strip every
    customer's add-ons until it ran. The local data never recorded which member
    paid, so attribution is a choice between two modes, neither of which can cost
    a current member ACCESS (the effect is the union either way — they differ only
    in who keeps an add-on on leaving):
    - **default** — grant the whole set to every member. Preserves today's
      entitlements exactly; over-grants, so a household that later splits leaves
      several people owning what one of them bought.
    - **`--paid-to-owner`** — paid keys go to the household owner, free ones
      (catalog price 0, claimed rather than bought, so there is no buyer to
      attribute) still go to everyone. Correct when the household formed around
      one person's purchase, and it avoids gifting a permanent paid entitlement to
      someone who joined later (an invited relative, a beta tester).
- A **free claim** needs no household — it lands on the claiming user, so a solo
  user can claim one just as a member can.
- The admin portal surfaces ownership read-only via the monetization list
  endpoints. `GET …/users` now reports what each user **owns**, so the billing
  table finally distinguishes a buyer from someone who merely lives with one (it
  previously mirrored the household's set onto every member).
  `GET /api/monetization-config/households` reports the **union across members** —
  what the household can use — with each member row carrying its own owned set, so
  a household's access and its provenance are both visible. Chip labels/paid-vs-free
  display metadata live in `admin/src/lib/addons.js`, mirroring the catalog defaults.
- The **bundle** ("All add-ons", $7.99 fallback) is a store product attached to
  all three RevenueCat entitlements — the server has no bundle concept; a
  bundle event simply carries all three entitlement ids. The client hides the
  bundle CTA once any single PAID add-on is owned (a partial owner buying it
  would double-pay; claimed free add-ons don't count). Add-on packages live in
  a dedicated `addons` RevenueCat offering, never in `current`.
- A refund (`CANCELLATION` + `cancel_reason: CUSTOMER_SUPPORT`; `EXPIRATION`
  defensively) revokes exactly the event's add-on entitlements. Grant events
  are idempotent (`$addToSet`).
- **No grandfathering, no defaults:** a household without an add-on (unbought
  paid OR unclaimed free) MUST NOT see the feature's screens or calendar items
  — existing and new households alike. The feature's data is retained (never
  deleted) and MUST reappear, with the user's prior visibility/colour/order
  prefs, on purchase/claim.
- **Enforcement is client-side** — the opaque record store means the server
  cannot gate feature data by type; the server is the entitlement ledger
  surfaced via `GET /billing/status` (`addons`, `addonCatalog`). The client
  (`lib/addons.ts`) caches the last-known owned set on-device (`hc_owned_addons`)
  for offline; an unknown + uncached state reads as **locked**. Enforcement
  points: each add-on feature home screen (Kitchen, Maintenance, Trips,
  Occasions, Chores) renders `AddonLockedView` (a full-screen interstitial;
  free add-ons say "Add for free" instead of a price) when locked — covering
  Calendars rows, deep links, AI navigation, and restored nav state — and
  `loadCalendarData` zeroes locked features' arrays at the same chokepoint as
  custom-calendar access filtering (grocery-shopping markers lock with
  `recipes`), so the grid, day/agenda/list, search, print, reminders, and
  assistant reads exclude them together.
- **The owned-set cache is ACCOUNT state, with two obligations that follow:**
  1. **Sign-out clears it** (`resetOwnedAddons()` from the auth store's
     logout, with the replica and calendar prefs). `hc_owned_addons` is
     unscoped and every session's billing fetch overwrites it, so without the
     clear the previous account's entitlements are the next account's boot
     state — observed as an owner signing in after a viewer session (which
     owns nothing) and getting Occasions/Chores/Meals data zeroed. The next
     session starts from the safe default (locked) until its own
     `/billing/status` lands.
  2. **A changed owned set invalidates the `['calendar']` and `['viewer']`
     query trees** (`cacheOwnedAddons` compares old vs new). The assembled
     calendar EMBEDS the set — `loadCalendarWindowSources` snapshots
     `ownedAddonIds` into the sources query result and `applyAddonLocks` runs
     from that snapshot — so subscriber re-renders alone cannot un-lock a
     stale verdict; without the invalidation the zeroed lanes persisted until
     an unrelated invalidation (observed: until the user happened to save an
     event). An identical set (the steady-state refetch echo) must NOT
     invalidate, or the invalidate → refetch → re-mirror path would cycle.
  The custom-calendar list has the same embedded-snapshot obligation
  (`accessibleCustomIds`) — `commitCustom` invalidates the same trees on a
  real list change (normative in calendar.md).
- **Every signed-in shell mounts `useBilling` at its root** so the mirrors
  refresh without depending on which screen the user visits: the viewer shell
  (`ViewerCalendarScreen`), the hard paywall, and — since the sign-out clear —
  the unlocked app itself (`AppNavigator`). Without the last one, a fresh
  sign-in booted locked-by-default and the month grid's add-on lanes stayed
  empty until the user happened to open a screen that mounts the hook
  (Calendars, Profile…). Mounting it at the navigator root bounds the locked
  window to one `/billing/status` round-trip, and the changed-set
  invalidation above repaints the grid the moment it lands.
- Post-purchase, the client polls `GET /billing/status` until the owned set
  changes (`useAddonActivation`, same webhook-gap pattern as unlock
  activation); a timeout reassures ("payment received — unlocks shortly")
  rather than alarms. Free claims have no webhook gap: the claim response is
  authoritative and a single billing refetch re-mirrors the owned cache.
- The add-on catalog (labels, fallback prices, descriptions) lives in
  `MonetizationConfig.addons` and is served as `addonCatalog` for display.

### Billing surfaces (client)

- `screens/plan/`: **UnlockPaywallScreen** (the hard paywall),
  **CreditsScreen** (route `Credits`, title "AI credits" — a push, since it
  drills into Credit history), **BuyCreditsSheet** (modal route `BuyCredits`,
  params `{ reason: 'low' | 'out' }`, dismissed with the shared
  `HeaderCloseButton` ✕ — buy a pack and return to whatever nudged the top-up),
  **AddOnsScreen** + **AddonLockedView**. ComparePlans/AiUsage/UpsellSheet are
  gone with the subscriptions.
- The **pack store** is one shared component (`screens/plan/PackStore`),
  rendered by CreditsScreen and BuyCreditsSheet alike so the two surfaces
  can't drift. Select-then-confirm: one selectable tile per catalog pack
  (radio semantics, catalog order) showing the credit amount and the
  localized store price (USD catalog fallback until RC loads), plus a single
  full-width CTA that restates the selected purchase ("Buy 2,200 credits for
  $19.99") and a "one-time purchase · credits never expire" footer. Value
  framing is computed from the catalog, not hard-coded
  (`packValueFraming`): each pack's credits-per-dollar vs the first pack's
  renders as a full-width ribbon strip across the tile's top — "+N%" on
  better-rate packs, "BEST VALUE" on the richest (ties → biggest), which is
  also pre-selected. A strip, not a floating pill, so it can't wrap or
  collide on narrow screens; every tile reserves the strip height so the
  row stays uniform. The CTA disables while the selected pack has no store
  package; `busyId`/activation drive its spinner.
- **CreditsScreen** shows: the balance hero ("Unlimited" for exempt admins;
  display floored at 0 with an arrears note when the raw balance is
  negative), low/out badges, the **Calen AI plan card** (from `status.aiPlan`
  folded with the RC will-renew snapshot via `deriveAiPlanState` — subscribe
  CTA + monthly-credits value framing when inactive; "Active · renews with N
  credits on ⟨date⟩" + **Manage subscription** when renewing; "Cancelled —
  benefits until ⟨date⟩, credits yours forever" + **Manage subscription**
  (re-subscribe) when auto-renew is off; hidden for unlimited admins), the
  **pack store** (hidden for unlimited admins), the
  **"What things cost"** card (the per-action prices from
  `status.actionCosts`, plain labels — "Chat message · Varies with length"
  (chat is token-priced, so there is no flat number — each reply reports its
  own credit cost in-thread), "Phone call · 20 credits/min" — so spend is
  predictable before it happens; there is **no** web-search row (it is not a
  separate charge); labels
  MUST describe what the action actually meters: `scan` is "Photo scan"
  (item + recipe photo imports — receipts are plain E2EE attachments, never
  AI-scanned), `generation` is "Recipe generation" (from-description +
  suggestions — no plan generation exists), and `manualParse` is "Owner's
  manual parsing" (the Maintenance manuals AI: auto-lookup + extract-tasks —
  the row label stays short; "parsing" names the feature family); it's a
  **rate card**, so the token-priced **chat row pins FIRST** (sorting it by its
  nominal number would mislead), then flat rows sort by price **ascending from
  the live server values** — never a hard-coded order, which would go stale when
  `actionCosts` is re-tuned — with ties broken alphabetically by label and
  the **per-minute call row pinned last** regardless of price: its unit
  differs from the per-action rows and the per-second billing note under the
  list is its footnote), the
  **"Where your credits go"** card (credits **SPENT** per feature this week
  from `status.spend`, biggest-first, with a "Spent this week" total row and
  the weekly-window caption — a spend summary, not raw action counts and not a
  cap; hidden when nothing was spent), the **History** card
  (`GET /billing/credits/ledger?grants=1` → **purchases & grants only** — packs,
  plan periods, welcome credits, refunds, adjustments; usage debits are
  summarized in the spend card above, never itemized here, so the log stays
  legible instead of a per-message wall). The History card is **capped** at the
  most-recent few rows (`HISTORY_PREVIEW`, currently 5) so it can't grow
  unbounded; when more grants exist it renders a **"See all history"** drill-in
  to the **CreditHistory** screen. Both the card and that screen read the same
  `useCreditLedger` query (shared cache key `['billing','ledger']`, invalidated
  after a purchase lands), so "See all" opens instantly from the warm cache.
  And the Terms/Privacy links. The AI on/off and
  personal/contact-info toggles are **not** here — they're privacy choices, so
  they live on `PrivacyDataScreen` (Profile → Privacy & data); see
  [ai-assistant.md](ai-assistant.md).
- **CreditHistory** is the full purchases & grants ledger the History card's
  "See all" opens: a month-grouped `SectionList` (newest-first, pull-to-refresh)
  reading the shared `useCreditLedger` query. Usage debits never appear (the
  server returns grants only). Empty state when the ledger is bare.
- **BuyCreditsSheet** is the focused conversion surface: the pack store + one
  job. Opened by the low-balance nudges with `reason` driving the copy.
- **CreditsBanner** (inside the AI assistants, replaces the 80%-of-quota
  banner) renders when the server says `lowBalance` — nothing for unlimited
  admins or healthy balances. It informs; it never blocks.
  **QuotaBlockedNotice** is the wall itself: rendered on a 402, CTA "Buy
  credits" → `BuyCredits { reason: 'out' }`.
- **ProfileHome** shows an "AI credits" card — balance + low/out badge —
  drilling into `Credits`. The old mini-gauges/subscription cards are gone.
- **Pre-call cost transparency:** every surface that places an assistant
  phone call shows the flat call price BEFORE the call is placed ("~20
  credits/min", from `status.actionCosts.callPerMinute`) — the call is the
  most expensive action, and cost surprise there is where credit systems lose
  trust.
- Purchase hooks (`screens/plan/shared.ts`): `useUnlockPurchase`,
  `useCreditsPurchase`, `useAddonPurchase`, `useAiPlanPurchase` — RC
  identity, offering load, catalog↔package pairing (`unlockPackage`,
  `packForRcPackage`, `addonForPackage`, `aiPlanPackage` — none may
  cross-claim another product class), buy → activation poll
  (`useUnlockActivation` / `useCreditsActivation` / `useAddonActivation` /
  `useAiPlanActivation`), restore. When an activation poll reaches `active` (the
  webhook has landed, so any new `CreditLedger` row exists too) it invalidates
  the `['billing', 'ledger']` query, so the **History** card shows the new grant
  immediately rather than waiting out its 60s `staleTime`.
  `useAiPlanPurchase` additionally exposes the RC `entitlement` snapshot (the
  will-renew source for `deriveAiPlanState`), `manage()` (native
  manage-subscriptions sheet + managementURL/App-Store fallback, then refresh),
  and `refresh()` (refetch CustomerInfo + billing, wired to screen focus / app
  foreground).

### Monetization config & admin app

- `MonetizationConfig` (a single doc) holds `credits` (margin — the target
  the flat prices bake in, `tokenRatesPer1M` (per-type
  `{ input, output, cacheRead, cacheWrite }` $/1M per family) +
  `callRatePerMinute` — the
  provider-cost reference for reconciliation (and, for `tokenRatesPer1M`, the
  raw cost the token-priced chat debit is built from), `appleFeePct` +
  `chatMargin` — the token-priced-chat knobs (Apple's cut, default 0.15; the
  after-Apple markup, clamped [1.0, 1.5], default 1.0), `actionCosts` — the flat
  published debit prices (chat's entry is a nominal sort anchor, never debited),
  `starterCredits`, `lowBalanceThreshold`, `packs`),
  `unlock` (price, productId), `aiPlan` (productId, price, monthlyCredits,
  entitlement), `costs` (reference only), `models`, `addons`, `guards`
  (`mapsPerDay`), `admin`. `getSingleton` backfills `credits.actionCosts`,
  `credits.appleFeePct`/`chatMargin`, and `aiPlan` on docs predating them,
  and migrates legacy blended (numeric) `tokenRatesPer1M` entries to the
  per-type shape.
  The subscription-era `tiers`/`activity`/`fees` sections are stripped by
  `getSingleton` (which also backfills new sections and force-syncs catalog
  items DEFAULTS declares free, so a stale paid price can't block a claim, and
  **strips a stored `actionCosts.webSearch`** — web search is no longer a
  charge). Edited only through the admin app via `/api/monetization-config`
  (`requireAdmin`) — the AI-credits editor exposes the **chat token-pricing
  knobs** (`appleFeePct`, `chatMargin`, validated in the same [0,1) / [1.0,1.5]
  bands as the server) alongside the token rates, and **excludes `chat` from the
  flat action-price grid** (it's token-priced, not a flat debit).
- Admin **Billing** view lists per-user state (`GET /monetization-config/users`:
  unlocked chip, credit balance — negative highlighted — RC id,
  revenuecat-vs-manual source) with Grant/revoke-unlock and Adjust-credits
  actions. **Households** view is analytics-only (plan column/override gone).
  **AI usage** view shows per-user tokens/trend/call-time + credit balance
  (tier limit columns gone); the fleet cards and hammering/spike abuse flags
  stay. Insights counts **unlocked users** instead of paid households.

## Data & API surface

- **Models:** `User` — `revenueCatId`, `appUnlocked(+At)`, `unlockProductId`,
  `creditBalanceMc`, `aiPlanActive` / `aiPlanExpiresAt`, usage analytics
  counters (incl. the `costMc`/`byActionCostMc` provider-cost estimates).
  `CreditLedger` — every balance movement (kinds `purchase`/`starter`/`plan`/
  `refund`/`admin`/`usage` + `action`), unique sparse `transactionId`.
  `Household` — `addons` + fleet analytics counters (all `plan*`/baseline
  fields deleted). `MonetizationConfig` as above.
- **Endpoints:** `billing.js` — `POST /webhook`, `GET /status`
  (`{ unlocked, unlockPrice, creditBalance(+Mc), lowBalance, unlimited, packs,
  actionCosts, aiPlan, usage, spend, usageScope:'user', resetsAt, hasHousehold,
  models, addons, addonCatalog }` — `spend` maps action→credits spent this
  period, aggregated from the caller's usage-debit ledger rows in the window,
  and drives the "Where your credits go" card), `GET /credits/ledger` (entries
  carry `kind` + `action`; the unfiltered default returns usage rows too — up to
  50, for reconciliation — while `?grants=1` returns **purchases & grants only**
  up to 200, the mode the History surfaces use so a heavy AI user's grant history
  isn't pushed out of the window by usage-row volume), `POST /addons/claim`,
  `POST /addons` (admin).
  `monetizationConfig.js` — config CRUD, `GET /households`, `GET /users`,
  `POST /unlock`, `POST /credits`, `GET /reconciliation`.
  `/api/admin/analytics` (per-user rows now carry `creditBalance`, no tier
  limits; overview totals `unlockedUsers`).
- **Client:** `screens/plan/*`, `lib/purchases.ts` (user-id identity),
  `lib/addons.ts`, `lib/unlock.ts`, `hooks/useBilling.ts`; admin app.
- **Config:** `REVENUECAT_WEBHOOK_SECRET`; `REVENUECAT_SECRET_API_KEY`
  (optional — enables the best-effort subscriber purge on account deletion);
  `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_RC_ANDROID_KEY` (build env).

## Encryption boundary

Unlock state, credit balances and AI-usage counts are server-visible by
necessity (counts and money only, never prompt content). See
[operations/transparency.md](../operations/transparency.md).

## Verification

- Webhook: secret verification; unlock grant/refund-revoke; pack credit +
  **same-transaction-id dedupe**; refund → negative balance + independent
  refund dedupe; TRANSFER moving the unlock; legacy tier events acked;
  unknown-user ack; status payload (unlock/balance/low/packs/actionCosts/
  aiPlan); ledger endpoint incl. usage rows; starter-grant idempotency; plan
  purchase/renewal grants + dedupe + EXPIRATION-keeps-credits;
  `CreditLedger.debit` row + balance; **TRANSFER whose losing id resolves to
  no user still grants the unlock** — `billingWebhook.integration.test.js`.
- Account deletion × billing: the RevenueCat subscriber purge (fires for the
  user id + `revenueCatId` alias when the key is set, skipped without it,
  never throws) and the `hadActiveAiPlan` email reminder —
  `authFlows.integration.test.js` (deletion flow is auth-identity's).
- Pure event mapping (`unlockUpdateForEvent` / `creditUpdateForEvent` /
  `addonUpdateForEvent` / `planUpdateForEvent` — no cross-claims) —
  `routes/billing.test.js`.
- Credit math (flat action prices incl. unknown-action fail-open, prorated
  call price, margin-free cost estimates, per-type family rates +
  `usageBreakdown` mapping + legacy blended-number compatibility,
  ceil-at-millicredit incl. float-noise guard, pack lookup, packsHint,
  **token-priced chat**: `chatCreditsForTokens`/`chatDebitMc` over per-type
  breakdowns — after-Apple + margin ceil, min-1, zero-token/no-rate
  fail-open, fee/margin knobs incl. out-of-band clamp) —
  `services/credits.test.js`.
- Meter helpers (`creditStatus` thresholds/negative/admin-exempt,
  `periodUsage`, `totalTokens`, `adminUnlimited`) —
  `middleware/usageMeter.tokens.test.js`.
- Add-ons: purchase/bundle/claim grants + idempotency, refund revocation,
  free-claim validation, admin override auth —
  `billingWebhook.integration.test.js`.
- Client gating: owned-set cache semantics + `applyAddonLocks` —
  `lib/__tests__/addons.test.ts`; unlock cache (locked-when-unknown,
  round-trip, sign-out clear) — `lib/__tests__/unlock.test.ts`; RC product
  mapping (`addonForPackage`/`packForRcPackage`/`unlockPackage`, no
  cross-claims) — `screens/plan/__tests__/shared.test.ts`. Calen AI plan state
  derivation (`deriveAiPlanState`: willRenew true/false, missing entitlement,
  RC-not-configured → server-base fallback, expiry preference) —
  `lib/__tests__/planState.test.ts`; the three plan-card states + Manage button
  wiring — `screens/plan/__tests__/CreditsScreen.test.tsx`.
- The store purchase path (`react-native-purchases`) is exercised on-device
  only (sandbox).

## Open questions

- Tune `credits.actionCosts` once `GET /monetization-config/reconciliation`
  has a few weeks of real spend: `marginMultiple` drifting below ~2.0 means a
  flat price is underwater; also true-up `tokenRatesPer1M` /
  `callRatePerMinute` against actual Anthropic/Vapi invoices so the cost side
  of the comparison stays honest. For token-priced **chat**, the same
  `tokenRatesPer1M` true-up directly moves the per-turn charge; `chatMargin`
  (default 1.0) is the knob to raise if the realized margin trends low, and
  `appleFeePct` must track the actual App Store tier (0.15 vs 0.30) if the
  Small Business enrollment changes. (The former blended-rate distortion —
  cache reads billed at the full blended rate, ~33× their real cost — is
  RESOLVED: rates are per token type and the chat debit prices each type at
  its own rate. The remaining true-up is just keeping the per-type rates in
  sync with Anthropic's published prices when models change.)
- `aiPlan.monthlyCredits` (600) is a launch guess — revisit against pack
  purchase patterns once the plan is live (it must stay the best per-credit
  rate or the plan has no reason to exist).
- Restore on a shared Apple ID transfers the unlock between accounts (RC
  transfer behavior). Accepted v1; revisit if support tickets appear.
- Add-ons belong to the household: a user who moves households loses them
  there until Restore Purchases re-grants to the new household. Acceptable v1.
