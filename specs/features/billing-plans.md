---
title: Billing — app unlock, AI credits & add-ons
status: current
last-verified: 0d94240+ (2026-07-29); Add-ons cards offer one-tap restore for an owned but locally-deleted calendar (2026-07-29)
code:
  - mobile/src/screens/plan/
  - mobile/src/lib/purchases.ts
  - mobile/src/lib/addons.ts
  - mobile/src/lib/unlock.ts
  - mobile/src/hooks/useBilling.ts
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
  - mobile/src/screens/plan/__tests__/shared.test.ts
  - mobile/src/screens/plan/__tests__/packStore.test.ts
  - mobile/src/screens/plan/__tests__/AddOnsScreen.test.tsx
---

# Billing — app unlock, AI credits & add-ons

## Purpose

There are no subscriptions. Monetization is three one-shot mechanisms, all via
RevenueCat / native in-app purchase:

1. **The app unlock** — a $4.99 one-time non-consumable, **per user**, behind a
   hard paywall.
2. **Prepaid AI credits** — consumable packs funding a **per-user balance**
   that both AI usage and assistant phone calls draw down, sold at a 100%
   margin over raw cost.
3. **Feature-calendar add-ons** — one-time **household-wide** purchases (plus
   free opt-in claims), unchanged in spirit from the pre-credits era.

The admin app configures the whole economy centrally (`MonetizationConfig`).
Config saves are validated server-side (positive margin, non-negative
rates/prices, integer pack credits → 400 on violation) and audited as
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
  1. **Credits** — matched by *product id* against the pack catalog
     (consumables carry no entitlement); never falls through.
  2. **Unlock** — matched by the `app_unlock` entitlement (product-id
     fallback).
  3. **Add-ons** — matched by `addon_*` entitlements; applied to the user's
     household.
  Anything left over — including legacy subscription-era `premium`/`unlimited`
  events and their lifecycle tails — is **acked as ignored** so RC never
  retries. Unknown users are acked (`matched: false`). `TRANSFER` (Restore
  under a different account) is handled before the partition: it moves the
  unlock flag from the losing user to the gaining one (consumed credits and
  household add-ons stay where they were applied).

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

### Prepaid AI credits

- **Unit:** 1 credit = $0.01 of retail value. Balances live on
  `User.creditBalanceMc` in integer **millicredits** (1 credit = 1000 Mc) so
  tiny per-call debits never need float `$inc`s. UI shows whole credits
  (floored), and floors display at 0.
- **Debit math (100% margin):** usage debits raw cost × `credits.margin`
  (default 2.0), always **ceiled at the millicredit** (float-noise guarded):
  - tokens: `ceil(tokens × tokenRatesPer1M[family] × margin / 10)` Mc, model
    family matched by substring (`haiku`/`sonnet`, else `default`); recorded by
    `recordTokens` (the patched Anthropic client / `chatStream`), which now
    threads the **model id** through.
  - calls: `ceil(seconds × callRatePerMinute × margin × 100000 / 60)` Mc,
    debited once when Vapi reports the finished call
    (`recordCallSecondsById`; `PhoneCall.metered` guards re-charging).
- **Enforcement** (`middleware/usageMeter.js`): `meter(action)` pre-checks
  `creditBalanceMc > 0` → **402 `CREDITS_EXHAUSTED`** (payload: `action`,
  `balance`, `packs` hint) when spent. A call's cost is known only after it
  runs, so the last call may overdraw slightly (balance can dip negative) and
  the NEXT call is blocked. Placing a phone call pre-checks **one minute** of
  call cost (`meterCallSeconds` on the call routes; the chat `call_business`
  tool pre-checks inline) — calls can't stop mid-sentence at zero. Weekly
  windows survive as ANALYTICS only (the "By feature this week" card and admin
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
  `starter` / `refund` / `admin`; the unique sparse `transactionId` index is
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
  negative), low/out badges, the **pack store** (hidden for unlimited
  admins), the **"By feature this week"** analytics card (per-user counts +
  the weekly-window caption), the **History** card
  (`GET /billing/credits/ledger` — grants only; usage isn't itemized), and
  the Terms/Privacy links. The AI on/off and
  personal/contact-info toggles are **not** here — they're privacy choices, so
  they live on `PrivacyDataScreen` (Profile → Privacy & data); see
  [ai-assistant.md](ai-assistant.md).
- **BuyCreditsSheet** is the focused conversion surface: the pack store + one
  job. Opened by the low-balance nudges with `reason` driving the copy.
- **CreditsBanner** (inside the AI assistants, replaces the 80%-of-quota
  banner) renders when the server says `lowBalance` — nothing for unlimited
  admins or healthy balances. It informs; it never blocks.
  **QuotaBlockedNotice** is the wall itself: rendered on a 402, CTA "Buy
  credits" → `BuyCredits { reason: 'out' }`.
- **ProfileHome** shows an "AI credits" card — balance + low/out badge —
  drilling into `Credits`. The old mini-gauges/subscription cards are gone.
- Purchase hooks (`screens/plan/shared.ts`): `useUnlockPurchase`,
  `useCreditsPurchase`, `useAddonPurchase` — RC identity, offering load,
  catalog↔package pairing (`unlockPackage`, `packForRcPackage`,
  `addonForPackage` — none may cross-claim another product class), buy →
  activation poll (`useUnlockActivation` / `useCreditsActivation` /
  `useAddonActivation`), restore.

### Monetization config & admin app

- `MonetizationConfig` (a single doc) holds `credits` (margin,
  `tokenRatesPer1M`, `callRatePerMinute`, `starterCredits`,
  `lowBalanceThreshold`, `packs`), `unlock` (price, productId), `costs`
  (reference only), `models`, `addons`, `guards` (`mapsPerDay`), `admin`.
  The subscription-era `tiers`/`activity`/`fees` sections are stripped by
  `getSingleton` (which also backfills new sections and force-syncs catalog
  items DEFAULTS declares free, so a stale paid price can't block a claim).
  Edited only through the admin app via `/api/monetization-config`
  (`requireAdmin`).
- Admin **Billing** view lists per-user state (`GET /monetization-config/users`:
  unlocked chip, credit balance — negative highlighted — RC id,
  revenuecat-vs-manual source) with Grant/revoke-unlock and Adjust-credits
  actions. **Households** view is analytics-only (plan column/override gone).
  **AI usage** view shows per-user tokens/trend/call-time + credit balance
  (tier limit columns gone); the fleet cards and hammering/spike abuse flags
  stay. Insights counts **unlocked users** instead of paid households.

## Data & API surface

- **Models:** `User` — `revenueCatId`, `appUnlocked(+At)`, `unlockProductId`,
  `creditBalanceMc`, usage analytics counters. `CreditLedger` — grants only,
  unique sparse `transactionId`. `Household` — `addons` + fleet analytics
  counters (all `plan*`/baseline fields deleted). `MonetizationConfig` as
  above.
- **Endpoints:** `billing.js` — `POST /webhook`, `GET /status`
  (`{ unlocked, unlockPrice, creditBalance(+Mc), lowBalance, unlimited, packs,
  usage, usageScope:'user', resetsAt, hasHousehold, models, addons,
  addonCatalog }`), `GET /credits/ledger`, `POST /addons/claim`,
  `POST /addons` (admin). `monetizationConfig.js` — config CRUD,
  `GET /households`, `GET /users`, `POST /unlock`, `POST /credits`.
  `/api/admin/analytics` (per-user rows now carry `creditBalance`, no tier
  limits; overview totals `unlockedUsers`).
- **Client:** `screens/plan/*`, `lib/purchases.ts` (user-id identity),
  `lib/addons.ts`, `lib/unlock.ts`, `hooks/useBilling.ts`; admin app.
- **Config:** `REVENUECAT_WEBHOOK_SECRET`; `EXPO_PUBLIC_RC_IOS_KEY` /
  `EXPO_PUBLIC_RC_ANDROID_KEY` (build env).

## Encryption boundary

Unlock state, credit balances and AI-usage counts are server-visible by
necessity (counts and money only, never prompt content). See
[operations/transparency.md](../operations/transparency.md).

## Verification

- Webhook: secret verification; unlock grant/refund-revoke; pack credit +
  **same-transaction-id dedupe**; refund → negative balance + independent
  refund dedupe; TRANSFER moving the unlock; legacy tier events acked;
  unknown-user ack; status payload (unlock/balance/low/packs); ledger
  endpoint; starter-grant idempotency — `billingWebhook.integration.test.js`.
- Pure event mapping (`unlockUpdateForEvent` / `creditUpdateForEvent` /
  `addonUpdateForEvent` — no cross-claims) — `routes/billing.test.js`.
- Credit math (family rates, ceil-at-millicredit incl. float-noise guard, pack
  lookup, packsHint) — `services/credits.test.js`.
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
  cross-claims) — `screens/plan/__tests__/shared.test.ts`.
- The store purchase path (`react-native-purchases`) is exercised on-device
  only (sandbox).

## Open questions

- Tune `tokenRatesPer1M` / `callRatePerMinute` against real Anthropic/Vapi
  spend once metering has run for a few weeks — the formula is fixed, the
  rates are the knob.
- Restore on a shared Apple ID transfers the unlock between accounts (RC
  transfer behavior). Accepted v1; revisit if support tickets appear.
- Add-ons belong to the household: a user who moves households loses them
  there until Restore Purchases re-grants to the new household. Acceptable v1.
