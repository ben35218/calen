---
title: Billing — app unlock, AI credits & add-ons
status: current
last-verified: df8c7f3+ (2026-07-31); FREE VIEWER MODE (new normative section) — a locked non-admin user with viewer content (≥1 accepted calendar collaboration or ≥1 pending calendar invitation) gets the read-only `ViewerNavigator` shell instead of the hard paywall: `GET /billing/status` gains `viewer: { calendarCollaborations, pendingCalendarInvitations }` (`calendarSharing.viewerContentCounts`, address-matched so pre-signup invites count), mirrored on-device by the new `lib/viewerAccess.ts` (`hc_viewer_content`, unlock-cache doctrine: safe-default paywall, cleared on sign-out), RootNavigator's gate branches `needsUnlock` on the cached signal and holds the splash for both caches; the shell = shared-calendar agenda (`ViewerCalendarScreen`, `mine:false` only) + `ViewerEventScreen` + reused Invitations inbox + UnlockPaywall-as-route + sign-out, with a per-calendar waiting hint until the owner wraps the CalendarKey; paywall remains client-side — the server instead enforces view-only WRITES via the /records calendar-lane 403 (calendar.md) (2026-07-31); chat billing now prices tokens PER TYPE — `tokenRatesPer1M` families became `{ input, output, cacheRead, cacheWrite }` $/1M objects at Anthropic's real prices (sonnet `{3, 15, 0.3, 3.75}`, haiku `{1, 5, 0.1, 1.25}`, default `{6, 30, 0.6, 7.5}`), `chatStream` sums each API call's usage per type (`credits.usageBreakdown`) and `recordChatCredits` debits from the breakdown, so cache reads bill at ~0.1× input instead of the retired blended rate that over-billed them ~33× (a heavy calendar turn drops from ~50–70 credits to single digits with identical behavior); `tokenCostMc` is polymorphic (breakdown object or legacy number) and honors a legacy blended NUMBER rate on every type so a stale cached config can never crash or misprice mid-deploy; `getSingleton` migrates numeric rate entries (known families → per-type defaults, unknown → number on all four types); admin PUT + editor validate/edit the per-type shape and reject bare numbers on write; `recordTokens` additionally accumulates per-type splits `usageTokens[period].byType.*`; `totalTokens` stays the display/analytics sum only (2026-07-31); Credits screen spend/history split — the "By feature this week" analytics card is repurposed into **"Where your credits go"**: it now reports credits SPENT per feature this week (biggest-first, with a "Spent this week" total) from a new `status.spend` map (server aggregates the caller's usage-debit ledger rows since the period start, action→credits, fractional for prorated calls), and the **History** card is filtered client-side to purchases & grants only (usage debits are summarized in the spend card, never itemized in History); the shared `Button` primitive gained an optional `style` override so the plan card's "Manage subscription" ghost button gets top spacing from the card copy; chat is now TOKEN-PRICED — a chat turn debits whole credits sized to its summed-token provider-cost AFTER Apple's cut plus a slight margin, ceiled (`credits.chatCreditsForTokens`; knobs `credits.appleFeePct` default 0.15 = App Store Small Business, `credits.chatMargin` clamped [1.0, 1.5] default 1.0 — the ceil is the margin, realized ~100–150%): `meter('chat')` still pre-checks + counts but no longer flat-debits (chat is the sole member of `credits.TOKEN_PRICED_ACTIONS`), `chatStream` debits once per turn via `recordChatCredits` (ledger action `chat`) and returns the charge as `done.creditsUsed`, the shared `ChatScreen` shows "N credit(s)" under each reply instead of tokens, and the rate card labels chat "Varies with length" (the nominal `actionCosts.chat` survives only for sort order, never debited); validation adds `appleFeePct` in [0,1) + `chatMargin` in [1.0,1.5], `getSingleton` backfills both; the per-search web-search charge (`actionCosts.webSearch`) is now REMOVED — web search runs inside a chat turn so its result tokens are already in the token-priced chat debit; `recordWebSearches` records count/cost for reconciliation only (never debits), `getSingleton` strips a stored `actionCosts.webSearch`, and the rate card drops the web-search row; the rate card now pins the token-priced **chat row FIRST** (flat rows ascending, per-minute call pinned last); the admin AI-credits editor gained editable `appleFeePct`/`chatMargin` (same validation bands) and **excludes `chat`** from the flat action-price grid (2026-07-30); [superseded] chat web search was briefly a flat-priced action — `actionCosts.webSearch` (default 3 credits) debits per search Anthropic's server-side `web_search` tool executes inside a chat turn (max 3/turn), ON TOP of the flat chat price, charged once per turn via `recordWebSearches` (ledger action `webSearch`, weekly `usageWebSearches` counter + raw `webSearchRatePerSearch` $0.01/search fee feeding the reconciliation endpoint's cost side), with a "Web search · N credits/search" rate-card row and "Web searches"/"Web search" usage/ledger labels (2026-07-30); account deletion × billing (new normative section) — deleting an account never cancels the Apple-billed Calen AI plan: when the plan is active the client interposes a keep-billing warning (with the Manage-subscription affordance) before the destructive confirm, the confirm names any forfeited credit balance, the account-deleted email repeats the cancel-in-Apple-settings reminder, deletion best-effort-purges the RevenueCat subscriber when `REVENUECAT_SECRET_API_KEY` is set, and a `TRANSFER` whose losing id no longer resolves (account deleted before Restore) now grants the unlock to the gaining user instead of silently stranding a paying customer behind the paywall (2026-07-30); `manualParse` now meters ONLY the manuals AI routes (auto-lookup + extract-tasks) — the plain manual upload and save-from-URL routes were incorrectly debiting the flat 40-credit price for zero-AI file storage (meter() removed from both), and the action's labels renamed "Import(s) & parsing" → "Owner's manual parsing" (2026-07-30); action labels renamed to match what's actually metered — `scan` is "Photo scan(s)" (items-from-photo + recipes-from-photo; receipts are plain E2EE attachments, never AI-scanned) and `generation` is "Recipe generation" (generate-from-description + suggest-recipes; nothing generates plans) across the price/usage/ledger labels, and the paywall + onboarding "scans receipts" bullets now say "scans photos" (2026-07-30); the "What things cost" card is now a rate card — rows sort by the server's live price ascending (ties alphabetical by label) with the per-minute call row pinned last, replacing the hard-coded display order (2026-07-30); Calen AI plan manage-subscription flow — client-derived three-state plan card (renewing / cancelled-but-active / inactive), native manage sheet + managementURL/App-Store fallback, refresh on focus & foreground (2026-07-30); the inactive plan card's value framing now asserts the advantage without a computed percentage — "N credits every month — more credits per dollar than any pack" (the catalog still drives whether the plan beats the packs) (2026-07-30); the Calen AI plan post-purchase poll (`useAiPlanActivation`) now completes only when the plan is active AND the balance has risen past the pre-purchase snapshot, not on `aiPlan.active` alone — the webhook flips `aiPlanActive` before it `$inc`s the balance, so gating on active alone could freeze a stale pre-credit balance in the cache until the next focus refetch (History updated but the balance didn't); `useAiPlanPurchase.buy()` now passes the pre-purchase `creditBalanceMc` to `activation.start()` (same balance-rise doctrine as the credit-pack poll) (2026-07-30); Credits History card is now BOUNDED — it renders at most `HISTORY_PREVIEW` (5) most-recent rows and, when more grants exist, a "See all history" drill-in to a new **CreditHistory** screen (month-grouped `SectionList`, pull-to-refresh, empty state); both the card and the screen share the `useCreditLedger` hook (query key `['billing','ledger']`) so "See all" opens from the warm cache, and the ledger fetch now passes `grants=1` — the server gained a `?grants=1` mode on `GET /credits/ledger` that filters `kind:'usage'` server-side and raises the window to 200 (the unfiltered default still returns usage rows, limit 50, for reconciliation), so a heavy AI user's grant history isn't pushed out of the window by usage-row volume; the client keeps a defensive usage filter; `LEDGER_LABEL`/`ledgerAmount` moved to `screens/plan/shared.ts` (shared by both surfaces); drive-by fix — `useAiPlanPurchase.restore()` now also passes the pre-restore balance to `activation.start(previousMc)` (it was calling the now-1-arg poll with none) (2026-07-31)
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
  - mobile/src/lib/__tests__/planState.test.ts
  - mobile/src/screens/plan/__tests__/CreditsScreen.test.tsx
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
4. **Feature-calendar add-ons** — one-time **household-wide** purchases (plus
   free opt-in claims), unchanged in spirit from the pre-credits era.

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
- **The shell is deliberately tiny:** the read-only shared-calendar agenda
  (`ViewerCalendarScreen` — only `mine:false` calendars and their events; the
  viewer's OWN household lanes stay behind the paywall, which also covers a
  refunded ex-payer's own data), a slim read-only event detail
  (`ViewerEventScreen`), the Invitations inbox (reused — accepting a calendar
  share needs no crypto), an **Unlock Calen** CTA pushing the same
  `UnlockPaywallScreen` as a route, and sign-out. Nothing else is reachable.
- **Waiting state:** a freshly accepted share has no CalendarKey wrapped to
  this device until the owner's next unlocked session
  (`reconcileCalendarKeys`); the shell shows a per-calendar "events appear once
  the owner opens Calen and confirms the share" hint until
  `ensureSharedCalendarKeys` can unwrap the member envelope.
- **Transitions are cache-driven both ways:** buying the unlock flips
  `unlocked` (activation poll) → full app; a refund flips it back → viewer
  shell (if shares remain) or paywall. Accepting/declining invitations
  refetches billing status so the signal stays truthful.
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
- An add-on unlocks **household-wide**: paid purchases resolve the purchasing
  user (`app_user_id` = user id) to their household; free claims land on the
  claimer's household. Ownership lives in `Household.addons` (calendar-id
  keys), granted/revoked ONLY by the webhook (`addonUpdateForEvent`,
  exported/tested), the claim route, or the admin override
  `POST /api/billing/addons`.
- The admin portal surfaces ownership read-only via the monetization list
  endpoints: `GET /api/monetization-config/households` carries each
  household's `addons`, and `GET …/users` mirrors the owning household's set
  onto every member row (a user "has" whatever their household owns; no
  household → empty set). Chip labels/paid-vs-free display metadata live in
  `admin/src/lib/addons.js`, mirroring the catalog defaults.
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
- Post-purchase, the client polls `GET /billing/status` until the owned set
  changes (`useAddonActivation`, same webhook-gap pattern as unlock
  activation); a timeout reassures ("payment received — unlocks shortly")
  rather than alarms. Free claims have no webhook gap: the claim response is
  authoritative and a single billing refetch re-mirrors the owned cache.
- The add-on catalog (labels, fallback prices, descriptions) lives in
  `MonetizationConfig.addons` and is served as `addonCatalog` for display.

### Billing surfaces (client)

- `screens/plan/`: **UnlockPaywallScreen** (the hard paywall),
  **CreditsScreen** (route `Credits`, title "AI credits"), **BuyCreditsSheet**
  (modal route `BuyCredits`, params `{ reason: 'low' | 'out' }`),
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
