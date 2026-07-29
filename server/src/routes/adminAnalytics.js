// Admin analytics: content-blind product-usage insights for the admin web app.
// Everything here is metadata only (counts, timestamps, platforms) — no
// household content, so it holds up under E2EE. Gated requireAuth + requireAdmin.
//
//   GET /api/admin/analytics/overview            → headline engagement + growth
//   GET /api/admin/analytics/growth?weeks=12     → weekly new users + households
//   GET /api/admin/analytics/platforms           → platform + version distribution
//   GET /api/admin/analytics/usage?weeks=8        → fleet AI-usage series + chat surfaces
//   GET /api/admin/analytics/activity?weeks=8     → fleet feature-activity + adoption
//   GET /api/admin/analytics/retention?weeks=8    → still-active by signup cohort
//   GET /api/admin/analytics/tokens?weeks=8       → per-user token + call-time usage + abuse flags

const express = require('express');
const User = require('../models/User');
const Household = require('../models/Household');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  currentPeriodKey, nextPeriodResetAt,
} = require('../middleware/usageMeter');
const { MC_PER_CREDIT } = require('../services/credits');
const {
  AI_ACTIONS, ACTIVITY_ACTIONS,
  activeCounts, weeklyGrowth, rollupByPeriod, toSeries,
  chatSurfaceTotals, adoption, distribution, cohortRetention,
  periodKeysBack, tokenSeries, blockedCount, abuseFlags,
} = require('./adminAnalyticsHelpers');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const clampWeeks = (v, def) => Math.min(52, Math.max(1, Number.parseInt(v, 10) || def));
const MIN_APP_VERSION = () => process.env.E2EE_MIN_APP_VERSION || null;

// Headline numbers for the Overview page.
router.get('/overview', async (_req, res) => {
  try {
    const now = Date.now();
    const [users, households] = await Promise.all([
      User.find({}, 'createdAt lastActiveAt householdId appUnlocked').lean(),
      Household.find({}, 'createdAt').lean(),
    ]);

    const engagement = activeCounts(users.map((u) => u.lastActiveAt), { now });

    // Households with ≥1 member active in the last 7 days (a household-level WAU).
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const activeHouseholdIds = new Set(
      users.filter((u) => u.householdId && u.lastActiveAt && new Date(u.lastActiveAt).getTime() >= weekAgo)
        .map((u) => String(u.householdId))
    );

    const dayAgo = now - 24 * 60 * 60 * 1000;
    const newUsers7d = users.filter((u) => new Date(u.createdAt).getTime() >= weekAgo).length;
    const newHouseholds7d = households.filter((h) => new Date(h.createdAt).getTime() >= weekAgo).length;

    res.json({
      totals: {
        users: users.length,
        households: households.length,
        unlockedUsers: users.filter((u) => u.appUnlocked).length,
      },
      engagement,
      activeHouseholds7d: activeHouseholdIds.size,
      newUsers7d,
      newHouseholds7d,
      newUsers24h: users.filter((u) => new Date(u.createdAt).getTime() >= dayAgo).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/growth', async (req, res) => {
  try {
    const weeks = clampWeeks(req.query.weeks, 12);
    const now = Date.now();
    const [users, households] = await Promise.all([
      User.find({}, 'createdAt').lean(),
      Household.find({}, 'createdAt').lean(),
    ]);
    res.json({
      weeks,
      users: weeklyGrowth(users.map((u) => u.createdAt), { weeks, now }),
      households: weeklyGrowth(households.map((h) => h.createdAt), { weeks, now }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/platforms', async (_req, res) => {
  try {
    const users = await User.find({}, 'clientPlatform clientVersion').lean();
    const min = MIN_APP_VERSION();
    res.json({
      platforms: distribution(users.map((u) => u.clientPlatform)),
      versions: distribution(users.map((u) => u.clientVersion)),
      minAppVersion: min,
      reported: users.filter((u) => u.clientVersion).length,
      total: users.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fleet AI-usage series, summed from the per-USER counters — AI usage, calls,
// and credits are individual concerns, so nothing AI-related is tracked per
// household anymore (Household.usage is retired legacy data).
router.get('/usage', async (req, res) => {
  try {
    const weeks = clampWeeks(req.query.weeks, 8);
    const maps = (await User.find({}, 'usage').lean()).map((u) => u.usage || {});
    const perPeriod = rollupByPeriod(maps, { actions: AI_ACTIONS });
    res.json({
      actions: AI_ACTIONS,
      ...toSeries(perPeriod, AI_ACTIONS, { weeks }),
      chatBySurface: chatSurfaceTotals(maps),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/activity', async (req, res) => {
  try {
    const weeks = clampWeeks(req.query.weeks, 8);
    const maps = (await Household.find({}, 'activity').lean()).map((h) => h.activity || {});
    const perPeriod = rollupByPeriod(maps, { actions: ACTIVITY_ACTIONS });
    res.json({
      actions: ACTIVITY_ACTIONS,
      ...toSeries(perPeriod, ACTIVITY_ACTIONS, { weeks }),
      adoption: adoption(maps, ACTIVITY_ACTIONS),
      households: maps.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-user token consumption + abuse signals for the AI-usage page. Tokens are
// counted per USER (recordTokens always bumps the user counter); the enforced
// budget is the prepaid credit balance shown alongside. Content-blind like
// everything here: token counts, never prompt contents.
router.get('/tokens', async (req, res) => {
  try {
    const weeks = clampWeeks(req.query.weeks, 8);
    const period = currentPeriodKey();
    const periods = periodKeysBack(period, weeks);

    const [users, households] = await Promise.all([
      User.find({}, 'email firstName lastName householdId lastActiveAt usageTokens usageBlocked usageCallSeconds creditBalanceMc appUnlocked').lean(),
      Household.find({}, 'name').lean(),
    ]);
    const hhById = Object.fromEntries(households.map((h) => [String(h._id), h]));

    const items = users.map((u) => {
      const hh = u.householdId ? hhById[String(u.householdId)] || null : null;
      const series = tokenSeries(u.usageTokens, periods);
      const blocked = blockedCount(u.usageBlocked, period);
      const callSeconds = u.usageCallSeconds?.[period]?.seconds || 0;
      const creditBalance = Math.floor((u.creditBalanceMc || 0) / MC_PER_CREDIT);
      return {
        _id: u._id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' '),
        householdName: hh?.name || null,
        lastActiveAt: u.lastActiveAt || null,
        tokens: series.at(-1) || 0,      // this user's own tokens, this period
        totalTokens: series.reduce((a, b) => a + b, 0),
        series,
        creditBalance,                   // may be negative after a refund
        appUnlocked: !!u.appUnlocked,
        callSeconds,
        blocked,
        flags: abuseFlags({ series, blocked }),
      };
    }).sort((a, b) => b.tokens - a.tokens);

    res.json({
      period,
      resetAt: nextPeriodResetAt(),
      periods,
      items,
      fleet: {
        tokensThisPeriod: items.reduce((n, r) => n + r.tokens, 0),
        callSecondsThisPeriod: items.reduce((n, r) => n + r.callSeconds, 0),
        blockedThisPeriod: items.reduce((n, r) => n + r.blocked, 0),
        flaggedUsers: items.filter((r) => r.flags.length).length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/retention', async (req, res) => {
  try {
    const weeks = clampWeeks(req.query.weeks, 8);
    const users = await User.find({}, 'createdAt lastActiveAt').lean();
    res.json({ weeks, cohorts: cohortRetention(users, { weeks, now: Date.now() }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
