const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const EmailLog = require('../models/EmailLog');
const EmailSuppression = require('../models/EmailSuppression');
const EmailLifecycleConfig = require('../models/EmailLifecycleConfig');
const { byKey: catalogByKey, DEFAULT_RETRY } = require('./emailCatalog');
const { renderECard, GALLERY: ECARD_TEMPLATES } = require('./ecardTemplates');

// Outbound transactional email. The full lifecycle (which emails exist, when
// they send, how failures are reconciled) is specced in
// specs/features/email-lifecycle.md; the code-owned catalog of templates is
// services/emailCatalog.js. Every send is gated by the admin-editable
// EmailLifecycleConfig (enable/subject overrides + suppression), classified on
// failure, and recorded in EmailLog — provider-blocked/transient failures are
// parked in an outbox and retried by jobs/emailReconcile.js.
//
// Config is env-driven and OPTIONAL. When SMTP isn't configured, every send is a
// no-op that logs what it *would* have sent (mirroring push.js's guarded model),
// so the lifecycle is structurally complete and testable without live SMTP. Set
// SMTP_URL (e.g. smtps://user:pass@smtp.host:465) or SMTP_HOST/SMTP_PORT/
// SMTP_USER/SMTP_PASS, plus MAIL_FROM, to enable real delivery.

const SMTP_URL  = process.env.SMTP_URL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'Calen <no-reply@householdcalendar.com>';

// App-download links for email CTAs. Store URLs stay unset until the listings
// exist (Phase 4); until then invitation emails fall back to the website link.
const APP_STORE_URL  = process.env.APP_STORE_URL;
const PLAY_STORE_URL = process.env.PLAY_STORE_URL;
const WEB_URL        = process.env.WEB_URL || 'https://householdcalendar.com';

let transport = null;
if (SMTP_URL) {
  transport = nodemailer.createTransport(SMTP_URL);
} else if (SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT || 587,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
} else {
  console.warn('[mailer] SMTP not configured — emails will be logged, not sent');
}

function isConfigured() {
  return !!transport;
}

// ── Delivery config (admin-editable overlay), cached ─────────────────────────
// A short cache keeps the hot send path from hitting Mongo on every email; the
// admin PUT invalidates it. Returns null when Mongo isn't connected (scripts /
// some tests) so callers fall back to "send everything, no suppression".
let _cfgCache = null;
let _cfgAt = 0;
async function getEmailConfig() {
  if (mongoose.connection.readyState !== 1) return null;
  const now = Date.now();
  if (_cfgCache && now - _cfgAt < 60_000) return _cfgCache;
  const doc = await EmailLifecycleConfig.getSingleton();
  _cfgCache = {
    templates: doc.templates || {},
    retry: doc.retry || DEFAULT_RETRY,
    suppressionEnabled: doc.suppressionEnabled !== false,
  };
  _cfgAt = now;
  return _cfgCache;
}
function invalidateEmailConfigCache() {
  _cfgCache = null;
  _cfgAt = 0;
}

// ── Failure classification & backoff ─────────────────────────────────────────
// transient  → retry via the outbox (provider throttle/greylist, temp network).
// permanent  → give up now (bad address, hard bounce); may also suppress.
const TRANSIENT_NET = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EDNS', 'EAI_AGAIN', 'ETLS']);
const PERMANENT_NET = new Set(['EENVELOPE', 'EMESSAGE']); // malformed envelope/message → won't fix itself
const HARD_BOUNCE_CODES = new Set([550, 551, 553, 554]); // address invalid → suppress the recipient

function classifyFailure(err) {
  const code = Number(err && err.responseCode);
  if (code >= 500 && code < 600) return 'permanent'; // 5xx: rejected for good
  if (code >= 400 && code < 500) return 'transient'; // 4xx: 421/450/451/452 throttle/greylist/try-later
  if (err && err.code && PERMANENT_NET.has(err.code)) return 'permanent';
  if (err && err.code && TRANSIENT_NET.has(err.code)) return 'transient';
  return 'transient'; // unknown → prefer a capped retry over a silent drop
}

function isHardBounce(responseCode) {
  return HARD_BOUNCE_CODES.has(Number(responseCode));
}

// Minutes to wait before attempt n+1 (n = attempts made so far). Exponential,
// capped: baseMinutes * 2^(n-1), clamped to capMinutes.
function backoffMinutes(attempts, retry = DEFAULT_RETRY) {
  const base = retry.baseMinutes || DEFAULT_RETRY.baseMinutes;
  const cap = retry.capMinutes || DEFAULT_RETRY.capMinutes;
  return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), cap);
}

// Record an outcome in EmailLog. Best-effort: skipped when Mongo isn't connected,
// and a write failure never surfaces to the caller. Awaited so tests and the
// admin console see the row deterministically after a send resolves.
async function logSend({ to, subject, kind, status, error, attempts, responseCode, failureKind, lastError, nextAttemptAt, payload }) {
  if (mongoose.connection.readyState !== 1) return null;
  // C5 (log minimization): never persist a secret through the subject line —
  // the reset-code email embeds the 6-digit code there, which would land the
  // code in EmailLog in plaintext, bypassing its bcrypt hash. Mask digit runs.
  const safeSubject = String(subject || '').replace(/\d{4,}/g, '••••');
  try {
    return await EmailLog.create({
      to, subject: safeSubject, kind: kind || 'other', status, error,
      attempts: attempts || 1, responseCode, failureKind: failureKind || null,
      lastError, nextAttemptAt, payload,
    });
  } catch (err) {
    console.error('[mailer] EmailLog write failed:', err.message);
    return null;
  }
}

// Raw single delivery attempt — the shared primitive used by sendMail's first
// attempt and jobs/emailReconcile.js's retries. Resolves to {ok:true} or
// {ok:false, err}. Never throws.
async function attemptSend({ from, to, subject, text, html, attachments }) {
  try {
    await transport.sendMail({ from: from || MAIL_FROM, to, subject, text, html, attachments });
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

// Send an email through the full lifecycle: config gate → suppression gate →
// subject override → deliver → classify. No-ops (with a log) when SMTP is
// unconfigured, so callers never need to branch. Never throws — a failed
// notification must not break the flow it accompanies. `kind` is a catalog key
// (services/emailCatalog.js) and tags the EmailLog row.
async function sendMail({ to, subject, text, html, attachments, kind }) {
  if (!to) return { sent: false };
  const entry = catalogByKey(kind);
  const required = !!(entry && entry.required);

  let cfg = null;
  try { cfg = await getEmailConfig(); } catch { /* fall back to send-all */ }
  const tmpl = cfg && cfg.templates ? cfg.templates[kind] : null;

  // 1. Config gate — an admin can disable any non-required template.
  if (!required && tmpl && tmpl.enabled === false) {
    await logSend({ to, subject, kind, status: 'canceled', error: 'template disabled by admin' });
    return { sent: false, skipped: true };
  }

  // 2. Suppression gate — never mail a bounced/complained address (except
  //    required security mail, which must always reach the account holder).
  if (!required && (!cfg || cfg.suppressionEnabled)) {
    let suppressed = false;
    try { suppressed = await EmailSuppression.isSuppressed(to); } catch { /* treat as not suppressed */ }
    if (suppressed) {
      await logSend({ to, subject, kind, status: 'suppressed', error: 'recipient on suppression list' });
      return { sent: false, suppressed: true };
    }
  }

  // 3. Subject override.
  const finalSubject = (tmpl && tmpl.subjectOverride && tmpl.subjectOverride.trim()) || subject;

  // 4. Dry-run when SMTP is unconfigured.
  if (!transport) {
    console.log(`[mailer] (dry) → ${to}: ${finalSubject}`);
    await logSend({ to, subject: finalSubject, kind, status: 'dry' });
    return { sent: false, dryRun: true };
  }

  // 5. Deliver + classify.
  const { ok, err } = await attemptSend({ to, subject: finalSubject, text, html, attachments });
  if (ok) {
    await logSend({ to, subject: finalSubject, kind, status: 'sent' });
    return { sent: true };
  }
  console.error(`[mailer] send to ${to} failed:`, err.message);
  const failureKind = classifyFailure(err);
  const responseCode = Number(err.responseCode) || undefined;

  if (failureKind === 'permanent') {
    if (isHardBounce(responseCode)) {
      try { await EmailSuppression.suppress({ email: to, reason: 'hard_bounce', source: 'delivery' }); } catch { /* best-effort */ }
    }
    await logSend({ to, subject: finalSubject, kind, status: 'failed', error: err.message, lastError: err.message, failureKind, responseCode, attempts: 1 });
    return { sent: false, error: err.message };
  }

  // Transient / provider-blocked → park in the outbox for a backed-off retry.
  const retry = (cfg && cfg.retry) || DEFAULT_RETRY;
  const nextAttemptAt = new Date(Date.now() + backoffMinutes(1, retry) * 60_000);
  await logSend({
    to, subject: finalSubject, kind, status: 'queued', error: err.message, lastError: err.message,
    failureKind, responseCode, attempts: 1, nextAttemptAt,
    payload: { from: MAIL_FROM, text, html, attachments },
  });
  return { sent: false, error: err.message, queued: true };
}

// Human date for email copy, e.g. "July 13, 2026".
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── HTML layout ──────────────────────────────────────────────────────────────
// Every template sends both `text` and `html`. Inline styles only — most email
// clients strip <style> blocks. Brand blue matches mobile/src/theme.ts primary.

const BRAND = '#4F9DF5';

// User-supplied strings (event titles, names, locations) go through here
// before landing in HTML.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlLayout(contentHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="background:${BRAND};padding:18px 32px;">
      <span style="color:#ffffff;font-size:18px;font-weight:700;">Calen</span>
    </td></tr>
    <tr><td style="padding:28px 32px;color:#1f2937;font-size:15px;line-height:1.6;">
${contentHtml}
    </td></tr>
    <tr><td style="padding:18px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.5;">
      Calen — a shared calendar for your household.<br>
      <a href="${WEB_URL}" style="color:#9ca3af;">householdcalendar.com</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function htmlButton(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">${esc(label)}</a>`;
}

// "Get the app" links: store buttons when the listings exist, website otherwise.
function downloadLinks() {
  const stores = [
    APP_STORE_URL  && { href: APP_STORE_URL,  label: 'Download on the App Store' },
    PLAY_STORE_URL && { href: PLAY_STORE_URL, label: 'Get it on Google Play' },
  ].filter(Boolean);
  const links = stores.length ? stores : [{ href: WEB_URL, label: 'Get Calen' }];
  return {
    html: links.map((l) => htmlButton(l.href, l.label)).join('&nbsp;&nbsp;'),
    text: links.map((l) => `${l.label}: ${l.href}`).join('\n'),
  };
}

// ── Templates ────────────────────────────────────────────────────────────────
// Each template is a pure `build*` returning { subject, text, html, attachments? }
// so it can be rendered for the admin preview without sending; the `send*`
// wrapper hands the built message to sendMail with its catalog `kind`.

// Welcome (onboarding) — the first email a new account receives.
function buildWelcome(user) {
  const get = downloadLinks();
  return {
    subject: 'Welcome to Calen',
    text:
      `Hi ${user.firstName || 'there'},\n\n` +
      `Welcome to Calen — a shared calendar for your whole household. Keep events, ` +
      `chores, meals, trips and the people you care about in one place, together.\n\n` +
      `Install Calen on every device you use so your household stays in sync:\n\n` +
      `${get.text}\n\n` +
      `Questions? Just reply to support@householdcalendar.com.\n`,
    html: htmlLayout(
      `<p style="margin:0 0 16px;">Hi ${esc(user.firstName || 'there')},</p>
<p style="margin:0 0 16px;">Welcome to <strong>Calen</strong> — a shared calendar for your whole household. Keep events, chores, meals, trips and the people you care about in one place, together.</p>
<p style="margin:0 0 20px;">Install Calen on every device you use so your household stays in sync:</p>
<div style="text-align:center;margin:0 0 20px;">${get.html}</div>
<p style="margin:0;color:#6b7280;">Questions? Just reply to support@householdcalendar.com.</p>`
    ),
  };
}
function sendWelcome(user) {
  return sendMail({ to: user.email, kind: 'welcome', ...buildWelcome(user) });
}

// ── Forgot password ──────────────────────────────────────────────────────────

function buildPasswordResetCode(user, code) {
  return {
    subject: `${code} is your password reset code`,
    text:
      `Hi ${user.firstName || 'there'},\n\n` +
      `Your Calen password reset code is:\n\n` +
      `  ${code}\n\n` +
      `Enter it in the app within 15 minutes to choose a new password. If you ` +
      `didn't request this, you can ignore this email — your password is unchanged.\n\n` +
      `Note: if you use encrypted sync, resetting your password does not unlock ` +
      `your encrypted data — you'll be asked for Face ID / Touch ID or your ` +
      `recovery code afterwards.\n`,
    html: htmlLayout(
      `<p style="margin:0 0 16px;">Hi ${esc(user.firstName || 'there')},</p>
<p style="margin:0 0 16px;">Your Calen password reset code is:</p>
<div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;font-size:28px;letter-spacing:6px;font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace;color:#1f2937;">${esc(code)}</div>
<p style="margin:16px 0;">Enter it in the app within <strong>15 minutes</strong> to choose a new password. If you didn't request this, you can ignore this email — your password is unchanged.</p>
<p style="margin:0;color:#6b7280;">Note: if you use encrypted sync, resetting your password does not unlock your encrypted data — you'll be asked for Face&nbsp;ID / Touch&nbsp;ID or your recovery code afterwards.</p>`
    ),
  };
}
function sendPasswordResetCode(user, code) {
  return sendMail({ to: user.email, kind: 'password_reset', ...buildPasswordResetCode(user, code) });
}

// "New device signed in" (Signal-parity F3) — the out-of-band takeover signal.
// Also carries the F1 hold notice when a password reset is pending from an
// unknown device.
function buildNewDeviceAlert(user, device, { holdUntil } = {}) {
  const where = `${device.deviceName}${device.platform ? ` (${device.platform})` : ''}`;
  const holdText = holdUntil
    ? `\n\nA password reset was also requested from that device. For your security it will not take effect until ${fmtDate(holdUntil)}. If this wasn't you, open the app on your usual device and cancel it from Sign-in & Security.\n`
    : '';
  return {
    subject: holdUntil ? 'Password reset requested from a new device' : 'New sign-in to your Calen account',
    text:
      `Hi ${user.firstName || 'there'},\n\n` +
      `Your Calen account was just signed in to from a new device: ${where}.\n` +
      `If this was you, no action is needed.` + holdText +
      `\nIf this wasn't you, open Calen on your usual device → Profile → Sign-in & Security and sign that device out, then review your security settings.\n`,
    html: htmlLayout(
      `<p style="margin:0 0 16px;">Hi ${esc(user.firstName || 'there')},</p>
<p style="margin:0 0 16px;">Your Calen account was just signed in to from a new device: <strong>${esc(where)}</strong>.</p>
${holdUntil ? `<p style="margin:0 0 16px;">A password reset was also requested from that device. For your security it will not take effect until <strong>${esc(fmtDate(holdUntil))}</strong>. If this wasn't you, open the app on your usual device and cancel it from Sign-in &amp; Security.</p>` : ''}
<p style="margin:0;color:#6b7280;">If this was you, no action is needed. If it wasn't, open Calen → Profile → Sign-in &amp; Security and sign that device out.</p>`
    ),
  };
}
function sendNewDeviceAlert(user, device, opts = {}) {
  return sendMail({ to: user.email, kind: 'security_alert', ...buildNewDeviceAlert(user, device, opts) });
}

// ── Recipe shares ────────────────────────────────────────────────────────────
// Server-sent because a recipe is fully rendered content (ingredient table +
// instructions) — richer than the plain-text the OS share sheet can carry. The
// ongoing-access *invites* (household / calendar / trip) are device-composed
// instead (mobile lib/shareInvite); only styled content stays here.

// Email a full recipe — self-contained, the recipient needs nothing installed.
function buildRecipeShare({ fromName, recipe }) {
  const inviter = fromName || 'Someone';
  const mins = (recipe.prepTimeMins || 0) + (recipe.cookTimeMins || 0);
  const meta = [mins ? `${mins} min` : '', recipe.servings ? `${recipe.servings} servings` : '']
    .filter(Boolean)
    .join(' · ');
  const ingredients = (recipe.ingredients || []).map(
    (ing) => [ing.amount, ing.unit, ing.name].filter(Boolean).join(' '),
  );
  const instructions = recipe.instructions || [];
  const get = downloadLinks();
  const lines = [
    `${inviter} shared a recipe with you:`,
    '',
    `  ${recipe.title}`,
    ...(meta ? [`  ${meta}`] : []),
    ...(recipe.description ? ['', recipe.description] : []),
    '',
    'Ingredients:',
    ...ingredients.map((i) => `• ${i}`),
    '',
    'Instructions:',
    ...instructions.map((step, i) => `${i + 1}. ${step}`),
    '',
    get.text,
  ];
  return {
    subject: `${inviter} shared a recipe: ${recipe.title}`,
    text: lines.join('\n') + '\n',
    html: htmlLayout(
      `<p style="margin:0 0 16px;"><strong>${esc(inviter)}</strong> shared a recipe with you:</p>
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin:0 0 20px;">
  <div style="font-size:18px;font-weight:700;color:#111827;">${esc(recipe.title)}</div>
  ${meta ? `<div style="color:#6b7280;font-size:13px;margin-top:4px;">${esc(meta)}</div>` : ''}
  ${recipe.description ? `<p style="margin:10px 0 0;color:#374151;font-size:14px;">${esc(recipe.description)}</p>` : ''}
</div>
<div style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;">Ingredients</div>
<ul style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
  ${ingredients.map((i) => `<li>${esc(i)}</li>`).join('\n  ')}
</ul>
<div style="font-size:15px;font-weight:700;color:#111827;margin:0 0 8px;">Instructions</div>
<ol style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
  ${instructions.map((s) => `<li>${esc(s)}</li>`).join('\n  ')}
</ol>
<div style="text-align:center;margin:0 0 4px;">${get.html}</div>`
    ),
  };
}
function sendRecipeShare({ toEmail, ...rest }) {
  return sendMail({ to: toEmail, kind: 'recipe_share', ...buildRecipeShare(rest) });
}

// ── Event invitations ────────────────────────────────────────────────────────

// When/where line for the invite email body.
function fmtEventWhen(event) {
  if (event.allDay) {
    const start = fmtDate(event.startDate);
    if (!event.endDate || fmtDate(event.endDate) === start) return start;
    return `${start} – ${fmtDate(event.endDate)}`;
  }
  const opts = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const start = new Date(event.startDate).toLocaleString('en-US', opts);
  if (!event.endDate) return start;
  return `${start} – ${new Date(event.endDate).toLocaleString('en-US', opts)}`;
}

// Invite a recipient to a calendar event. `ics` is the iCalendar text attached
// so the event imports into Apple/Google/Outlook straight from the email.
// `hasAccount` switches the call-to-action: open the app vs. join the app.
function buildEventInvitation({ fromName, event, hasAccount, ics }) {
  const inviter = fromName || 'Someone';
  // D3 sealed invite: no plaintext event (it's sealed to the recipient's keys),
  // so the email is a notice only — no title/when, no .ics.
  if (!event) {
    const get = downloadLinks();
    const lines = [
      `${inviter} invited you to an event.`,
      '',
      'Open the Calen app to see the details and accept or decline — the invitation is end-to-end encrypted, so only you can read it.',
      '',
      get.text,
    ];
    return {
      subject: `${inviter} invited you to an event`,
      text: lines.join('\n') + '\n',
      html: htmlLayout(
        `<p style="margin:0 0 16px;"><strong>${esc(inviter)}</strong> invited you to an event.</p>
<p style="margin:0 0 20px;">Open the <strong>Calen</strong> app to see the details and accept or decline — the invitation is end-to-end encrypted, so only you can read it.</p>
<div style="text-align:center;margin:0 0 4px;">${get.html}</div>`
      ),
    };
  }
  const when = fmtEventWhen(event);
  const get = downloadLinks();
  const lines = [
    `${inviter} invited you to an event:`,
    '',
    `  ${event.title}`,
    `  When: ${when}`,
    ...(event.location ? [`  Where: ${event.location}`] : []),
    ...(event.description ? ['', event.description] : []),
    '',
    'The attached invite.ics adds this event to Apple, Google, or Outlook Calendar.',
    '',
    hasAccount
      ? 'You can also accept or decline this invitation from the Invitations screen in the Calen app — accepting adds the event to your calendar there.'
      : 'Join Calen to keep events like this on a shared family calendar.',
    '',
    get.text,
  ];
  const detailRow = (label, value) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:2px 0;color:#1f2937;font-size:14px;">${esc(value)}</td></tr>`;
  return {
    subject: `${inviter} invited you: ${event.title}`,
    text: lines.join('\n') + '\n',
    html: htmlLayout(
      `<p style="margin:0 0 16px;"><strong>${esc(inviter)}</strong> invited you to an event:</p>
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin:0 0 20px;">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px;">${esc(event.title)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0">
    ${detailRow('When', when)}
    ${event.location ? detailRow('Where', event.location) : ''}
  </table>
  ${event.description ? `<p style="margin:10px 0 0;color:#374151;font-size:14px;">${esc(event.description)}</p>` : ''}
</div>
<p style="margin:0 0 16px;">The attached <strong>invite.ics</strong> adds this event to Apple, Google, or Outlook Calendar.</p>
<p style="margin:0 0 20px;">${
        hasAccount
          ? 'You can also accept or decline this invitation from the <strong>Invitations</strong> screen in the Calen app — accepting adds the event to your calendar there.'
          : 'Join Calen to keep events like this on a shared family calendar.'
      }</p>
<div style="text-align:center;margin:0 0 4px;">${get.html}</div>`
    ),
    attachments: ics ? [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=PUBLISH' }] : undefined,
  };
}
function sendEventInvitation({ toEmail, ...rest }) {
  return sendMail({ to: toEmail, kind: 'event_invitation', ...buildEventInvitation(rest) });
}

// ── Account deletion confirmation ────────────────────────────────────────────
// Sent just BEFORE the purge (while the address is still valid), confirming the
// account and its cloud data were removed (Apple 5.1.1(v)).
function buildAccountDeletedConfirmation({ firstName }) {
  return {
    subject: 'Your Calen account has been deleted',
    text:
      `Hi ${firstName || 'there'},\n\n` +
      `This confirms that your Calen account and its cloud data have been permanently ` +
      `deleted at your request. Nothing is retained beyond a content-free record that ` +
      `the deletion happened.\n\n` +
      `If you didn't request this, contact us right away at support@householdcalendar.com.\n\n` +
      `Thanks for having used Calen.\n`,
    html: htmlLayout(
      `<p style="margin:0 0 16px;">Hi ${esc(firstName || 'there')},</p>
<p style="margin:0 0 16px;">This confirms that your Calen account and its cloud data have been <strong>permanently deleted</strong> at your request. Nothing is retained beyond a content-free record that the deletion happened.</p>
<p style="margin:0 0 16px;">If you didn't request this, contact us right away at <a href="mailto:support@householdcalendar.com">support@householdcalendar.com</a>.</p>
<p style="margin:0;color:#6b7280;">Thanks for having used Calen.</p>`
    ),
  };
}
function sendAccountDeletedConfirmation({ email, firstName }) {
  return sendMail({ to: email, kind: 'account_deleted', ...buildAccountDeletedConfirmation({ firstName }) });
}

// ── Occasion e-cards ─────────────────────────────────────────────────────────
// PRIVACY NOTE: e-cards are a deliberate plaintext exception to E2EE (like email
// invitations). See specs/platform/crypto-e2ee.md "Deliberate plaintext
// exceptions". Renders as a standalone greeting card (not htmlLayout); the
// gallery + renderer live in ecardTemplates.js. Photos are embedded INLINE via
// CID attachments (no external hosting); a photo whose file is missing is
// skipped, never fatal.
const ECARD_UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const PHOTO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

function sendECard({ toEmail, toName, fromName, kind, occasionLabel, message, template, font, greeting, signoff, signature, photos }) {
  const files = (photos || []).filter((p) => p.storageKey && fs.existsSync(path.join(ECARD_UPLOAD_DIR, p.storageKey)));
  const photoCids = files.map((_, i) => `ecard-photo-${i}@calen`);
  const { subject, html, text } = renderECard({
    kind, template, occasionLabel, toName, fromName, message, font, greeting, signoff, signature, photoCids,
  });
  const attachments = files.map((p, i) => ({
    filename: `photo-${i + 1}${PHOTO_EXT[p.contentType] || '.jpg'}`,
    path: path.join(ECARD_UPLOAD_DIR, p.storageKey),
    cid: photoCids[i],
    contentType: p.contentType || 'image/jpeg',
  }));
  return sendMail({ to: toEmail, subject, kind: 'ecard', text, html, attachments: attachments.length ? attachments : undefined });
}

// ── Admin preview ────────────────────────────────────────────────────────────
// Render a catalog template with its `sample` args — for the admin console's
// "Preview" — WITHOUT sending or logging. Returns { subject, text, html } or
// null for an unknown / not-previewable (planned) key.
function renderPreview(key) {
  const entry = catalogByKey(key);
  if (!entry || !entry.implemented || !entry.sample) return null;
  const s = entry.sample;
  switch (key) {
    case 'welcome':              return buildWelcome(s.user);
    case 'password_reset':       return buildPasswordResetCode(s.user, s.code);
    case 'security_alert':       return buildNewDeviceAlert(s.user, s.device, s.opts || {});
    case 'event_invitation':     return buildEventInvitation(s);
    case 'recipe_share':         return buildRecipeShare(s);
    case 'account_deleted':      return buildAccountDeletedConfirmation(s);
    case 'ecard': {
      const { subject, html, text } = renderECard({ ...s, photoCids: [] });
      return { subject, html, text };
    }
    default: return null;
  }
}

module.exports = {
  isConfigured,
  sendMail,
  sendWelcome,
  sendPasswordResetCode,
  sendNewDeviceAlert,
  sendEventInvitation,
  sendRecipeShare,
  sendAccountDeletedConfirmation,
  sendECard,
  // Delivery internals shared with jobs/emailReconcile.js + admin routes.
  attemptSend,
  classifyFailure,
  isHardBounce,
  backoffMinutes,
  invalidateEmailConfigCache,
  renderPreview,
  MAIL_FROM,
  ECARD_TEMPLATES,
};
