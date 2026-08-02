// The email lifecycle catalog — the canonical, code-owned source of truth for
// every transactional email Calen sends from no-reply@householdcalendar.com.
// The admin "Email lifecycle" page reads this (merged with the admin-editable
// EmailLifecycleConfig overlay) to show the full send map; the mailer keys every
// EmailLog row by `kind`, which MUST be a catalog key here.
//
// What's editable vs. fixed (deliberate boundary — see specs/features/
// email-lifecycle.md): bodies stay in code (tested, injection-safe). Admins edit
// *metadata* — enable/disable optional templates, override the subject line, add
// a note — and preview the rendered template with the `sample` args below. They
// never edit HTML from the console.
//
//   required:    security/legal mail that MUST always send (disable is ignored,
//                suppression is bypassed) — a password reset can't be turned off.
//   implemented: false marks a template the product references but does not yet
//                send (the scheduled-purge lifecycle), so the map is honest
//                rather than silently listing dead keys.

// Lifecycle stages, in display order. Every catalog entry belongs to one.
const STAGES = [
  { key: 'onboarding', label: 'Onboarding',      blurb: 'Sent as someone joins Calen.' },
  { key: 'security',   label: 'Security',        blurb: 'Account-safety mail. Always on.' },
  { key: 'sharing',    label: 'Sharing & invites', blurb: 'Sent when a member shares something to an email address.' },
  { key: 'occasion',   label: 'Occasions',       blurb: 'Scheduled greeting cards.' },
  { key: 'account',    label: 'Account',         blurb: 'Sent around account deletion.' },
];

// Default retry policy for the delivery outbox (services/mailer.js enqueue +
// jobs/emailReconcile.js). Overridable per-deployment in EmailLifecycleConfig.
//   backoff(n) = baseMinutes * 2^(n-1), capped at capMinutes.
const DEFAULT_RETRY = { maxAttempts: 5, baseMinutes: 5, capMinutes: 240 };

const CATALOG = [
  {
    key: 'welcome',
    stage: 'onboarding',
    title: 'Welcome',
    trigger: 'A new account is registered (POST /auth/register).',
    audience: 'The new account holder.',
    required: false,
    implemented: true,
    description: 'A friendly hello with a nudge to get the app on every device.',
    sample: { user: { firstName: 'Alex', email: 'alex@example.com' } },
  },
  {
    key: 'password_reset',
    stage: 'security',
    title: 'Password reset code',
    trigger: 'A reset is requested (POST /auth/forgot).',
    audience: 'The account holder.',
    required: true,
    implemented: true,
    description: 'The 6-digit code to choose a new password. Always sends; never suppressed.',
    sample: { user: { firstName: 'Alex', email: 'alex@example.com' }, code: '481920' },
  },
  {
    key: 'security_alert',
    stage: 'security',
    title: 'New-device sign-in alert',
    trigger: 'Sign-in from an unfamiliar device, or a reset held from an unknown device.',
    audience: 'The account holder.',
    required: true,
    implemented: true,
    description: 'The out-of-band takeover signal (Signal-parity F3). Always sends.',
    sample: { user: { firstName: 'Alex' }, device: { deviceName: 'iPhone', platform: 'iOS' }, opts: {} },
  },
  {
    key: 'event_invitation',
    stage: 'sharing',
    title: 'Event invitation',
    trigger: 'Retired 2026-07-29 — no longer sent. Was: a cross-household event invite (POST /invitations).',
    audience: 'The invited email (member or outsider).',
    required: false,
    implemented: false,
    description:
      'RETIRED: event invite outreach is device-composed like the other sharing flows ' +
      '(account holders get a push + the in-app inbox; non-account emails are composed ' +
      'from the organizer’s own mail app with the public .ics link). Entry kept so ' +
      'historical EmailLog rows keep resolving.',
  },
  {
    key: 'recipe_share',
    stage: 'sharing',
    title: 'Recipe share',
    trigger: 'Retired 2026-08-01 — no longer sent. Was: a recipe shared by email (POST /recipes/:id/share-email).',
    audience: 'Any email address.',
    required: false,
    implemented: false,
    description:
      'RETIRED: recipe sharing is device-composed like the other sharing flows — the sender ' +
      'hands the full recipe (its content is already decrypted on-device) to the OS share sheet ' +
      'from RecipeDetailScreen, so the recipient’s address never touches the server and the ' +
      'decrypted recipe no longer round-trips through the mail path. Entry kept so historical ' +
      'EmailLog rows keep resolving.',
  },
  {
    key: 'ecard',
    stage: 'occasion',
    title: 'Occasion e-card',
    trigger: 'A scheduled e-card fires on the occasion date (jobs/scheduler.js).',
    audience: 'Recipients the author chose.',
    required: false,
    implemented: true,
    description: 'A styled greeting card. Deliberate plaintext exception to E2EE (see crypto-e2ee.md).',
    sample: {
      toEmail: 'sam@example.com', toName: 'Sam', fromName: 'Alex', kind: 'birthday',
      occasionLabel: 'Birthday', message: 'Hope your day is wonderful!', greeting: 'Happy Birthday', signoff: 'Love', signature: 'Alex',
    },
  },
  {
    key: 'account_deleted',
    stage: 'account',
    title: 'Account deleted confirmation',
    trigger: 'The account is permanently deleted (sent just before the purge).',
    audience: 'The departing account holder.',
    required: false,
    implemented: true,
    description: 'Confirms the account and its cloud data were removed (Apple 5.1.1(v)).',
    // hadActiveAiPlan previews the richest variant (the Apple-keeps-billing
    // subscription reminder appended when the account had an active plan).
    sample: { email: 'alex@example.com', firstName: 'Alex', hadActiveAiPlan: true },
  },

  // Referenced by the product but NOT yet wired — a real scheduled-purge
  // lifecycle doesn't exist (deletion is immediate today). Kept visible-but-
  // planned so the map doesn't imply mail that never leaves.
  {
    key: 'deletion_scheduled',
    stage: 'account',
    title: 'Cloud-copy deletion scheduled',
    trigger: 'Planned: a storage-mode change schedules a future cloud purge.',
    audience: 'The account holder.',
    required: false,
    implemented: false,
    description: 'Planned (Phase 6 storage-mode/purge lifecycle). Not sent today.',
    sample: null,
  },
  {
    key: 'deletion_purged',
    stage: 'account',
    title: 'Cloud copy purged',
    trigger: 'Planned: the scheduled cloud purge completed.',
    audience: 'The account holder.',
    required: false,
    implemented: false,
    description: 'Planned (Phase 6 storage-mode/purge lifecycle). Not sent today.',
    sample: null,
  },
];

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));
function byKey(key) {
  return BY_KEY.get(key) || null;
}

// Default per-template config the admin overlay starts from.
function defaultTemplateConfig() {
  const out = {};
  for (const e of CATALOG) {
    out[e.key] = { enabled: true, subjectOverride: '', note: '' };
  }
  return out;
}

module.exports = { CATALOG, STAGES, DEFAULT_RETRY, byKey, defaultTemplateConfig };
