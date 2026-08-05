// Admin surface for monetization config. Consumed by the separate admin web app
// and gated to admin users (requireAuth + requireAdmin).
//
//   GET  /api/monetization-config            → full config singleton
//   PUT  /api/monetization-config            → replace editable sections
//   GET  /api/monetization-config/households → list households + usage (analytics)
//   GET  /api/monetization-config/users      → per-user unlock state + credit balance
//   POST /api/monetization-config/unlock     → manually grant/revoke a user's app unlock
//   POST /api/monetization-config/credits    → manually adjust a user's credit balance
//   GET  /api/monetization-config/reconciliation → debited revenue vs estimated provider cost

const express = require('express');
const MonetizationConfig = require('../models/MonetizationConfig');
const Household = require('../models/Household');
const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');
const credits = require('../services/credits');
const AuditLog = require('../models/AuditLog');
const { invalidateConfigCache, currentPeriodKey, periodWindow } = require('../middleware/usageMeter');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const EDITABLE = ['credits', 'unlock', 'aiPlan', 'costs', 'models', 'guards', 'admin', 'addons'];

// The config is the live economy — refuse obviously broken numbers server-side
// too (the admin UI validates first; this is the backstop).
function validateConfig(body) {
  const errors = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const c = body.credits;
  if (c) {
    if (c.margin !== undefined && (!num(c.margin) || c.margin <= 0)) errors.push('credits.margin must be > 0');
    // Chat token-pricing knobs: Apple's cut in [0, 1); the chat markup in [1, 1.5].
    if (c.appleFeePct !== undefined && (!num(c.appleFeePct) || c.appleFeePct < 0 || c.appleFeePct >= 1)) errors.push('credits.appleFeePct must be ≥ 0 and < 1');
    if (c.chatMargin !== undefined && (!num(c.chatMargin) || c.chatMargin < 1 || c.chatMargin > 1.5)) errors.push('credits.chatMargin must be between 1.0 and 1.5');
    if (c.callRatePerMinute !== undefined && (!num(c.callRatePerMinute) || c.callRatePerMinute < 0)) errors.push('credits.callRatePerMinute must be ≥ 0');
    if (c.starterCredits !== undefined && (!Number.isInteger(c.starterCredits) || c.starterCredits < 0)) errors.push('credits.starterCredits must be an integer ≥ 0');
    // Token rates are per-type objects ($/1M for input/output/cacheRead/
    // cacheWrite). Bare numbers (the legacy blended shape) are rejected on
    // write so the stored doc converges on the per-type shape.
    for (const [fam, rate] of Object.entries(c.tokenRatesPer1M || {})) {
      if (!rate || typeof rate !== 'object') {
        errors.push(`credits.tokenRatesPer1M.${fam} must be an object with input/output/cacheRead/cacheWrite rates`);
        continue;
      }
      for (const type of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (!num(rate[type]) || rate[type] < 0) errors.push(`credits.tokenRatesPer1M.${fam}.${type} must be ≥ 0`);
      }
    }
    for (const [pid, pack] of Object.entries(c.packs || {})) {
      if (!num(pack?.price) || pack.price < 0) errors.push(`credits.packs.${pid}.price must be ≥ 0`);
      if (!Number.isInteger(pack?.credits) || pack.credits <= 0) errors.push(`credits.packs.${pid}.credits must be an integer > 0`);
    }
    for (const [action, price] of Object.entries(c.actionCosts || {})) {
      if (!Number.isInteger(price) || price < 0) errors.push(`credits.actionCosts.${action} must be an integer ≥ 0`);
    }
  }
  if (body.unlock?.price !== undefined && (!num(body.unlock.price) || body.unlock.price < 0)) {
    errors.push('unlock.price must be ≥ 0');
  }
  const p = body.aiPlan;
  if (p) {
    if (p.price !== undefined && (!num(p.price) || p.price < 0)) errors.push('aiPlan.price must be ≥ 0');
    if (p.monthlyCredits !== undefined && (!Number.isInteger(p.monthlyCredits) || p.monthlyCredits < 0)) {
      errors.push('aiPlan.monthlyCredits must be an integer ≥ 0');
    }
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
    const households = await Household.find({}, 'name ownerId e2eeActive createdAt').lean();
    const members = await User.find(
      { householdId: { $in: households.map((h) => h._id) } },
      'email firstName lastName role householdId appUnlocked creditBalanceMc addons'
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
          // What this household can USE: ownership is per-member (User.addons),
          // and any one member's purchase unlocks the lane for everyone — so the
          // household's effective set is the union, exactly as the app computes it.
          addons: [...new Set(hhMembers.flatMap((m) => m.addons || []))],
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
            // Which member actually paid — the household row above shows the
            // union, this shows who it came from.
            addons: m.addons || [],
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
// `addons` is what this user OWNS — since ownership moved to User.addons this
// column finally answers "who actually paid for what", where it previously
// mirrored the household's set onto every member and so couldn't distinguish a
// buyer from someone who merely lives with one. (The household-wide set they can
// USE is the union, shown on the /households rows.)
router.get('/users', async (_req, res) => {
  try {
    const users = await User.find({}, 'email firstName lastName householdId role appUnlocked appUnlockedAt creditBalanceMc revenueCatId addons createdAt').lean();
    res.json(users.map((u) => ({
      _id: u._id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' '),
      email: u.email,
      role: u.role || 'user',
      householdId: u.householdId || null,
      appUnlocked: !!u.appUnlocked,
      appUnlockedAt: u.appUnlockedAt || null,
      addons: u.addons || [],
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

// Margin reconciliation for a weekly analytics window: the credits actually
// DEBITED (flat per-action prices, summed from the usage ledger) against the
// raw PROVIDER cost (the token/call cost counters recordTokens /
// recordCallSecondsById maintain from the per-type `tokenRatesPer1M` /
// `callRatePerMinute`). This is the check that keeps `credits.actionCosts`
// honest once real spend exists: marginMultiple ≈ 2.0 means the flat prices
// hold the target margin. Chat's slice runs near its chatMargin (~1.0×
// after Apple) by construction — its debit is computed from the same
// per-type rates the cost counters use.
// All Mc figures are millicredits (Mc / 100000 = $ at the 1-credit-=-$0.01
// unit); `?period=YYYY-MM-DD` targets a past window (default: current).
router.get('/reconciliation', async (req, res) => {
  try {
    if (req.query.period !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(req.query.period)) {
      return res.status(400).json({ error: 'Invalid period (expected YYYY-MM-DD)' });
    }
    const period = req.query.period || currentPeriodKey();
    const window = periodWindow(period);
    if (!window) return res.status(400).json({ error: 'Invalid period' });

    // Revenue side: every usage debit in the window, grouped by action.
    const debits = await CreditLedger.aggregate([
      { $match: { kind: 'usage', createdAt: { $gte: window.start, $lt: window.end } } },
      { $group: { _id: '$action', mc: { $sum: { $subtract: [0, '$deltaMc'] } }, count: { $sum: 1 } } },
    ]);
    const revenueByAction = {};
    let revenueMc = 0;
    for (const d of debits) {
      revenueByAction[d._id || 'unknown'] = { mc: d.mc, count: d.count };
      revenueMc += d.mc;
    }

    // Cost side: the margin-free provider-cost counters, summed across users.
    // Small fleet — project the period subdocs and sum in JS (the keys are
    // dynamic period dates, which Mongo aggregation handles awkwardly).
    const users = await User.find(
      { $or: [
        { [`usageTokens.${period}`]: { $exists: true } },
        { [`usageCallSeconds.${period}`]: { $exists: true } },
        { [`usageWebSearches.${period}`]: { $exists: true } },
      ] },
      { [`usageTokens.${period}`]: 1, [`usageCallSeconds.${period}`]: 1, [`usageWebSearches.${period}`]: 1 }
    ).lean();
    let tokenCostMc = 0;
    let callCostMc = 0;
    let webSearchCostMc = 0;
    let tokens = 0;
    let callSeconds = 0;
    let webSearchCount = 0;
    const costByAction = {};
    for (const u of users) {
      const t = u.usageTokens?.[period] || {};
      tokenCostMc += t.costMc || 0;
      tokens += t.tokens || 0;
      for (const [action, mc] of Object.entries(t.byActionCostMc || {})) {
        costByAction[action] = (costByAction[action] || 0) + mc;
      }
      const c = u.usageCallSeconds?.[period] || {};
      callCostMc += c.costMc || 0;
      callSeconds += c.seconds || 0;
      const w = u.usageWebSearches?.[period] || {};
      webSearchCostMc += w.costMc || 0;
      webSearchCount += w.count || 0;
    }
    if (callCostMc > 0) costByAction.call = (costByAction.call || 0) + callCostMc;
    if (webSearchCostMc > 0) costByAction.webSearch = (costByAction.webSearch || 0) + webSearchCostMc;
    const costMc = tokenCostMc + callCostMc + webSearchCostMc;

    res.json({
      period,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      revenue: { mc: revenueMc, dollars: revenueMc / 100000, byAction: revenueByAction },
      cost: { mc: costMc, dollars: costMc / 100000, tokens, callSeconds, webSearches: webSearchCount, byAction: costByAction },
      marginMultiple: costMc > 0 ? Number((revenueMc / costMc).toFixed(2)) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
