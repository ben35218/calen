// Monetization endpoints: the per-user $4.99 app unlock, the prepaid AI-credit
// balance (packs + the optional monthly Calen AI plan), and the household's
// one-time feature-calendar add-ons.
//   GET  /api/billing/status          → unlock state, credit balance, packs, usage, add-ons (any user)
//   GET  /api/billing/credits/ledger  → the caller's credit purchase/grant history
//   POST /api/billing/webhook         → RevenueCat purchase events (no auth; shared secret)
//   POST /api/billing/addons/claim    → claim a FREE add-on (price-0 catalog item; any member)
//   POST /api/billing/addons {addons} → manual add-on override (admin only)
//
// Real payments flow through native in-app purchase (App Store / Play) →
// RevenueCat → the webhook below. RevenueCat's app_user_id is the USER id (the
// mobile app logs the RC SDK in as the signed-in user), so the unlock and
// credit packs land on the purchasing user; feature-calendar add-ons resolve
// user → household and stay household-wide.

const express = require('express');
const mongoose = require('mongoose');
const Household = require('../models/Household');
const User = require('../models/User');
const PhoneCall = require('../models/PhoneCall');
const CreditLedger = require('../models/CreditLedger');
const MonetizationConfig = require('../models/MonetizationConfig');
const credits = require('../services/credits');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getConfig, currentPeriodKey, nextPeriodResetAt, periodUsage, creditStatus } = require('../middleware/usageMeter');

const router = express.Router();

// --- RevenueCat webhook (must be BEFORE requireAuth; authenticated by a shared
// secret RevenueCat sends in the Authorization header). ---

// The RevenueCat entitlement granted by the app-unlock non-consumable.
const UNLOCK_ENTITLEMENT = 'app_unlock';

// Map RevenueCat entitlement identifiers → feature-calendar add-on keys
// (calendar ids, stored in Household.addons). The bundle product is attached to
// all three entitlements in the RevenueCat dashboard, so a bundle purchase
// event carries all three ids — the server has no bundle concept of its own.
// (Birthdays was briefly an add-on pre-release, then made free 2026-07-26.)
const ENTITLEMENT_TO_ADDON = {
  addon_meals: 'recipes',
  addon_maintenance: 'maintenance',
  addon_trips: 'trips',
};

// Event types that grant a one-time purchase. Everything else is either a
// revoke (refund/expiration) or lifecycle noise.
const GRANT_TYPES = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'UNCANCELLATION', 'TRANSFER'];

function isRefund(event) {
  return event.type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT';
}

// Decide what a webhook event does to the user's app unlock. Returns
// { unlocked: true|false|null } — null = event doesn't touch the unlock. The
// unlock is matched by entitlement (with a product-id fallback so a dashboard
// misconfiguration can't silently drop purchases). Pure — exported for tests.
function unlockUpdateForEvent(event, config) {
  const ids = event.entitlement_ids || [];
  const touches = ids.includes(UNLOCK_ENTITLEMENT)
    || (event.product_id && event.product_id === (config?.unlock?.productId || 'app_unlock_499'));
  if (!touches) return { unlocked: null };
  if (GRANT_TYPES.includes(event.type)) return { unlocked: true };
  // A refund revokes; EXPIRATION handled defensively (shouldn't occur for a
  // non-consumable).
  if (isRefund(event) || event.type === 'EXPIRATION') return { unlocked: false };
  return { unlocked: null };
}

// Decide what a webhook event does to the user's credit balance. Consumable
// packs carry NO entitlement — they're matched by product id against the pack
// catalog. Returns { deltaMc, kind, productId, transactionId } or null. The
// transactionId (store txn id, falling back to the RC event id) is the ledger's
// idempotency key; a refund gets a ':refund' suffix so it dedupes independently
// of its purchase. Pure — exported for tests.
function creditUpdateForEvent(event, config) {
  const pack = credits.packForProduct(event.product_id, config);
  if (!pack) return null;
  const txn = event.transaction_id || event.id;
  const deltaMc = Math.round(pack.credits * credits.MC_PER_CREDIT);
  if (GRANT_TYPES.includes(event.type)) {
    return { deltaMc, kind: 'purchase', productId: pack.productId, transactionId: txn };
  }
  if (isRefund(event)) {
    return { deltaMc: -deltaMc, kind: 'refund', productId: pack.productId, transactionId: `${txn}:refund` };
  }
  return null;
}

// Decide what a webhook event does to the user's monthly "Calen AI" plan
// (auto-renewable subscription, entitlement `calen_ai`). Each PAID period —
// INITIAL_PURCHASE and every RENEWAL — grants `aiPlan.monthlyCredits`,
// idempotent on the store transaction id (every renewal carries a fresh one).
// A refund claws the period's grant back (`<txn>:refund`) and deactivates;
// EXPIRATION deactivates without touching credits (granted credits are
// ordinary balance and survive); auto-renew toggles (CANCELLATION /
// UNCANCELLATION) and billing-grace noise change nothing until expiry.
// Returns { grant, active, expiresAt } or null when the event isn't the plan.
// Pure — exported for tests.
function planUpdateForEvent(event, config) {
  const plan = config?.aiPlan || {};
  const productId = plan.productId || 'calen_ai_monthly_499';
  const entitlement = plan.entitlement || 'calen_ai';
  const touches = (event.entitlement_ids || []).includes(entitlement)
    || (event.product_id && event.product_id === productId);
  if (!touches) return null;
  const txn = event.transaction_id || event.id;
  const deltaMc = Math.round((Number(plan.monthlyCredits) || 0) * credits.MC_PER_CREDIT);
  const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
  if (event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL') {
    return {
      grant: deltaMc > 0 ? { deltaMc, kind: 'plan', productId, transactionId: txn } : null,
      active: true,
      expiresAt,
    };
  }
  if (isRefund(event)) {
    return {
      grant: deltaMc > 0 ? { deltaMc: -deltaMc, kind: 'refund', productId, transactionId: `${txn}:refund` } : null,
      active: false,
      expiresAt,
    };
  }
  if (event.type === 'EXPIRATION') return { grant: null, active: false, expiresAt };
  if (event.type === 'UNCANCELLATION') return { grant: null, active: true, expiresAt };
  return { grant: null, active: null, expiresAt: null };
}

// Decide what a webhook event does to the household's one-time feature-calendar
// add-ons: `add`/`remove` are Household.addons keys. Add-ons are non-consumable
// (no renewal lifecycle) — a purchase-shaped event grants, a refund revokes
// (RevenueCat sends CANCELLATION with cancel_reason CUSTOMER_SUPPORT for
// refunded one-time purchases; EXPIRATION is handled defensively). Pure —
// exported for tests.
function addonUpdateForEvent(event) {
  const keys = (event.entitlement_ids || []).map((e) => ENTITLEMENT_TO_ADDON[e]).filter(Boolean);
  if (!keys.length) return { add: [], remove: [] };
  if (isRefund(event) || event.type === 'EXPIRATION') return { add: [], remove: keys };
  // Non-grant lifecycle noise (auto-renew toggles, billing issues) never touches
  // a one-time purchase.
  if (event.type === 'CANCELLATION' || event.type === 'BILLING_ISSUE' || event.type === 'SUBSCRIPTION_PAUSED') {
    return { add: [], remove: [] };
  }
  // Grant-shaped events: NON_RENEWING_PURCHASE, INITIAL_PURCHASE,
  // UNCANCELLATION, TRANSFER, …
  return { add: keys, remove: [] };
}

// Resolve the webhook's app_user_id to a user. Matches the stored revenueCatId
// first (covers aliased/anonymous ids RC may send) and falls back to the raw
// user id the mobile app logs in with.
async function userForAppUserId(appUserId) {
  const or = [{ revenueCatId: appUserId }];
  if (mongoose.isValidObjectId(appUserId)) or.push({ _id: appUserId });
  return User.findOne({ $or: or }).catch(() => null);
}

router.post('/webhook', async (req, res) => {
  try {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!secret || provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body?.event;
    if (!event) return res.status(400).json({ error: 'Missing event' });

    const config = (await getConfig().catch(() => null)) || MonetizationConfig.DEFAULTS;

    // TRANSFER (Restore Purchases under a different account): RC moves the
    // store transactions between app_user_ids and sends only the id lists — no
    // entitlement/product fields — so it's handled before the partition. Move
    // the unlock flag from the losing user to the gaining one (consumed credit
    // packs and household add-ons stay where they were applied).
    if (event.type === 'TRANSFER') {
      const resolveFirst = async (ids) => {
        for (const id of ids || []) {
          const u = await userForAppUserId(id);
          if (u) return u;
        }
        return null;
      };
      const toUser = await resolveFirst(event.transferred_to);
      const fromUser = await resolveFirst(event.transferred_from);
      if (!toUser || (fromUser && String(fromUser._id) === String(toUser._id))) {
        return res.json({ ok: true, ignored: event.type, matched: Boolean(toUser) });
      }
      if (fromUser?.appUnlocked) {
        await User.updateOne({ _id: toUser._id }, {
          $set: {
            appUnlocked: true,
            appUnlockedAt: new Date(),
            ...(fromUser.unlockProductId ? { unlockProductId: fromUser.unlockProductId } : {}),
          },
        });
        await User.updateOne({ _id: fromUser._id }, { $set: { appUnlocked: false } });
      }
      return res.json({ ok: true, transferred: Boolean(fromUser?.appUnlocked) });
    }

    // Partition the event. The Calen AI plan is matched first (entitlement
    // `calen_ai` / its product id) so its subscription lifecycle can't leak
    // into the one-time paths; credit packs are matched by product id and
    // never fall through; the unlock and add-ons are matched by entitlement.
    // Anything left over — including legacy subscription-era
    // premium/unlimited events and their CANCELLATION/EXPIRATION tails — is
    // acked so RevenueCat doesn't retry.
    const plan = planUpdateForEvent(event, config);
    const credit = plan ? null : creditUpdateForEvent(event, config);
    const { unlocked } = plan || credit ? { unlocked: null } : unlockUpdateForEvent(event, config);
    const { add, remove } = plan || credit ? { add: [], remove: [] } : addonUpdateForEvent(event);
    if (!plan && !credit && unlocked === null && !add.length && !remove.length) {
      return res.json({ ok: true, ignored: event.type });
    }
    if (plan && !plan.grant && plan.active === null) {
      // Plan lifecycle noise (auto-renew toggles, billing grace): ack.
      return res.json({ ok: true, ignored: event.type });
    }

    // Only demand app_user_id when there's something to apply — ignorable
    // events without one must not 400 into RC's retry loop.
    const appUserId = event.app_user_id;
    if (!appUserId) return res.status(400).json({ error: 'Missing app_user_id' });

    const user = await userForAppUserId(appUserId);
    if (!user) {
      // Acknowledge so RevenueCat doesn't retry forever for unknown users
      // (includes legacy events keyed to a household id).
      return res.json({ ok: true, matched: false });
    }

    // Remember the RC identity that reached this user (aliases included).
    if (user.revenueCatId !== appUserId) {
      await User.updateOne({ _id: user._id }, { $set: { revenueCatId: appUserId } });
    }

    if (plan) {
      // Apply the plan state first (cheap, unconditional), then the period's
      // credit grant (idempotent — a re-delivered RENEWAL dedupes on the
      // transaction id without touching the balance).
      if (plan.active !== null) {
        await User.updateOne({ _id: user._id }, {
          $set: { aiPlanActive: plan.active, ...(plan.expiresAt ? { aiPlanExpiresAt: plan.expiresAt } : {}) },
        });
      }
      if (plan.grant) {
        const result = await CreditLedger.grant({ userId: user._id, ...plan.grant });
        if (result.duplicate) return res.json({ ok: true, plan: true, duplicate: true });
        return res.json({ ok: true, plan: true, credited: plan.grant.deltaMc / credits.MC_PER_CREDIT });
      }
      return res.json({ ok: true, plan: true, active: plan.active });
    }

    if (credit) {
      const result = await CreditLedger.grant({ userId: user._id, ...credit });
      if (result.duplicate) return res.json({ ok: true, duplicate: true });
      return res.json({ ok: true, credited: credit.deltaMc / credits.MC_PER_CREDIT });
    }

    if (unlocked !== null) {
      const set = unlocked
        ? { appUnlocked: true, appUnlockedAt: new Date(), ...(event.product_id ? { unlockProductId: event.product_id } : {}) }
        : { appUnlocked: false };
      await User.updateOne({ _id: user._id }, { $set: set });
    }

    if (add.length || remove.length) {
      if (!user.householdId) {
        // No household to grant into; ack (Restore after joining re-delivers).
        return res.json({ ok: true, unlocked, addons: false, matched: false });
      }
      const update = {};
      // add/remove are mutually exclusive by construction (a single event either
      // grants or revokes), so $addToSet and $pull never conflict on `addons`.
      if (add.length) update.$addToSet = { addons: { $each: add } };
      if (remove.length) update.$pull = { addons: { $in: remove } };
      await Household.updateOne({ _id: user.householdId }, update);
    }

    res.json({ ok: true, ...(unlocked !== null ? { unlocked } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const config = await getConfig();
    const period = currentPeriodKey();
    const standing = creditStatus(req.user, config);

    // Per-action counts for this user (analytics — the Credits screen's "By
    // feature" card). Enforcement is the credit balance, not these counts.
    const usage = periodUsage(req.user, period);

    // Assistant phone calls placed this week — a distinct AI feature surfaced as
    // its own "By feature" row (a placement COUNT from PhoneCall; the enforced
    // cost is the per-second credit debit). Period start = one week before the
    // next weekly reset.
    const periodStart = new Date(nextPeriodResetAt().getTime() - 7 * 24 * 60 * 60 * 1000);
    const callCount = await PhoneCall.countDocuments({
      userId: req.user._id,
      createdAt: { $gte: periodStart },
    }).catch(() => 0);
    const usageWithCalls = callCount > 0 ? { ...usage, call: callCount } : usage;

    res.json({
      // The per-user $4.99 app unlock (drives the hard paywall).
      unlocked: Boolean(req.user.appUnlocked),
      unlockPrice: config.unlock?.price ?? 4.99,
      // Prepaid credit balance. `creditBalance` is whole credits and may be
      // NEGATIVE after a refund (clients floor display at 0); `unlimited` means
      // an exempt admin (render "Unlimited", ignore the balance).
      creditBalance: standing.balance,
      creditBalanceMc: standing.balanceMc,
      lowBalance: standing.low,
      unlimited: standing.unlimited,
      // Credit-pack catalog (display fallbacks; the store's localized price is
      // authoritative whenever RC packages load).
      packs: credits.packsHint(config),
      // Flat published credit prices per action (whole credits;
      // `callPerMinute` prorates per second) — drives the "What things cost"
      // card and the pre-call cost hint. What the debits actually charge.
      actionCosts: config.credits?.actionCosts || {},
      // The optional monthly Calen AI plan (price is a display fallback; the
      // store's localized price is authoritative).
      aiPlan: {
        active: Boolean(req.user.aiPlanActive),
        productId: config.aiPlan?.productId || 'calen_ai_monthly_499',
        price: config.aiPlan?.price ?? 4.99,
        monthlyCredits: config.aiPlan?.monthlyCredits ?? 600,
        expiresAt: req.user.aiPlanExpiresAt || null,
      },
      // Per-action counts, always this user's own (analytics only).
      usage: usageWithCalls,
      usageScope: 'user',
      resetsAt: nextPeriodResetAt().toISOString(),
      models: config.models || {},
      hasHousehold: Boolean(req.household),
      // One-time feature-calendar add-ons owned by this household (calendar-id
      // keys). Clients gate the feature UIs on this — the record store is
      // opaque, so the server can't enforce per-feature data access itself.
      addons: req.household?.addons || [],
      // Display catalog for the Add-ons store screen. Prices are USD fallbacks;
      // the store's localized price wins whenever RC packages load.
      addonCatalog: {
        items: MonetizationConfig.ADDON_KEYS.map((key) => ({
          key,
          label: config.addons?.items?.[key]?.label || key,
          price: config.addons?.items?.[key]?.price ?? 2.99,
          description: config.addons?.items?.[key]?.description || '',
        })),
        bundle: {
          label: config.addons?.bundle?.label || 'All add-ons',
          price: config.addons?.bundle?.price ?? 7.99,
          description: config.addons?.bundle?.description || '',
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The caller's credit history: pack purchases, the starter grant, plan
// periods, refunds, admin adjustments AND usage debits (kind 'usage' + the
// action) — every balance movement has a row, so "where did my credits go?"
// is answerable from the app.
router.get('/credits/ledger', async (req, res) => {
  try {
    const rows = await CreditLedger.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({
      entries: rows.map((r) => ({
        kind: r.kind,
        credits: r.deltaMc / credits.MC_PER_CREDIT,
        productId: r.productId ?? null,
        action: r.action ?? null,
        note: r.note ?? null,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim a FREE add-on (catalog price 0 — Birthdays/Chores). Free add-ons are
// included with the app but opt-in: they are never default-granted, never sold
// through the store, and any member's claim unlocks them household-wide (same
// ledger as paid add-ons). Validating price === 0 against the catalog means a
// paid key can never be claimed for free.
router.post('/addons/claim', async (req, res) => {
  try {
    const { addon } = req.body;
    const config = await getConfig();
    const isFree = MonetizationConfig.ADDON_KEYS.includes(addon)
      && (config.addons?.items?.[addon]?.price ?? 1) === 0;
    if (!isFree) return res.status(400).json({ error: 'Not a free add-on' });
    if (!req.household) {
      return res.status(400).json({ error: 'Join or create a household first' });
    }
    await Household.updateOne({ _id: req.household._id }, { $addToSet: { addons: addon } });
    res.json({ addons: [...new Set([...(req.household.addons || []), addon])] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual add-on override (admin only). Real add-on purchases flow through the
// RevenueCat webhook; this is the QA/simulator escape hatch (store sandbox not
// available in dev builds). Replaces the whole owned set.
router.post('/addons', requireAdmin, async (req, res) => {
  try {
    const { addons } = req.body;
    if (!Array.isArray(addons) || addons.some((a) => !MonetizationConfig.ADDON_KEYS.includes(a))) {
      return res.status(400).json({ error: 'Invalid addons' });
    }
    if (!req.household) {
      return res.status(400).json({ error: 'Join or create a household first' });
    }
    await Household.updateOne({ _id: req.household._id }, { $set: { addons } });
    res.json({ addons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.unlockUpdateForEvent = unlockUpdateForEvent;
module.exports.creditUpdateForEvent = creditUpdateForEvent;
module.exports.addonUpdateForEvent = addonUpdateForEvent;
module.exports.planUpdateForEvent = planUpdateForEvent;
