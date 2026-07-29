const express = require('express');
const User = require('../models/User');
const Household = require('../models/Household');
const Person = require('../models/Person');
const { requireAuth } = require('../middleware/auth');
const { pickRecordEnc } = require('../services/householdKey');
const { stripSealedContent } = require('../services/e2eePolicy');
const { normalizePhone } = require('../services/phone');

const router = express.Router();
router.use(requireAuth);

// Settings shared across the household vs. personal to the user account.
// aboutMe (notes) now lives on the user's self Person record,
// managed from the People page — not here. Notifications are no longer a global
// setting — alerts are configured per item and delivered via push.
// timezone is personal: alerts fire at each member's own default alert hour
// (9am unless they change it — see dayAlertTime) in their own local zone, so a
// travelling or out-of-town member gets correct timing regardless of the
// household's default zone.
const SHARED   = ['homeAddress', 'groceryShoppingDay', 'groceryFrequency', 'groceryAnchor', 'grocerySections', 'reminderLeadDays'];
// aiEnabled mirrors the device's AI consent toggle (middleware/aiConsent.js).
// dayAlertTime is the personal `HH:mm` default day-based alerts fire at (see
// User.dayAlertTime); validated + normalized below.
const PERSONAL = ['firstName', 'lastName', 'birthday', 'timezone', 'phone', 'aiEnabled', 'dayAlertTime'];

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
    // shared (household)
    homeAddress: hh.homeAddress,
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

    // Signal-parity C3b: the self-Person lives in the unified opaque store, which
    // the client seeds + maintains ENCRYPTED (createSelf via /records). The server
    // no longer creates or syncs a plaintext self-Person here — doing so would mint
    // a plaintext straggler that blocks the born-encrypted drop.

    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
