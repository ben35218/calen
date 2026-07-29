---
title: Admin portal (web console)
status: current
last-verified: 55bfc65+ (2026-07-29); added the Email lifecycle view (editable send map + retry policy + suppression list) and upgraded the Email log to a delivery-outbox view (retry/cancel/reconcile) — behavior in email-lifecycle.md (2026-07-29)
code:
  - admin/
  - server/src/routes/admin.js
  - server/src/routes/adminHelpers.js
  - server/src/routes/adminAnalytics.js
  - server/src/routes/adminAnalyticsHelpers.js
  - server/src/routes/adminEmail.js
tests:
  - server/src/test/admin.integration.test.js
  - server/src/routes/adminHelpers.test.js
  - server/src/routes/adminAnalyticsHelpers.test.js
---

# Admin portal

A separate Vue 3 + Vuetify web app (`admin/`, dev port 5174) for operating the
product: analytics, monetization, billing overrides, user management, content
moderation, support email, encryption health, and the audit log. Monetization
*policy* (prices, credits, unlock) is specced in
[billing-plans](billing-plans.md); this spec owns the portal itself and the
admin-only server surfaces behind it.

## Principles (normative)

- **Content-blind by default.** Admin surfaces expose metadata only — counts,
  timestamps, versions, roles, key-enrollment state. Household content is E2EE
  and unreadable server-side. The two deliberate exceptions: content reports
  (the user chose to send us the flagged AI message) and the support mailbox
  (the user emailed us).
- **Sensitive actions are audited.** Role changes, unlock grants/revokes,
  credit adjustments, monetization-config saves, moderation triage, and every
  support-mailbox read/reply/move write an `AuditLog` row (who/when + minimal
  meta, never content). See the event list in `server/src/models/AuditLog.js`.
- **Destructive/sensitive actions are confirmed.** Granting/revoking the admin
  role and revoking an app unlock require an explicit confirm dialog; credit
  adjustments require a note; monetization-config saves show a leaf-level
  review diff before writing.

## Auth model

- Same JWT scheme as the consumer app; admin is `User.role === 'admin'`. Every
  admin route is gated by `requireAuth` + `requireAdmin` (403 for non-admins).
- The SPA re-verifies the role on every load (`auth.init`) and bounces
  non-admins; the token lives under a distinct localStorage key
  (`hc_admin_token`) with sliding-session refresh via `X-Refreshed-Token`.
- A 401 anywhere redirects to `/login?redirect=<current-url>` and login
  returns the admin to where they were.
- Self-demotion is blocked server-side; the UI also disables the toggle on the
  signed-in admin's own row.
- *Deferred:* a second factor (passkey/TOTP) for admin logins — tracked with
  Signal-parity Phase F (auth alignment).

## App shell

- Nav is grouped — Analytics (Insights, AI usage), Revenue (Monetization,
  Billing, Households), Support (Support inbox, Content reports), Operations
  (Users, Do-not-call, Email lifecycle, Email log, Audit log) — and doubles as a
  work queue: badge counts for
  unseen support mail and open content reports refresh on a slow poll (~2 min;
  best-effort, failures silent).
- The app bar shows an environment chip (`VITE_ENV_LABEL`, defaulting to
  PRODUCTION in prod builds / DEV otherwise) so prod is never edited by
  accident.
- View state is deep-linkable: search text, filters, page, active tab,
  selected mailbox, and the expanded household sync to URL query params
  (`router.replace`, no history spam). Cross-view links rely on this
  (user email in Users/AI-usage → `/billing?q=<email>`, Billing → AI usage).
- Shared plumbing: `usePagedList` (pagination + debounced search + query
  sync + error snackbar) for the server-paginated lists; `<Timestamp>`
  (relative time, absolute on hover); `<ConfirmDialog>`; `downloadCsv` (Users,
  Billing, Audit exports; paged exports cap at 2 000 rows).
- Every data load surfaces failures via the shared snackbar — no silent blank
  states. All row/surface tints use theme-aware colors (the app ships dark by
  default).

## Views ↔ server surfaces

| View | Endpoints (all `requireAdmin`) | Notes |
| --- | --- | --- |
| Insights | `GET /api/admin/analytics/{overview,growth,platforms,usage,activity,retention}` | Tabs lazy-load once; the weeks toggle marks dependent tabs stale so they refetch. |
| AI usage | `GET /api/admin/analytics/tokens` | Per-user tokens/credits/flags; flagged rows tinted + floated to top. |
| Monetization | `GET/PUT /api/monetization-config` | Dirty-state tracking, client+server validation, review-diff confirm, unsaved-changes leave guards. Behavior of the values: [billing-plans](billing-plans.md). |
| Billing | `GET /api/monetization-config/users`, `POST …/unlock`, `POST …/credits` | Revoke-unlock confirmed (warns when RevenueCat-linked); credit adjustments require a note. Each row shows the user's household-owned add-ons as chips (paid tinted, free neutral; labels from `admin/src/lib/addons.js`) — searchable by add-on name/key, counted in the "With add-ons" stat, and included in the CSV export. Read-only here: add-ons are granted by the RevenueCat webhook / claim route ([billing-plans](billing-plans.md)). |
| Households | `GET /api/monetization-config/households` + `GET /api/admin/e2ee` (joined client-side), `GET /api/admin/e2ee/:id`, `POST /api/admin/e2ee/:id/nudge` | Identity, member roster (per-user role/unlock/credits, linking to Billing / AI usage), the household's owned add-ons (chips, searchable — ownership is household-wide), and per-member encryption health. Household `name` is E2EE content since Signal-parity C2 — encrypted households display as "\<owner email\>'s household" + short id. NO AI-usage data here: usage/calls/credits are per-user (household counters retired). The standalone E2EE-ops page was retired when E2EE became mandatory (born-encrypted); `/e2ee` redirects here. |
| Users | `GET /api/admin/users`, `POST /api/admin/users/:id/role` | Role toggle always confirmed; CSV export. |
| Support inbox | `GET/POST /api/admin/email/support/*` | Live IMAP; untrusted HTML renders only in a fully sandboxed iframe. |
| Content reports | `GET /api/admin/moderation`, `POST /api/admin/moderation/:id/status` | Apple 1.2 triage; status changes audited. |
| Email lifecycle | `GET/PUT /api/admin/email/catalog`, `GET …/catalog/:key/preview`, `GET/POST/DELETE …/suppressions` | The full send map (grouped by lifecycle stage), editable metadata (enable/subject/note per template, retry policy, suppression toggle) with review-diff confirm + unsaved-changes guard; template preview (sandboxed iframe); the suppression list (add/release). Bodies are code-owned — not editable here. Behavior: [email-lifecycle](email-lifecycle.md). |
| Email log | `GET /api/admin/email/log`, `…/log/stats`, `POST …/log/:id/{retry,cancel}`, `POST …/reconcile` | Outbound no-reply@ delivery ledger + outbox; bodies never stored. Per-row retry/cancel on queued sends, suppress-recipient on failures, "Reconcile now", header stat chips. Behavior: [email-lifecycle](email-lifecycle.md). |
| Audit log | `GET /api/admin/audit` | Filterable by event; CSV export; includes the admin-action events above. |
