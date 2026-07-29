// Admin surface for monetization config. Consumed by the separate admin web app
// and gated to admin users (requireAuth + requireAdmin).
//
//   GET  /api/monetization-config            → full config singleton
//   PUT  /api/monetization-config            → replace editable sections
//   GET  /api/monetization-config/households → list households + usage (analytics)
//   GET  /api/monetization-config/users      → per-user unlock state + credit balance
//   POST /api/monetization-config/unlock     → manually grant/revoke a user's app unlock
//   POST /api/monetization-config/credits    → manually adjust a user's credit balance

const express = require('express');
const MonetizationConfig = require('../models/MonetizationConfig');
const Household = require('../models/Household');
const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');
const credits = require('../services/credits');
const AuditLog = require('../models/AuditLog');
const { invalidateConfigCache } = require('../middleware/usageMeter');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const EDITABLE = ['credits', 'unlock', 'costs', 'models', 'guards', 'admin', 'addons'];

// The config is the live economy — refuse obviously broken numbers server-side
// too (the admin UI validates first; this is the backstop).
function validateConfig(body) {
  const errors = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const c = body.credits;
  if (c) {
    if (c.margin !== undefined && (!num(c.margin) || c.margin <= 0)) errors.push('credits.margin must be > 0');
    if (c.callRatePerMinute !== undefined && (!num(c.callRatePerMinute) || c.callRatePerMinute < 0)) errors.push('credits.callRatePerMinute must be ≥ 0');
    if (c.starterCredits !== undefined && (!Number.isInteger(c.starterCredits) || c.starterCredits < 0)) errors.push('credits.starterCredits must be an integer ≥ 0');
    for (const [fam, rate] of Object.entries(c.tokenRatesPer1M || {})) {
      if (!num(rate) || rate < 0) errors.push(`credits.tokenRatesPer1M.${fam} must be ≥ 0`);
    }
    for (const [pid, pack] of Object.entries(c.packs || {})) {
      if (!num(pack?.price) || pack.price < 0) errors.push(`credits.packs.${pid}.price must be ≥ 0`);
      if (!Number.isInteger(pack?.credits) || pack.credits <= 0) errors.push(`credits.packs.${pid}.credits must be an integer > 0`);
    }
  }
  if (body.unlock?.price !== undefined && (!num(body.unlock.price) || body.unlock.price < 0)) {
    errors.push('unlock.price must be ≥ 0');
  }
  for (const [k, v] of Object.entries(body.costs || {})) {
    if (!num(v) || v < 0) errors.push(`costs.${k} must be ≥ 0`);
  }
  return errors;
}

// Leaf-level diff of the editable sections, for the config_changed audit row.
// Values are recorded (prices/rates, never user content); capped for meta size.
function diffPaths(before, after, prefix = '', out = []) {
  if (out.length >= 40) return out;
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = before?.[k];
    const b = after?.[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') diffPaths(a, b, path, out);
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  return out;
}

router.get('/', async (_req, res) => {
  try {
    const doc = await MonetizationConfig.getSingleton();
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', async (req, res) => {
  try {
    const errors = validateConfig(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const doc = await MonetizationConfig.getSingleton();
    const before = JSON.parse(JSON.stringify(
      Object.fromEntries(EDITABLE.map((k) => [k, doc[k]]))
    ));
    for (const key of EDITABLE) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
      doc.markModified(key); // Mixed fields need explicit dirty marking.
    }
    await doc.save();
    invalidateConfigCache();

    // The highest-impact admin action there is — always leave an audit trail
    // of exactly which knobs moved.
    const after = Object.fromEntries(EDITABLE.map((k) => [k, doc[k]]));
    const changed = diffPaths(before, after);
    if (changed.length) {
      await AuditLog.create({
        userId: req.user._id,
        event: 'config_changed',
        meta: { changed },
      });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Households for the admin table: identity + membership + E2EE state. `name`
// is null for households that went E2EE-live at DROP_FIELDS v2+ (the name is
// sealed content — Signal-parity C2), so the payload carries the owner's email
// as a durable display handle. Members are listed with their per-user billing
// state (unlock/credits are per-USER; nothing AI-related is tracked per
// household anymore).
router.get('/households', async (_req, res) => {
  try {
    const households = await Household.find({}, 'name ownerId e2eeActive addons createdAt').lean();
    const members = await User.find(
      { householdId: { $in: households.map((h) => h._id) } },
      'email firstName lastName role householdId appUnlocked creditBalanceMc'
    ).lean();
    const byHh = {};
    for (const m of members) (byHh[String(m.householdId)] ||= []).push(m);

    res.json(
      households.map((h) => {
        const hhMembers = byHh[String(h._id)] || [];
        const owner = hhMembers.find((m) => String(m._id) === String(h.ownerId));
        return {
          _id: h._id,
          name: h.name || null,
          ownerEmail: owner?.email || null,
          e2eeActive: !!h.e2eeActive,
          addons: h.addons || [],
          createdAt: h.createdAt,
          memberCount: hhMembers.length,
          members: hhMembers.map((m) => ({
            _id: m._id,
            email: m.email,
            name: [m.firstName, m.lastName].filter(Boolean).join(' '),
            role: m.role || 'user',
            isOwner: String(m._id) === String(h.ownerId),
            appUnlocked: !!m.appUnlocked,
            creditBalance: Math.floor((m.creditBalanceMc || 0) / credits.MC_PER_CREDIT),
          })),
        };
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-user monetization state for the admin billing table: app-unlock status,
// credit balance, and how the state got there (webhook-linked vs manual).
// Add-ons are owned household-wide (Household.addons), so each user carries
// their household's owned set — "which users have which add-ons".
router.get('/users', async (_req, res) => {
  try {
    const users = await User.find({}, 'email firstName lastName householdId role appUnlocked appUnlockedAt creditBalanceMc revenueCatId createdAt').lean();
    const hhIds = [...new Set(users.filter((u) => u.householdId).map((u) => String(u.householdId)))];
    const hhAddons = await Household.find({ _id: { $in: hhIds } }, 'addons').lean();
    const addonsByHh = Object.fromEntries(hhAddons.map((h) => [String(h._id), h.addons || []]));
    res.json(users.map((u) => ({
      _id: u._id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' '),
      email: u.email,
      role: u.role || 'user',
      householdId: u.householdId || null,
      appUnlocked: !!u.appUnlocked,
      appUnlockedAt: u.appUnlockedAt || null,
      addons: u.householdId ? addonsByHh[String(u.householdId)] || [] : [],
      creditBalance: Math.floor((u.creditBalanceMc || 0) / credits.MC_PER_CREDIT),
      revenueCatId: u.revenueCatId || null,
      // Billing source: a RevenueCat mapping means store purchases drive the
      // state; otherwise anything granted came from a manual admin override.
      billingSource: u.revenueCatId ? 'revenuecat' : 'manual',
      createdAt: u.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually grant/revoke a user's app unlock (tester escape hatch — real
// unlocks flow through the RevenueCat webhook). Audited.
router.post('/unlock', async (req, res) => {
  try {
    const { userId, unlocked } = req.body;
    if (!userId || typeof unlocked !== 'boolean') {
      return res.status(400).json({ error: 'userId and unlocked (boolean) are required' });
    }
    const user = await User.findOneAndUpdate(
      { _id: userId },
      { $set: { appUnlocked: unlocked, ...(unlocked ? { appUnlockedAt: new Date() } : {}) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    await AuditLog.create({
      userId: req.user._id,
      householdId: user.householdId,
      event: 'unlock_changed',
      meta: { targetUserId: user._id, unlocked, source: 'admin_override' },
    });
    res.json({ _id: user._id, appUnlocked: user.appUnlocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually adjust a user's credit balance (support/testing escape hatch — real
// packs flow through the RevenueCat webhook). Ledgered (kind 'admin', no
// transactionId → intentionally not deduped) and audited.
router.post('/credits', async (req, res) => {
  try {
    const { userId, credits: creditDelta, note } = req.body;
    const delta = Number(creditDelta);
    if (!userId || !Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'userId and a non-zero credits amount are required' });
    }
    const user = await User.findById(userId).select('_id householdId');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = await CreditLedger.grant({
      userId: user._id,
      deltaMc: Math.round(delta * credits.MC_PER_CREDIT),
      kind: 'admin',
      note: note || undefined,
    });
    await AuditLog.create({
      userId: req.user._id,
      householdId: user.householdId,
      event: 'credits_adjusted',
      meta: { targetUserId: user._id, credits: delta, note: note || null, source: 'admin_override' },
    });
    res.json({
      _id: user._id,
      creditBalance: result.balanceMc != null ? Math.floor(result.balanceMc / credits.MC_PER_CREDIT) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
