const cron = require('node-cron');
const { addDays, addWeeks, addMonths, addYears } = require('date-fns');
const MaintenanceTask = require('../models/MaintenanceTask');
const Chore = require('../models/Chore');
const User = require('../models/User');
const Household = require('../models/Household');
const Contact = require('../models/Contact');
const CalendarEvent = require('../models/CalendarEvent');
const ECard = require('../models/ECard');
const { pushToUser } = require('../services/notify');
const mailer = require('../services/mailer');
const { isConfigured: pushConfigured } = require('../services/push');
const { cleanupOrphanUploads } = require('./cleanupOrphanUploads');
const { runEmailReconcile } = require('./emailReconcile');

const APP_URL = () => process.env.APP_URL || 'http://localhost:5174';

// A user's personal day-based alert hour (0-23). Parsed from their
// `dayAlertTime` (`HH:mm`); the cron is hourly so only the HOUR is honored
// server-side (the on-device scheduler honors the full time). Defaults to 9am.
function dayAlertHour(u) {
  const m = /^(\d{1,2}):/.exec(u.dayAlertTime || '');
  const h = m ? parseInt(m[1], 10) : 9;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

// 0-23 hour in a timezone.
function localHour(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz })
    .formatToParts(new Date());
  return parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
}

// "YYYY-MM-DD" in a timezone for a given instant.
function localDateStr(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

// Subtract whole days from a "YYYY-MM-DD" calendar string.
function dateStrMinusDays(isoDateStr, days) {
  const d = new Date(isoDateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days || 0));
  return d.toISOString().slice(0, 10);
}

// Explicit per-member recipient list (tasks). When set, it overrides the
// coarse alertAudience. Empty/absent → fall back to alertAudience.
function recipientIds(item) {
  return Array.isArray(item.alertUserIds) ? item.alertUserIds.map(String) : [];
}

// Resolve the users an item's alert should reach, given its audience and the
// household's members. Explicit recipients win; otherwise 'owner' → just the
// creator; 'everyone' → all members.
function audienceUsers(item, members) {
  const ids = recipientIds(item);
  if (ids.length) return members.filter(m => ids.includes(String(m._id)));
  if (item.alertAudience === 'owner') {
    return members.filter(m => String(m._id) === String(item.userId));
  }
  return members;
}

// Should a given user receive this item's alert? Explicit recipients win;
// otherwise 'owner' → only the creator; 'everyone' → any household member. Used
// by the per-user daily check so each member is evaluated in their own timezone.
function inAudience(item, user) {
  const ids = recipientIds(item);
  if (ids.length) return ids.includes(String(user._id));
  if (item.alertAudience === 'owner') return String(user._id) === String(item.userId);
  return true;
}

async function pushToUsers(users, payload) {
  for (const u of users) await pushToUser(u, payload);
}

// ── Daily per-item alerts (tasks, chores, birthdays) ────────────────────────
// Runs hourly; fires per-member at their chosen local alert hour (9am default).
// Tasks/chores alert on
// (dueDate − reminderDaysBefore) and the optional second alert; birthdays
// always alert on the day, to everyone.
async function runDailyCheck() {
  console.log('[Scheduler] Daily alert check at', new Date().toISOString());
  if (!pushConfigured()) return;   // push is the only channel
  const households = await Household.find({});

  for (const hh of households) {
    try {
      await runDailyCheckForHousehold(hh);
    } catch (err) {
      // One bad household (e.g. an invalid timezone) must not abort the rest.
      console.error(`[Scheduler] Daily check failed for household ${hh._id}:`, err.message);
    }
  }
}

async function runDailyCheckForHousehold(hh) {
  // E2EE households compute all reminders on-device (§9.1 P3); post-drop the
  // server can't read task/chore/birthday content anyway. Skip the whole
  // household. Dormant pre-drop (e2eeActive defaults false).
  if (hh.e2eeActive) return;

  const members = await User.find({ householdId: hh._id });
  if (!members.length) return;

  // Each member alerts at their own chosen hour (default 9am) in their own local
  // zone, so a member in a different zone (travelling or out-of-town) gets
  // correct timing. Bail early if nobody in the household is due this hour.
  const tzOf = (u) => u.timezone || hh.timezone || 'America/Toronto';
  // Skip users whose client schedules reminders on-device (Phase 5) — they'd
  // otherwise be notified twice.
  const due = members.filter(u => !u.localReminders && localHour(tzOf(u)) === dayAlertHour(u));
  if (!due.length) return;

  const memberIds = members.map(m => m._id);
  const [tasks, chores, contacts] = await Promise.all([
    MaintenanceTask.find({ userId: { $in: memberIds }, active: true, nextDueDate: { $ne: null } }).populate('itemId', 'name').lean(),
    Chore.find({ userId: { $in: memberIds }, active: true, nextDueDate: { $ne: null } }).lean(),
    Contact.find({ userId: { $in: memberIds }, birthday: { $ne: null } }).lean(),
  ]);

  // Fire each due member's alerts, with due/today evaluated in their zone.
  for (const u of due) {
    const todayStr = localDateStr(tzOf(u));

    // Tasks
    for (const t of tasks) {
      if (!inAudience(t, u) || !alertsToday(t, todayStr)) continue;
      await pushToUser(u, {
        title: 'Maintenance due',
        body: t.itemId?.name ? `${t.title} (${t.itemId.name})` : t.title,
        url: `${APP_URL()}/tasks`, tag: `task-${t._id}`,
      });
      console.log(`[Scheduler] Task alert: ${t._id} → user ${u._id}`); // ids only (C5)
    }

    // Chores
    for (const c of chores) {
      if (!inAudience(c, u) || !alertsToday(c, todayStr)) continue;
      await pushToUser(u, {
        title: 'Chore due', body: c.title, url: `${APP_URL()}/chores`, tag: `chore-${c._id}`,
      });
      console.log(`[Scheduler] Chore alert: ${c._id} → user ${u._id}`);
    }

    // Birthdays — always, to everyone.
    const [, mo, day] = todayStr.split('-');
    for (const p of contacts) {
      const b = new Date(p.birthday);
      const bMo = String(b.getUTCMonth() + 1).padStart(2, '0');
      const bDay = String(b.getUTCDate()).padStart(2, '0');
      if (bMo !== mo || bDay !== day) continue;
      const turning = Number(todayStr.slice(0, 4)) - b.getUTCFullYear();
      await pushToUser(u, {
        title: '🎂 Birthday today',
        body: turning > 0 ? `${p.name} turns ${turning} today` : `${p.name}'s birthday is today`,
        url: `${APP_URL()}/contacts`, tag: `bday-${p._id}-${todayStr}`,
      });
      console.log(`[Scheduler] Birthday alert: ${p._id} → user ${u._id}`);
    }
  }
}

// Does a task/chore have an alert landing on `todayStr`? Checks both the
// primary (reminderDaysBefore) and secondary (alert2DaysBefore) offsets.
// null offset = that alert is off.
function alertsToday(item, todayStr) {
  const dueStr = new Date(item.nextDueDate).toISOString().slice(0, 10);
  for (const off of [item.reminderDaysBefore, item.alert2DaysBefore]) {
    if (off == null) continue;
    if (dateStrMinusDays(dueStr, off) === todayStr) return true;
  }
  return false;
}

// ── Event reminders — every 15 min, precise per-occurrence ──────────────────
//
// Dormant: fanOutEventReminder returns early for E2EE households, which is now
// every household, and the one-shot `reminderAt`/`alert2At` fields are no
// longer written by any route. The math below therefore counts back from the
// stored startDate for every event, including all-day ones — the rule that an
// all-day event's alerts are whole days off the user's day-alert hour lives
// on-device (mobile lib/calendar `eventAlertAnchor` + lib/notifications), the
// only place reminders are actually computed post-drop.
async function runEventReminderCheck() {
  if (!pushConfigured()) return;
  const now       = new Date();
  const windowEnd = new Date(now.getTime() + 15 * 60 * 1000);

  await fireOneShotReminders('reminderAt', 'reminderSentAt', now, windowEnd);
  await fireOneShotReminders('alert2At', 'alert2SentAt', now, windowEnd);
  await fireRecurringReminders(now, windowEnd);
}

async function fireOneShotReminders(atField, sentField, now, windowEnd) {
  const events = await CalendarEvent.find({
    [atField]: { $gte: now, $lte: windowEnd },
    [sentField]: { $exists: false },
    'recurrence.freq': { $exists: false },
  }).lean();

  for (const event of events) {
    await fanOutEventReminder(event);
    await CalendarEvent.updateOne({ _id: event._id }, { [sentField]: new Date() });
  }
}

async function fireRecurringReminders(now, windowEnd) {
  const events = await CalendarEvent.find({
    'recurrence.freq': { $exists: true },
    reminderMinutes: { $exists: true, $ne: null },
  }).lean();

  const advance = {
    daily: d => addDays(d, 1), weekly: d => addWeeks(d, 1),
    monthly: d => addMonths(d, 1), yearly: d => addYears(d, 1),
  };

  for (const event of events) {
    const { freq, interval = 1, until } = event.recurrence;
    const step = advance[freq];
    if (!step) continue;
    const untilD = until ? new Date(until) : null;

    for (const minsField of ['reminderMinutes', 'alert2Minutes']) {
      const mins = event[minsField];
      if (mins == null) continue;

      // Walk occurrences whose alert time could fall in [now, windowEnd).
      // Exclusive upper bound so consecutive 15-min windows never double-fire.
      let occ = new Date(event.startDate);
      let guard = 0;
      while (guard++ < 1000) {
        if (untilD && occ > untilD) break;
        const alertAt = new Date(occ.getTime() - mins * 60000);
        if (alertAt >= windowEnd) break;
        if (alertAt >= now) await fanOutEventReminder({ ...event, startDate: occ });
        let n = occ;
        for (let i = 0; i < interval; i++) n = step(n);
        if (n <= occ) break;
        occ = n;
      }
    }
  }
}

// Push an event reminder to its audience across the creator's household.
async function fanOutEventReminder(event) {
  const owner = await User.findById(event.userId).lean();
  if (!owner) return;
  // Skip E2EE households — event reminders are on-device post-drop, and the
  // server can no longer read event content (§9.1 P3). Dormant pre-drop.
  if (owner.householdId) {
    const hh = await Household.findById(owner.householdId).select('e2eeActive').lean();
    if (hh?.e2eeActive) return;
  }
  const members = owner.householdId
    ? await User.find({ householdId: owner.householdId })
    : [await User.findById(owner._id)];

  const when = new Date(event.startDate).toLocaleString('en-CA', event.allDay
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Skip recipients who get this reminder on-device (Phase 5).
  await pushToUsers(audienceUsers(event, members).filter(u => !u.localReminders), {
    title: `Reminder: ${event.title}`,
    body: event.location || when,
    url: `${APP_URL()}/calendar`,
    tag: `event-${event._id}-${new Date(event.startDate).toISOString()}`,
  });
  console.log(`[Scheduler] Event alert: ${event._id}`);
}

// ── Occasion e-cards — hourly, one-time per-card ────────────────────────────
// Sends each active ECard on its occasion's month/day, at the author's local
// send-time hour, then DEACTIVATES it: a card fires once, on its next
// occurrence, and does not recur annually. UNLIKE the daily/event checks, this
// runs for E2EE households too: an ECard is a deliberate plaintext exception
// (models/ECard.js), so the recipient emails + message are server-readable by
// design. Clearing `active` after the send makes the hourly re-run idempotent
// (a sent card is no longer queried).
async function runECardCheck() {
  const cards = await ECard.find({ active: true }).lean();
  if (!cards.length) return;

  // Small caches so a household of cards doesn't re-query the same author/hh.
  const userCache = new Map();
  const hhCache = new Map();
  const getUser = async (id) => {
    const key = String(id);
    if (!userCache.has(key)) userCache.set(key, await User.findById(id).select('firstName email timezone householdId').lean());
    return userCache.get(key);
  };
  const getHhTz = async (id) => {
    if (!id) return null;
    const key = String(id);
    if (!hhCache.has(key)) {
      const hh = await Household.findById(id).select('timezone').lean();
      hhCache.set(key, hh?.timezone || null);
    }
    return hhCache.get(key);
  };

  for (const card of cards) {
    try {
      const author = await getUser(card.userId);
      if (!author) continue;
      const tz = author.timezone || (await getHhTz(author.householdId)) || 'America/Toronto';
      const todayStr = localDateStr(tz);           // YYYY-MM-DD in the author's zone
      const [, moStr, dStr] = todayStr.split('-');
      if (Number(moStr) !== card.month || Number(dStr) !== card.day) continue;
      // NB: `|| 9` would fold a midnight card (hour 0, falsy) back to 9am.
      const parsedHour = parseInt(String(card.sendTime || '09:00').split(':')[0], 10);
      const sendHour = Number.isInteger(parsedHour) ? parsedHour : 9;
      // Send at the first hourly tick AT OR AFTER the send hour on the occasion
      // day — so a card scheduled same-day past its hour, or one whose exact tick
      // was missed (deploy/downtime), still goes out that day. Deactivating the
      // card after the send (below) keeps it to a single, one-time delivery.
      if (localHour(tz) < sendHour) continue;

      for (const r of card.recipients || []) {
        await mailer.sendECard({
          toEmail: r.email,
          toName: r.name,
          fromName: author.firstName,
          ccEmail: author.email,   // author keeps a copy of each card they scheduled
          kind: card.kind,
          occasionLabel: card.occasionLabel,
          message: card.message,
          template: card.template,
          font: card.font,
          greeting: card.greeting,
          signoff: card.signoff,
          signature: card.signature,
          photos: card.photos,
        });
      }
      await ECard.updateOne({ _id: card._id }, { $set: { active: false, sentAt: new Date() } });
      console.log(`[Scheduler] E-card sent: ${card._id} → ${(card.recipients || []).length} recipient(s)`); // ids/counts only (C5)
    } catch (err) {
      console.error(`[Scheduler] E-card send failed for ${card._id}:`, err.message);
    }
  }
}

// ── Periodic HDK rotation flag (Signal-parity plan B2) ──────────────────────
// The server can't rotate a key it never holds — it only FLAGS households whose
// current HDK version is older than the interval; the next unlocked member's
// existing self-heal (ensureHouseholdKey → rotateHouseholdKey) performs the
// rotation client-side. With the B1 eager re-encrypt + B3 envelope retirement,
// this bounds how much ciphertext a compromised key can ever expose.
async function runKeyRotationCheck() {
  const days = Number(process.env.KEY_ROTATION_INTERVAL_DAYS || 90);
  if (!days || days <= 0) return; // 0/negative disables the cadence
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await Household.updateMany(
    {
      currentKeyVersion: { $gte: 1 },
      keyRotationPending: { $ne: true },
      $or: [{ lastKeyRotationAt: { $lt: cutoff } }, { lastKeyRotationAt: null }],
      // Pre-B2 households have no lastKeyRotationAt; use creation age so a
      // fresh household isn't flagged on day one.
      createdAt: { $lt: cutoff },
    },
    { $set: { keyRotationPending: true } },
  );
  if (res.modifiedCount) console.log(`[Scheduler] Flagged ${res.modifiedCount} household(s) for periodic key rotation`);
}

// ── Cloud-purge sweep (Phase 6, §6.2) ───────────────────────────────────────
function startScheduler() {
  cron.schedule('0 * * * *', () => runDailyCheck().catch(err =>
    console.error('[Scheduler] runDailyCheck failed:', err.message)));
  cron.schedule('*/15 * * * *', () => runEventReminderCheck().catch(err =>
    console.error('[Scheduler] runEventReminderCheck failed:', err.message)));
  cron.schedule('0 * * * *', () => runECardCheck().catch(err =>
    console.error('[Scheduler] runECardCheck failed:', err.message)));
  cron.schedule('30 3 * * *', () => cleanupOrphanUploads().catch(err =>
    console.error('[Scheduler] cleanupOrphanUploads failed:', err.message)));
  cron.schedule('45 3 * * *', () => runKeyRotationCheck().catch(err =>
    console.error('[Scheduler] runKeyRotationCheck failed:', err.message)));
  // Email delivery outbox: retry transient/provider-blocked sends on backoff.
  cron.schedule('*/10 * * * *', () => runEmailReconcile().catch(err =>
    console.error('[Scheduler] runEmailReconcile failed:', err.message)));
  console.log('[Scheduler] Per-item push alerts: daily check hourly (fires each member\'s chosen local hour, 9am default, for tasks/chores/birthdays); event reminders every 15 min; occasion e-cards hourly (fire on the occasion date at the author\'s send-time); orphan-upload cleanup at 03:30; key-rotation age check at 03:45; email delivery reconcile every 10 min');
}

module.exports = {
  startScheduler, runDailyCheck, runEventReminderCheck, runKeyRotationCheck, runECardCheck, runEmailReconcile,
  // Exported for tests.
  runDailyCheckForHousehold, inAudience, alertsToday, localHour, localDateStr,
};
