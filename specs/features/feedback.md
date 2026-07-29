---
title: In-app feedback (questions, bugs, ideas)
status: current
last-verified: f8e4627+ (2026-07-29)   # new feature
code:
  - mobile/src/screens/profile/HelpFeedbackScreen.tsx
  - mobile/src/lib/diagnostics.ts
  - server/src/routes/feedback.js
  - server/src/models/Feedback.js
  - admin/src/views/FeedbackView.vue        # triage queue
tests:
  - server/src/test/feedback.integration.test.js
---

# In-app feedback (questions, bugs, ideas)

## Purpose

Let a signed-in user ask a question, report a bug, or suggest an idea from
inside the app (Profile → "Help & feedback") without leaving for email or
GitHub. Each submission lands in a durable queue an admin triages in the admin
portal. This replaces "there is no in-app channel" — the only prior report path
was the AI content-moderation long-press (see [ai-assistant.md](ai-assistant.md))
and the external GitHub issue form for TestFlight testers.

## Behavior (normative)

- The screen is reachable from the Profile hub under a **Help & support** group.
  Any authenticated user MAY submit; there is no separate entitlement gate.
- A submission has a **type** (`question` | `bug` | `idea`, default `question`),
  a free-text **message**, an optional **reply-to email**, and auto-captured
  **diagnostics**.
- The **message is required**; submitting an empty/whitespace-only message MUST
  be rejected (client disables submit; server returns `400`). All other fields
  are optional.
- The reply-to email defaults to the account email but the user MAY edit or
  clear it — it is a contact hint, not the identity (the row already carries
  `userId`).
- **Diagnostics are captured automatically** and shown to the user before they
  send (transparency): app version + build, platform, OS version, device model,
  the route the user came from, and locale. The user does not type these — they
  make a report actionable without a round-trip. Diagnostics MUST NOT include
  household content, secrets, or precise location.
- Submission is **rate-limited** (20 / 15 min / user); over the limit returns
  `429`. A failed submit surfaces an inline error and does not lose the draft.
- Leaving the screen with an unsent message (or a changed type/reply-to) prompts
  an Apple-style discard confirm (the shared unsaved-changes guard); a successful
  send leaves without prompting.
- On success the screen confirms and returns to the hub.
- An admin sees submissions newest-first in the portal **Feedback** view,
  filterable by status, and triages each: `new → triaged → resolved` (and back).
  A status change is **audited** (`feedback_status_changed`). A nav badge counts
  `new` items.

## Data & API surface

- **Model:** `Feedback` (plaintext, server-visible by design) — `userId`,
  `householdId?`, `type`, `message` (≤4000), `contactEmail?`, `diagnostics`
  (appVersion, buildNumber, platform, osVersion, deviceModel, route, locale),
  `status` (`new`|`triaged`|`resolved`, indexed), timestamps.
- **Endpoints:**
  - `POST /api/feedback` (requireAuth, rate-limited) — create. Body: `{ type,
    message, contactEmail?, diagnostics? }`. Trims + caps every field; coerces
    an unknown `type` to `question`.
  - `GET /api/admin/feedback?status=&page=&pageSize=` (requireAdmin) — paginated,
    newest-first, with `newCount` for the badge and the reporter's email
    resolved for follow-up.
  - `POST /api/admin/feedback/:id/status` (requireAdmin) — set status, audited.
- **Client:** `HelpFeedbackScreen` (mobile) posts via `feedbackApi.submit`;
  `lib/diagnostics.ts` collects the device/app context. Admin `FeedbackView.vue`
  drives the triage queue via `adminApi.feedback` / `setFeedbackStatus`.

## Encryption boundary

Feedback is a **deliberate plaintext exception** to the E2EE mandate, in the
same spirit as content-moderation reports and occasion e-cards: it is support
content the operator must be able to read to act on it, and the user chose to
send it to us. The client therefore does **not** seal it. To keep the exception
narrow, diagnostics are limited to non-sensitive device/app context and MUST NOT
carry household content or secrets. Cross-link
[platform/crypto-e2ee.md](../platform/crypto-e2ee.md) (plaintext exceptions) and
[ai-assistant.md](ai-assistant.md) (the moderation-report sibling).

## Verification

- `POST /feedback` creates a row scoped to the caller, requires a non-empty
  message (`400` otherwise), caps/coerces type + fields, and is rate-limited —
  `feedback.integration.test.js`.
- Admin list is admin-only, paginated newest-first, filterable by status, and
  resolves reporter email; the status transition is admin-only and writes a
  `feedback_status_changed` audit entry — `feedback.integration.test.js`.

## Out of scope

- Email/Slack fan-out on new feedback (chosen: admin-portal queue only). The
  model + route make adding a best-effort notify later a one-liner, mirroring
  `moderation.js`.
- Screenshot/video attachments (a likely v2; the GitHub tester form still covers
  rich repros — [.github/ISSUE_TEMPLATE/beta-bug.yml](../../.github/ISSUE_TEMPLATE/beta-bug.yml)).
- Threaded replies back to the user in-app (today follow-up is via the reply-to
  email through the existing support inbox).

## Open questions

- Should `resolved` feedback auto-archive after N days to keep the queue lean?
- Do we want an in-app "your reports" history for the user, or is fire-and-forget
  enough for the beta?
