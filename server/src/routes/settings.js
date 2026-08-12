const express = require('express');
const User = require('../models/User');
const Household = require('../models/Household');
const Contact = require('../models/Contact');
const { requireAuth } = require('../middleware/auth');
const { pickRecordEnc } = require('../services/householdKey');
const { stripSealedContent } = require('../services/e2eePolicy');
const { normalizePhone } = require('../services/phone');

const router = express.Router();
router.use(requireAuth);

// Settings shared across the household vs. personal to the user account.
// aboutMe (notes) now lives on the user's self Contact record,
// managed from the Contacts page — not here. Notifications are no longer a global
// setting — alerts are configured per item and delivered via push.
// timezone is personal: alerts fire at each member's own default alert hour
// (9am unless they change it — see dayAlertTime) in their own local zone, so a
// travelling or out-of-town member gets correct timing regardless of the
// household's default zone.
const SHARED   = ['homeAddress', 'homeCity', 'groceryShoppingDay', 'groceryFrequency', 'groceryAnchor', 'grocerySections', 'reminderLeadDays'];
// aiEnabled mirrors the device's AI consent toggle (middleware/aiConsent.js).
// dayAlertTime is the personal `HH:mm` default day-based alerts fire at (see
// User.dayAlertTime); validated + normalized below.
// occasionAlerts / holidayAlerts are the calendar-level alert configs for the
// two calendars whose items are computed on-device (Occasions, holidays); they
// live here because the device cache is cleared at sign-out (see
// User.occasionAlerts). Validated + normalized below.
// calendarPrefs is how the user arranged their calendars (colours, order,
// hidden, deleted built-ins, muted alerts) — account state for the same reason
// as the alert configs (see User.calendarPrefs). Validated + normalized below.
const PERSONAL = [
  'firstName', 'lastName', 'birthday', 'timezone', 'phone', 'aiEnabled', 'dayAlertTime',
  'occasionAlerts', 'holidayAlerts', 'calendarPrefs',
];

// Normalize a calendar-level alert config off the wire. Returns the stored
// shape, `null` to clear it back to "never configured", or `undefined` when the
// payload is unusable (the caller answers 400). Offsets are whole days before
// the date, deduped and sorted; an EMPTY list is valid and means "alerts off".
function normalizeAlertPrefs(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!Array.isArray(value.offsets)) return undefined;
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return undefined;
  const offsets = [...new Set(
    value.offsets
      .filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 366)
      .map((n) => Math.floor(n))
  )].sort((a, b) => a - b);
  return { offsets, time: value.time };
}

// The stored config as the client reads it (a plain object, or null when the
// user has never configured that calendar's alerts).
function alertPrefsOut(p) {
  return p ? { offsets: [...(p.offsets ?? [])], time: p.time || '09:00' } : null;
}

// Bounds on the calendar arrangement below. A user has tens of calendars, not
// thousands; these only stop a bugged or hostile client from parking unbounded
// data on the account.
const CAL_ID_MAX = 128;
const CAL_LIST_MAX = 500;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CAL_ID_LISTS = ['order', 'hidden', 'deletedDefaults', 'alertsOff'];

// Normalize one list of calendar ids: strings only, deduped, order preserved
// (`order` is itself a sequence, so sorting would destroy it). Returns
// undefined when the value isn't a usable list.
function normalizeCalIdList(value) {
  if (!Array.isArray(value) || value.length > CAL_LIST_MAX) return undefined;
  const out = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !id || id.length > CAL_ID_MAX) return undefined;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Normalize the calendar arrangement off the wire. Returns the stored shape,
// `null` to clear it back to "never configured", or `undefined` when the
// payload is unusable (the caller answers 400).
//
// Only the fields PRESENT in the payload are returned, and the caller merges
// them over what's stored — so a client that knows about fewer fields (an older
// build, or a future one sending a single changed list) can't blank the rest.
// An empty list or map IS a value ("nothing hidden", "no colour overrides") and
// is preserved as one.
function normalizeCalendarPrefs(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  if (value.colors !== undefined) {
    const src = value.colors;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return undefined;
    const entries = Object.entries(src);
    if (entries.length > CAL_LIST_MAX) return undefined;
    const colors = {};
    for (const [id, hex] of entries) {
      if (!id || id.length > CAL_ID_MAX) return undefined;
      if (typeof hex !== 'string' || !HEX_COLOR.test(hex)) return undefined;
      colors[id] = hex;
    }
    out.colors = colors;
  }
  for (const key of CAL_ID_LISTS) {
    if (value[key] === undefined) continue;
    const list = normalizeCalIdList(value[key]);
    if (list === undefined) return undefined;
    out[key] = list;
  }
  return out;
}

// The stored arrangement as the client reads it, or null when the user has
// never configured one. Fields the user has never set stay ABSENT rather than
// becoming empty — absent means "adopt whatever this device has", while an
// empty value means "the user cleared it", and the client acts on that
// difference (see hydrateAccountPrefsFromServer).
function calendarPrefsOut(p) {
  if (!p) return null;
  const out = {};
  // A Map subdocument in Mongo, a plain object on a freshly-written doc.
  if (p.colors) out.colors = p.colors instanceof Map ? Object.fromEntries(p.colors) : { ...p.colors };
  for (const key of CAL_ID_LISTS) if (p[key]) out[key] = [...p[key]];
  return out;
}

router.get('/', async (req, res) => {
  const u = req.user;
  const hh = req.household || u;   // fall back to user during transition
  // Member count drives whether per-item alert "audience" pickers are shown.
  const memberCount = req.household
    ? await User.countDocuments({ householdId: req.household._id })
    : 1;
  res.json({
    email: u.email,
    firstName: u.firstName, lastName: u.lastName, birthday: u.birthday,
    phone: u.phone || '',
    timezone: u.timezone,
    aiEnabled: u.aiEnabled !== false,
    // Personal default time (HH:mm) day-based alerts fire at; null = 9am default.
    dayAlertTime: u.dayAlertTime ?? null,
    // Calendar-level alert configs for the on-device calendars; null = never
    // configured, so the client applies its own defaults.
    occasionAlerts: alertPrefsOut(u.occasionAlerts),
    holidayAlerts: alertPrefsOut(u.holidayAlerts),
    // How the user arranged their calendars; null = never configured, so the
    // device's own arrangement stands (and seeds the account).
    calendarPrefs: calendarPrefsOut(u.calendarPrefs),
    // shared (household)
    homeAddress: hh.homeAddress,
    // Coarse home-area label (plaintext) the calendar assistant grounds local
    // suggestions in — derived client-side from the address, or set by hand.
    homeCity: hh.homeCity || '',
    groceryShoppingDay: hh.groceryShoppingDay, grocerySections: hh.grocerySections,
    groceryFrequency: hh.groceryFrequency ?? 'weekly', groceryAnchor: hh.groceryAnchor ?? null,
    reminderLeadDays: hh.reminderLeadDays,
    householdTimezone: req.household?.timezone,
    householdMemberCount: memberCount,
    // Encrypted home-location blob (§9.1 P5) so the client can decrypt the address
    // after the drop. householdId lets the client bind the AAD.
    householdId: req.household?._id,
    enc: req.household?.enc,
    keyVersion: req.household?.keyVersion,
  });
});

router.put('/', async (req, res) => {
  try {
    const userUpdate = {};
    for (const key of PERSONAL) if (req.body[key] !== undefined) userUpdate[key] = req.body[key];
    // Day-based alert default: an empty value clears it back to the 9am default
    // (null); a non-empty value must be a real 24h `HH:mm` wall-clock time.
    if (userUpdate.dayAlertTime !== undefined) {
      const t = String(userUpdate.dayAlertTime).trim();
      if (!t) userUpdate.dayAlertTime = null;
      else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return res.status(400).json({ error: 'Enter a valid time' });
      else userUpdate.dayAlertTime = t;
    }
    // Calendar-level alert configs (Occasions, holidays): a well-formed config,
    // or null to fall back to the client defaults. Anything else is a bad write
    // — accepting it would leave the account holding alerts the user can't see.
    for (const key of ['occasionAlerts', 'holidayAlerts']) {
      if (userUpdate[key] === undefined) continue;
      const prefs = normalizeAlertPrefs(userUpdate[key]);
      if (prefs === undefined) return res.status(400).json({ error: 'Invalid alert settings' });
      userUpdate[key] = prefs;
    }
    // Calendar arrangement (colours, order, hidden, deleted built-ins, muted
    // alerts). Merged field-by-field over what's stored rather than replacing
    // the document: the payload carries only the fields the client is changing,
    // and a wholesale replace would blank the ones it left out.
    if (userUpdate.calendarPrefs !== undefined) {
      const prefs = normalizeCalendarPrefs(userUpdate.calendarPrefs);
      if (prefs === undefined) return res.status(400).json({ error: 'Invalid calendar settings' });
      userUpdate.calendarPrefs = prefs && { ...calendarPrefsOut(req.user.calendarPrefs), ...prefs };
    }
    // Normalize the phone so it can be resolved by the sharing flows. An empty
    // string clears it; a non-empty value must be a plausible number.
    if (userUpdate.phone !== undefined) {
      const raw = String(userUpdate.phone).trim();
      if (!raw) userUpdate.phone = '';
      else {
        const norm = normalizePhone(raw);
        if (!norm) return res.status(400).json({ error: 'Enter a valid phone number' });
        userUpdate.phone = norm;
      }
    }

    const hhUpdate = {};
    for (const key of SHARED) if (req.body[key] !== undefined) hhUpdate[key] = req.body[key];
    // Household default zone (the scheduler's fallback for members who never
    // opened the app). The client derives it from the home location — keyless,
    // client-side, so it works for E2EE households whose address the server
    // can't read. Must be a real IANA zone id.
    if (req.body.householdTimezone !== undefined) {
      const tz = String(req.body.householdTimezone);
      try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); hhUpdate.timezone = tz; }
      catch { return res.status(400).json({ error: 'Invalid timezone' }); }
    }
    // Bust cached geocoordinates when the home address changes
    if (hhUpdate.homeAddress !== undefined) { hhUpdate.lat = null; hhUpdate.lon = null; }
    // Encrypted home-location blob (§9.1 P5), when the client sealed it.
    try { Object.assign(hhUpdate, pickRecordEnc(req.body)); }
    catch (msg) { return res.status(400).json({ error: msg }); }
    // Steady-state write rule: an e2eeActive household stores only the sealed
    // blob — never the plaintext homeAddress (C2) nor the geocoords derived from
    // it (the drop nulls lat/lon with it). The name lives in the blob too but
    // isn't set on this route.
    if (hhUpdate.enc?.ct && req.household?.e2eeActive) { delete hhUpdate.lat; delete hhUpdate.lon; }
    stripSealedContent('Household', req.household, hhUpdate);

    const [user] = await Promise.all([
      Object.keys(userUpdate).length
        ? User.findByIdAndUpdate(req.user._id, userUpdate, { new: true }).select('-passwordHash')
        : Promise.resolve(req.user),
      (Object.keys(hhUpdate).length && req.household)
        ? Household.updateOne({ _id: req.household._id }, { $set: hhUpdate })
        : Promise.resolve(),
    ]);

    // Signal-parity C3b: the self-Contact lives in the unified opaque store, which
    // the client seeds + maintains ENCRYPTED (createSelf via /records). The server
    // no longer creates or syncs a plaintext self-Contact here — doing so would mint
    // a plaintext straggler that blocks the born-encrypted drop.

    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
