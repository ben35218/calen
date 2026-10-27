# Calen

Calen is a **household management app built around a shared family calendar and
an AI assistant**. A household (a family) coordinates events, meals, home
maintenance, trips, and the people in their life, and can ask the assistant
("Calen") to help plan — and even place phone calls on their behalf. All
household content is **end-to-end encrypted**: the servers store ciphertext they
cannot read.

The product ships as a **native mobile app** (Expo / React Native, the primary
and only end-user client) backed by an **Express / MongoDB API**, plus a **Vue 3
admin web app** for monetization and support. There is no consumer web client.

> **Specs:** `specs/` is the source of truth for what the system does today —
> start with [`specs/product-overview.md`](specs/product-overview.md). This
> README is the setup/orientation entry point.

## Stack

- **Expo / React Native** (TypeScript) — native mobile app (`mobile/`)
- **Express.js + Mongoose / MongoDB** — REST API (`server/`)
- **Vue 3** (Composition API) + **Vuetify 3** + **Pinia** — admin web app (`admin/`)
- **libsodium** (`shared/crypto`) — the audited end-to-end-encryption core
- **Anthropic Claude** — the AI assistant; **Vapi** — outbound phone calls
- **node-cron** — scheduled jobs; **Nodemailer / SMTP** — invitation + auth email

## Features

- **Calendar** — events across built-in and custom calendars, recurrence,
  two-alert reminders, travel time, invitees (including people outside the
  household), holidays, weather overlay, printing.
- **Kitchen** — recipes, weekly meal planner, generated grocery lists, cooking mode.
- **Maintenance** — home items with manuals, recurring maintenance tasks and
  chores, a rural-home template library, odometer-based scheduling.
- **Trips** — trips with legs and itinerary items, expense settling, and sharing
  with people outside the household.
- **People & contacts** — household people directory, the shared "You" card,
  AI-assisted contact import; birthdays surface on the calendar.
- **Households & sharing** — invite members, approve-on-device join, member
  removal with automatic key rotation, safety-number verification.
- **AI assistant (Calen)** — per-area chat that reads only consented, minimized
  data, plus outbound phone calls (cancel/reschedule appointments).
- **Billing** — subscription plans via RevenueCat with AI-usage metering.

See per-feature specs under [`specs/features/`](specs/features/).

## Architecture at a glance

Household **content** (events, people, tasks, recipes, trips, …) is **sealed on
the device** and stored in a single **opaque record store** on the server, pulled
by an incremental last-writer-wins sync. The server holds ciphertext plus a small
set of plaintext scope fields it must act on (ownership, scheduling, sharing) and
can read no content. See [`specs/platform/api-reference.md`](specs/platform/api-reference.md),
[`specs/platform/data-model.md`](specs/platform/data-model.md), and the
cryptographic spec in [`docs/CRYPTO-SPEC.md`](docs/CRYPTO-SPEC.md). End-to-end
encryption is **mandatory** for every household.

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- An SMTP account (for invitation + auth email) and an Anthropic API key (for AI)

### 1. Clone & install

```bash
git clone <repo-url>
cd household-copilot
npm install                    # root
npm --prefix server install    # API
npm --prefix admin install     # admin web app
npm --prefix mobile install    # mobile app
```

### 2. Configure the server

```bash
cp server/.env.example server/.env   # then edit — see Environment Variables
```

### 3. Run in development

```bash
npm run dev                          # API server (port 3001)
npm --prefix admin run dev           # admin web app → http://localhost:5174
npm --prefix mobile start            # Expo (press i / a for iOS / Android)
```

Register an account in the mobile app — default categories and identity/E2EE
enrollment are set up on first registration.

> Native modules (push, in-app purchases, passkeys) require an Expo **dev build**
> or store build — they don't run in Expo Go. Use `npx expo run:ios` /
> `run:android` or EAS. See [`mobile/README.md`](mobile/README.md).

## Project Structure

```
/household-copilot
  /mobile      # Expo / React Native app (primary client)
    /src
      /screens        # by area: calendar, kitchen, maintenance, trips, chat, profile, plan, auth
      /navigation     # React Navigation config
      /store          # auth context
      /api, /lib      # API client + on-device libs (e2ee, recordStore, replica, notifications, …)
  /admin       # Vue 3 + Vuetify admin web app (monetization/support)
  /server      # Express REST API
    /src
      /models         # Mongoose schemas
      /routes         # Express routers (see specs/platform/api-reference.md)
      /services       # crypto/key mgmt, AI, email, recurrence, notifications
      /jobs           # node-cron scheduler
  /shared      # packages shared across clients + server
    /crypto           # audited E2EE core (libsodium) — see docs/CRYPTO-SPEC.md
    /calendar         # recurrence engine
    /weather          # client-side weather
    /seed             # rural-home task templates
  /specs       # source of truth for current behavior
  /docs        # crypto spec, transparency note, release runbook
```

## Environment Variables

Referenced by the server (`server/src/`). Not exhaustive — see the code:

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Yes | JWT signing secret / lifetime |
| `ANTHROPIC_API_KEY` | For AI | Claude API key for the assistant |
| `SMTP_URL` *or* `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` | For email | Invitation + auth-code delivery (Nodemailer). `MAIL_FROM` sets the sender |
| `EXPO_ACCESS_TOKEN` | For push | Expo push notifications (security alerts) |
| `AI_CALLS_ENABLED` | No | Assistant phone calls — `true` enables the `/api/calls` routes, the chat's call tools and the published call price. **Unset in production** (feature off). |
| `VAPI_API_KEY` / `VAPI_PHONE_NUMBER_ID` | For AI calls | Vapi outbound calling (inert unless `AI_CALLS_ENABLED=true`) |
| `REVENUECAT_WEBHOOK_SECRET` | For billing | Verifies `POST /api/billing/webhook` |
| `PASSKEY_RP_ID` / `PASSKEY_ORIGINS` | For passkeys | WebAuthn relying-party id + allowed origins |
| `GOOGLE_PLACES_API_KEY` / `BRAVE_SEARCH_KEY` | For places/search | Location autocomplete + web search |
| `E2EE_MIN_APP_VERSION` | No | Min client version gate for E2EE |
| `KEY_ROTATION_INTERVAL_DAYS` | No | Household key rotation cadence (default 90) |
| `CORS_ORIGINS` | Prod | Comma-separated allowed origins (admin app) |
| `UPLOAD_DIR` | No | Where uploaded files are stored (default `./uploads`) |
| `APP_URL` / `WEB_URL` / `APP_STORE_URL` / `PLAY_STORE_URL` | No | Links used in email/deep-links |

> **Notifications:** per-item reminders are delivered as **on-device local
> notifications** (reminder content is encrypted, so it can't be scheduled
> server-side); the server cron only guards against duplicates. Server→push is
> used for security alerts (member/key/device changes) via Expo. Gmail
> App-Password SMTP is no longer used — configure a generic SMTP account.

## Backups

- **MongoDB:** `mongodump --uri="$MONGODB_URI" --out=./backup/$(date +%F)` (or
  Atlas backups). Stored records are ciphertext.
- **Uploads:** back up `server/uploads/` (or your `UPLOAD_DIR`) — the only files
  not in the database. Attachments are encrypted per-file.

## Production Deployment

1. Set a strong `JWT_SECRET`, a real `MONGODB_URI`, and the service keys above.
2. Deploy the API via the Render Blueprint ([`render.yaml`](render.yaml),
   `rootDir: server`); set `CORS_ORIGINS` to the admin app's origin and point
   `UPLOAD_DIR` at a persistent volume.
3. Build the admin app (`npm --prefix admin run build`) → serve `admin/dist/`.
4. Build & ship the mobile app via EAS — see [`mobile/RELEASE.md`](mobile/RELEASE.md).
