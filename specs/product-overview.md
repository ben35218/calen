---
title: Product overview
status: current
last-verified: dad7c5a (2026-07-20)
code:
  - mobile/
  - server/
  - admin/
  - shared/
---

# Calen — product overview

Calen is a **household management app built around a shared family calendar and
an AI assistant**. A family (a "household") coordinates events, meals, home
maintenance, trips, and the people in their life, and can ask the assistant
("Calen") to help plan and even place phone calls on their behalf. All household
content is **end-to-end encrypted** — the servers store ciphertext they cannot
read.

> The root `README.md` still describes an earlier "inventory / product manuals"
> product and predates most of the app. Treat this file as the accurate
> overview until the README is rewritten.

## Clients & services

- **Mobile app (`mobile/`)** — Expo / React Native, TypeScript. The primary and
  only end-user client. Screens live under `mobile/src/screens/` by area
  (`calendar/`, `kitchen/`, `maintenance/`, `trips/`, `chat/`, `profile/`,
  `plan/`, `auth/`).
- **API (`server/`)** — Express + Mongoose. Routes in `server/src/routes/`,
  models in `server/src/models/`, background work in `server/src/jobs/`.
- **Admin web app (`admin/`)** — Vue 3 + Vuetify, for monetization/plan config
  and household/support views. Not an end-user surface.
- **Shared packages (`shared/`)** — `crypto` (the audited E2EE core), `calendar`
  (recurrence engine), `weather`, `seed` (task templates).

There is **no consumer web client** — an earlier Vue web app was removed in the
web→native migration. Docs that reference a `client/` directory are stale.

## Feature areas

Each has (or will have) a spec under `features/`:

- **Calendar** — events across built-in and custom calendars, recurrence,
  reminders/alerts, invitees (including people outside the household), holidays,
  weather overlay, printing. → [features/calendar.md](features/calendar.md)
- **Kitchen** — recipes, meal planner, grocery lists, cooking mode.
- **Maintenance** — home items, maintenance tasks, chores, templates, odometer.
- **Trips** — trips with legs/items, expense settling, and outside sharing.
- **Contacts** — household contacts, the self "You" card, AI-assisted
  contact import.
- **Households & sharing** — household model, invitations, join approval,
  membership, roles.
- **Auth & identity** — registration, login, passkeys, email-OTP, recovery
  codes, device linking.
- **AI assistant** — Calen's per-area chat surfaces, consent/data minimization,
  and outbound phone calls.
- **Billing & plans** — subscription plans (RevenueCat) and AI-usage metering.
- **Notifications** — Expo push + on-device local reminders.

## Cross-cutting foundations

- **End-to-end encryption** is mandatory for every household — records are
  born encrypted. See [platform/crypto-e2ee.md](platform/crypto-e2ee.md).
- Content is stored in a **unified opaque record store**: one server collection
  holding client-sealed records, pulled by an incremental last-writer-wins sync
  (`GET /records/sync`). See [platform/api-reference.md](platform/api-reference.md)
  and [platform/data-model.md](platform/data-model.md).
