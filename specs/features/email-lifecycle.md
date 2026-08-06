---
title: Email lifecycle, delivery tracking & reconciliation
status: current
last-verified: f6874e9+ (2026-08-05); e-card photos downscale to email size at send time (`emailSizedPhoto`, sharp: ≤1280px, EXIF-oriented, GIF/decode-failure passthrough) and attach as inline CID content buffers — full-res phone photos rendered as "Tap to Download" tiles in Apple Mail instead of inline card images (2026-08-05); `recipe_share` retired — recipe sharing is now device-composed via the OS share sheet (RecipeDetailScreen), so `POST /recipes/:id/share-email` + `sendRecipeShare`/`buildRecipeShare` were deleted, the catalog entry kept as `implemented:false` (preview 404s), the decrypted-recipe plaintext round-trip removed; occasion e-cards now CC the author (`sendMail`/`attemptSend`/outbox payload gained an optional `cc`, scheduler passes `ccEmail: author.email`) so the sender keeps a copy of a server-sent card (2026-08-01); `account_deleted` gains an active-subscription reminder — when the wiped account had `aiPlanActive`, the email states the Calen AI plan is Apple-billed, was NOT cancelled by the deletion, and points to Apple's subscription settings (`hadActiveAiPlan` flag from `services/accountDeletion.js`; the catalog sample previews the reminder variant) (2026-07-30); first cut — code-owned catalog + admin-editable overlay (enable/subject/note), EmailLog upgraded to a delivery ledger with a transient outbox, transient/permanent; `event_invitation` retired (2026-07-29) — event invite outreach is now device-composed like every other invite (server sends a push to account holders instead; `sendEventInvitation`/`buildEventInvitation` deleted from the mailer, catalog entry kept as `implemented:false` so historical logs resolve, admin preview 404s) failure classification with backoff retry + suppression, welcome + account-deleted bookend emails, admin catalog/preview/retry/cancel/reconcile/suppression surfaces
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
- **Sharing & invites** — nothing here is server-sent anymore. ALL sharing —
  household, **calendar**, **trip**, **event** (since 2026-07-29), and
  **recipe** (since 2026-08-01) — is **device-composed**: the sender's own
  mail/Messages app (or the OS share sheet) sends it, so no catalog mail leaves
  `no-reply@`; see [households-sharing](households-sharing.md) and
  [kitchen](kitchen.md). `other` covers the ongoing-access invites' historical
  logs. Both `event_invitation` and `recipe_share` remain in the catalog as
  `implemented: false` — retired, kept so historical `EmailLog` rows keyed by
  them keep resolving (admin preview 404s for both). `recipe_share` was
  server-sent to render styled HTML; that was retired in favour of the OS share
  sheet, which also removes the plaintext round-trip of the decrypted recipe
  (the client used to POST the recipe body in the clear to `/:id/share-email`).
- **Occasions** — `ecard` (scheduled; a deliberate plaintext exception, see
  [crypto-e2ee](../platform/crypto-e2ee.md)). Because it is server-sent on a
  future date (the app may be closed), the author has no Sent-folder copy the
  way a device-composed share does — so each e-card **CCs the author's own
  address** (`sendMail` accepts an optional `cc`, threaded to nodemailer and
  persisted in the outbox payload so a retried send keeps it; the scheduler
  passes `ccEmail: author.email`). It's the author's own address, so no new data
  is exposed beyond the existing e-card plaintext exception. Card photos are
  **downscaled at send time** (`emailSizedPhoto`, sharp: fit within 1280px,
  re-encoded, EXIF orientation baked in; GIFs untouched; decode failure falls
  back to the original bytes) and attached as `contentDisposition: 'inline'`
  CID content buffers — full-resolution phone photos made Apple Mail defer the
  card's inline images into "Tap to Download" tiles.
- **Account** — `account_deleted` (sent just before purge; when the account
  had an active Calen AI plan it carries the Apple-keeps-billing reminder —
  deletion can't cancel a store subscription, see
  [billing-plans](billing-plans.md) "Account deletion × billing");
  `deletion_scheduled`
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
