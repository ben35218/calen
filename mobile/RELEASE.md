# Store Release (Phase 4)

Status of store-prep work for the Calen mobile app (`mobile/`).

## Already scaffolded (in the repo)

- **App identity:** name, slug, scheme, bundle id / package `app.householdcalendar.mobile` (`app.json`).
- **Icons & splash:** `assets/icon.png`, Android adaptive icon set, `assets/splash-icon.png` via `expo-splash-screen`.
- **Permissions / usage strings:** iOS camera + photo-library descriptions; Android `CAMERA`, `READ_MEDIA_IMAGES`, `POST_NOTIFICATIONS`.
- **iOS privacy manifest:** `ios.privacyManifests` in `app.json` — declares no tracking and the required-reason API categories used by Expo/SecureStore (UserDefaults `CA92.1`, file timestamp `C617.1`, system boot time `35F9.1`, disk space `E174.1`). RevenueCat ships its own manifest in its pod.
- **EAS config:** `eas.json` with `development` (dev client), `preview` (internal distribution), and `production` profiles; `appVersionSource: remote` + `autoIncrement` so EAS manages build numbers / version codes. iOS + Android `submit.production` profiles stubbed.
- **Client code is config-driven and degrades gracefully when external values are missing:**
  - Push: `lib/push.ts` reads `extra.eas.projectId` / `easConfig.projectId`; returns `null` (no crash) until a projectId exists.
  - Purchases: `lib/purchases.ts` reads `EXPO_PUBLIC_RC_*` keys (via `config.ts`); paywall shows a "not configured" state until keys exist.
  - API URL: `config.ts` resolves `EXPO_PUBLIC_API_URL` → `extra.apiBaseUrl` → `http://localhost:3001`.

## Needs YOUR accounts / credentials (blockers)

Each item below is external — provide the value, then drop it into the noted file/secret.

1. **Expo (EAS) account** — run `eas login` then `eas init` in `mobile/`. This writes `expo.extra.eas.projectId` + `owner` into `app.json`.
   - Unblocks: `eas build`, `eas submit`, **and push tokens** (`getExpoPushTokenAsync` needs the projectId).
   - Server side: set `EXPO_ACCESS_TOKEN` (optional) so `server/src/services/push.js` can call the Expo Push API.

2. **Apple Developer Program** ($99/yr) + **App Store Connect** app record for `app.householdcalendar.mobile`.
   - Fill `eas.json` → `submit.production.ios`: `appleId`, `ascAppId`, `appleTeamId` (or use an ASC API key).
   - Enables TestFlight + App Store submission.

3. **Google Play Console** ($25 one-time) + a Play service-account JSON.
   - Save the JSON as `mobile/play-service-account.json` (git-ignored) — referenced by `eas.json` → `submit.production.android`.
   - Enables the internal testing track + Play submission.

4. **RevenueCat** — create the project, add the App Store + Play apps, define entitlements **`app_unlock`** (the $4.99 one-time unlock), **`calen_ai`** (the monthly AI plan) and **`addon_meals` / `addon_maintenance` / `addon_trips`** (the bundle product attaches to all three), create the matching products in App Store Connect / Play Console (credit packs are consumables matched by product id, no entitlement), and the offerings `current`, `credits`, `addons`, `ai_plan`. The catalog is normative in [specs/features/billing-plans.md](../specs/features/billing-plans.md).
   - Public SDK keys → `eas.json` build env `EXPO_PUBLIC_RC_IOS_KEY` (set) / `EXPO_PUBLIC_RC_ANDROID_KEY` (empty until the Play app exists — a placeholder key would make purchases report "configured").
   - Configure the **webhook** → `POST {API}/api/billing/webhook`, shared secret → server env `REVENUECAT_WEBHOOK_SECRET` (handler already exists, Phase 0).

5. **Production API URL** — `eas.json` (`preview` + `production` env) points `EXPO_PUBLIC_API_URL` at the deployed HTTPS API (`https://household-calendar-api.onrender.com`). iOS ATS blocks plain HTTP, so production must be HTTPS. Add the app's origin to the server `CORS_ORIGINS` allowlist if needed (native requests have no Origin, so usually unaffected).

## Build / submit commands (once the above are set)

```bash
cd mobile
eas login
eas init                       # writes projectId/owner
eas build --profile preview --platform ios       # internal-distribution test build
eas build --profile production --platform all     # store binaries
eas submit --profile production --platform ios     # → TestFlight / App Store
eas submit --profile production --platform android # → Play internal track
```

## Pre-submit smoke test (per the plan's Verification)

Log in (token in SecureStore) → load a screen from the live API → perform a write → take a photo → item created → receive a push → complete a sandbox IAP and confirm the plan flips via the webhook → stream one SSE assistant response.
