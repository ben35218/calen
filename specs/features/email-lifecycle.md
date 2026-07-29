---
title: Email lifecycle, delivery tracking & reconciliation
status: current
last-verified: 55bfc65+ (2026-07-29); first cut — code-owned catalog + admin-editable overlay (enable/subject/note), EmailLog upgraded to a delivery ledger with a transient outbox, transient/permanent failure classification with backoff retry + suppression, welcome + account-deleted bookend emails, admin catalog/preview/retry/cancel/reconcile/suppression surfaces
code:
  - server/src/services/emailCatalog.js
  - server/src/services/mailer.js
  - server/src/models/EmailLog.js
  - server/src/models/EmailLifecycleConfig.js
  - server/src/models/EmailSuppression.js
  - server/src/jobs/emailReconcile.js
  - server/src/routes/adminEmail.js
  - admin/src/views/EmailLifecycleView.vue
  - admin/src/views/EmailLogView.vue
tests:
  - server/src/test/emailLifecycle.integration.test.js
  - server/src/test/emailReconcile.test.js
---

# Email lifecycle, delivery tracking & reconciliation

## Purpose

One place to see and control every email Calen sends from
`no-reply@householdcalendar.com` across a user's life with the app — signup →
usage → deletion — and to make sure a send that a provider *blocked* isn't
silently lost. Admins view the catalog, toggle optional mail, override subjects,
watch delivery, and reconcile failures; the system heals transient/throttled
sends automatically and suppresses addresses that can't receive.

## The lifecycle (catalog)

The canonical set of templates lives in code (`services/emailCatalog.js`) — the
source of truth for keys, stages, and preview samples. Each `EmailLog.kind` MUST
be a catalog key. Templates by stage:

- **Onboarding** — `welcome` (on registration).
- **Security** (`required`, always on) — `password_reset`, `security_alert`.
- **Sharing & invites** — `event_invitation`, `recipe_share`. The ongoing-access
  invites — household, **calendar**, **trip** — are **device-composed** (the
  owner's own Mail/Messages app sends them; see
  [households-sharing](households-sharing.md)), so they have **no** catalog
  template; `other` covers their historical logs. `event_invitation` stays
  server-sent because it carries an `.ics` attachment the OS share sheet can't
  send, and `recipe_share` because it's fully rendered HTML content.
- **Occasions** — `ecard` (scheduled; a deliberate plaintext exception, see
  [crypto-e2ee](../platform/crypto-e2ee.md)).
- **Account** — `account_deleted` (sent just before purge); `deletion_scheduled`
  / `deletion_purged` are `implemented:false` placeholders for a future
  scheduled-purge lifecycle and are NOT sent today.

Billing receipts are Apple/RevenueCat-issued, not sent by Calen — deliberately
absent from the catalog.

## Behavior (normative)

### Editability boundary

- Template **bodies** are code-owned (tested, injection-safe via `esc()`); they
  are NOT editable from the console. Admins edit **metadata** only, stored in the
  `EmailLifecycleConfig` singleton overlay: per-template `enabled`,
  `subjectOverride`, `note`, plus the `retry` policy and `suppressionEnabled`.
- The admin MAY **preview** any implemented template rendered with its catalog
  sample data (`GET …/catalog/:key/preview`) — no send, no log.
- New catalog keys MUST appear enabled-by-default (the config backfills on read).

### Send gating (`services/mailer.sendMail`, keyed by `kind`)

In order, before delivery:
1. **Config gate** — if a template is `enabled:false` and NOT `required`, the
   send is skipped and logged `status:'canceled'`. `required` templates ignore
   the toggle.
2. **Suppression gate** — if the recipient is on the active suppression list and
   the template is NOT `required`, the send is skipped and logged
   `status:'suppressed'`. `required` security mail MUST bypass suppression so a
   bounced address never blocks account recovery.
3. **Subject override** — a non-empty `subjectOverride` replaces the built-in
   subject.
4. When SMTP is unconfigured every send is a logged **dry-run**
   (`status:'dry'`), never delivered.

`sendMail` MUST NOT throw — a failed notification must never break the flow it
accompanies.

### Delivery ledger + outbox (`EmailLog`)

Every attempt records one row. `status` is a state machine:
`sent | dry | canceled | suppressed | queued | failed`. On a delivery throw the
failure is classified:

- **transient** (SMTP 4xx — 421/450/451/452 throttle/greylist; temporary network
  errors) → the row is parked `queued` with `attempts`, a `nextAttemptAt`, and a
  transient `payload` (the outbox entry).
- **permanent** (SMTP 5xx; malformed envelope) → `failed`; a hard-bounce code
  (550/551/553/554) also **suppresses** the recipient (`reason:'hard_bounce'`).

The `payload` (from/text/html/attachments) exists ONLY while `queued` and MUST be
cleared on any terminal state — an ephemeral outbox, not retention. It is never
returned to the admin console (bodies stay out of the UI).

### Reconciliation (`jobs/emailReconcile.runEmailReconcile`)

Runs on cron (every 10 min) and on-demand from the console. For each `queued`
row that is due (`nextAttemptAt <= now`, bounded batch), it re-sends and resolves:

- success → `sent`, payload cleared.
- transient again → `attempts++`, `nextAttemptAt = now + backoff(attempts)`; on
  reaching `maxAttempts` → `failed`, payload cleared.
- permanent → `failed` (+ hard-bounce suppression), payload cleared.

`backoff(n) = min(baseMinutes · 2^(n-1), capMinutes)` from the `retry` policy.
"Automatic where possible": throttle/greylist heals on retry; what can't be
auto-resolved lands as `failed` for the admin.

### Admin actions (all `requireAdmin`, sensitive ones audited)

- Retry a `queued` row now, or cancel it (`→ canceled`). Only `queued` rows are
  retriable (a `failed` row has no payload; the API returns 409).
- Run the reconcile pass on demand (`email_reconcile_run`).
- Add/release suppressions (`email_suppressed` / `email_released`).
- Save the lifecycle config (`email_config_changed`, leaf-diff meta) — required
  templates cannot be disabled (server-validated).

## Data & API surface

- **Models:** `EmailLog` (delivery ledger + transient outbox `payload`;
  plaintext observability), `EmailLifecycleConfig` (singleton overlay),
  `EmailSuppression` (address-level, plaintext so the send path can query it).
  See [data-model](../platform/data-model.md).
- **Endpoints** (under `/api/admin/email`, `requireAdmin`): `GET /log`,
  `GET /log/stats`, `POST /log/:id/retry`, `POST /log/:id/cancel`,
  `POST /reconcile`, `GET /catalog`, `PUT /catalog`, `GET /catalog/:key/preview`,
  `GET /suppressions`, `POST /suppressions`, `DELETE /suppressions/:id`.
- **Triggers** (send sites, owned by their feature areas): `welcome` from
  `routes/auth.js` register; `account_deleted` from `services/accountDeletion.js`
  pre-purge; the rest unchanged from their existing routes/scheduler.
- **Admin console:** `EmailLifecycleView.vue` (the editable send map + retry
  policy + suppression list), `EmailLogView.vue` (delivery log + outbox actions).
  See [admin-portal](admin-portal.md).

## Encryption boundary

Recipient addresses, subjects, and `kind` are server-visible (routing +
observability), consistent with the existing EmailLog. Message **bodies** are not
stored except transiently in a `queued` row's `payload` for retry, cleared on
terminal state. Suppression addresses are stored in the clear (they must be
queryable on the send path) — the same address already on the EmailLog row, no
new exposure. E-cards remain the plaintext exception documented in
[crypto-e2ee](../platform/crypto-e2ee.md).

## Verification

- Config gate (disabled optional skipped → `canceled`; required always sends),
  suppression gate (non-required skipped → `suppressed`; required bypasses),
  subject override, welcome-on-register, deletion-confirmation-before-purge, and
  the catalog/preview/suppression endpoints + audit rows —
  `emailLifecycle.integration.test.js`.
- Failure classification (4xx transient / 5xx permanent / net codes), transient
  → `queued` with payload + `nextAttemptAt`, reconcile re-send → `sent` clears
  payload, backoff + `maxAttempts` exhaustion → `failed`, permanent → suppress —
  `emailReconcile.test.js`.

## Out of scope

- Provider **bounce/complaint webhooks** / inbound IMAP bounce parsing (async
  delivery truth). Permanence is inferred from synchronous SMTP response codes
  only. Future work.
- DB-editable email **bodies** (kept code-owned by decision).
- A real scheduled account-**purge** lifecycle — `deletion_scheduled` /
  `deletion_purged` stay `implemented:false` placeholders.

## Open questions

- Which SMTP/provider will eventually supply delivery/bounce webhooks (Migadu has
  none today)? That decides whether soft delivery states (`delivered`,
  `complained`) ever become real vs. inferred.
