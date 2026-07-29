// Credit-balance enforcement for cost-bearing AI actions.
//
// Usage:
//   router.post('/from-photo', meter('scan'), upload.single('photo'), handler)
//
// Runs AFTER requireAuth (so req.user / req.household are set). For each action:
//   1. If the caller's prepaid credit balance (User.creditBalanceMc) is at/below
//      zero → 402 CREDITS_EXHAUSTED with a buy-a-pack payload.
//   2. Otherwise let the request proceed; on a 2xx response, atomically $inc the
//      per-action analytics counters, and record the call's token cost as a
//      credit debit once the Claude call returns (recordTokens).
//
// A call's cost is only known AFTER it runs, so this is a pre-check on the
// balance: the last call may overdraw slightly (balance can dip negative), and
// the NEXT call is blocked. Exempt admins (adminUnlimited) skip the pre-check
// but are still tracked and debited.
//
// Config is cached in-process for a short TTL so admin-app edits take effect
// quickly without a DB read on every request.

const User = require('../models/User');
const MonetizationConfig = require('../models/MonetizationConfig');
const credits = require('../services/credits');

const CONFIG_TTL_MS = 30 * 1000;

let cached = null;
let cachedAt = 0;

async function getConfig() {
  const now = Date.now();
  if (cached && now - cachedAt < CONFIG_TTL_MS) return cached;
  cached = (await MonetizationConfig.getSingleton()).toObject();
  cachedAt = now;
  return cached;
}

// Allow callers (e.g. the config PUT route) to drop the cache after a write.
function invalidateConfigCache() {
  cached = null;
  cachedAt = 0;
}

// Usage ANALYTICS windows reset weekly, every Wednesday at 5:00 PM
// America/New_York (Eastern) — a fixed instant for all users worldwide. Nothing
// is enforced against the window anymore (enforcement is the credit balance);
// it keys the "this week" feature breakdown and admin analytics. The reset
// weekday/hour is defined in Eastern and stays put across ET DST changes.
const RESET_ZONE = 'America/New_York';
const RESET_WEEKDAY = 3; // 0=Sun … 3=Wed
const RESET_HOUR = 17;   // 5PM

// Wall-clock components of `date` in the reset zone.
function zoneParts(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: RESET_ZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour); // some ICU builds emit '24' for midnight
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour, minute: Number(p.minute) };
}

// UTC instant (Date) for a given wall-clock time in the reset zone. Anchored at
// 5PM, far from the 2AM DST boundary, so the single offset lookup is exact.
function zoneWallToInstant(year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const seen = zoneParts(new Date(guess));
  const asIfUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  const offsetMs = asIfUTC - guess; // zone = UTC + offset
  return new Date(guess - offsetMs);
}

// ISO date (in the reset zone) of the Wednesday that opened the current window.
function currentPeriodKey(d = new Date()) {
  const p = zoneParts(d);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  let daysBack = (weekday - RESET_WEEKDAY + 7) % 7; // days since the most recent Wednesday
  if (weekday === RESET_WEEKDAY && p.hour < RESET_HOUR) daysBack = 7; // before today's 5PM → last week's window
  const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day - daysBack));
  return anchor.toISOString().slice(0, 10);
}

// The next reset instant (first Wednesday 5PM ET strictly at/after `d`).
function nextPeriodResetAt(d = new Date()) {
  const p = zoneParts(d);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  let daysAhead = (RESET_WEEKDAY - weekday + 7) % 7; // days until the next Wednesday
  if (daysAhead === 0 && p.hour >= RESET_HOUR) daysAhead = 7; // today's 5PM already passed
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + daysAhead));
  return zoneWallToInstant(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), RESET_HOUR);
}

// Whether this caller is exempt from credit-balance enforcement. Admin accounts
// get unlimited AI only while the admin-config toggle allows it
// (`admin.unlimitedAi`, default true) — set it false in the admin app to meter
// admins like everyone else. Usage is still tracked and debited regardless;
// this only controls the pre-check block.
function adminUnlimited(config, user) {
  return user?.role === 'admin' && config?.admin?.unlimitedAi !== false;
}

// The caller's credit standing, shared by the meter pre-checks and the
// billing-status payload. `balance` is whole credits (floored; may be negative
// after a refund — clients floor display at 0).
function creditStatus(user, config) {
  const balanceMc = user?.creditBalanceMc ?? 0;
  const balance = Math.floor(balanceMc / credits.MC_PER_CREDIT);
  const unlimited = adminUnlimited(config, user);
  const threshold = Number(config?.credits?.lowBalanceThreshold) || 0;
  return {
    balanceMc,
    balance,
    unlimited,
    exhausted: !unlimited && balanceMc <= 0,
    low: !unlimited && balance <= threshold,
  };
}

// Per-action usage map for a period from a User or Household doc (for the
// billing-status "By feature" display). Drops the `breakdown` analytics
// sub-object; it isn't a display bucket.
function periodUsage(doc, period) {
  const raw = doc?.usage?.[period] || {};
  const out = {};
  for (const [action, count] of Object.entries(raw)) {
    if (action === 'breakdown') continue;
    out[action] = count;
  }
  return out;
}

// ── Token recording (analytics counters + credit debit) ──────────────────────
// Total tokens an API response consumed: input + output + cache read + write.
// This is the literal "tokens used" the app shows and prices into credits.
function totalTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

// Bump the weekly token counter by explicit id and debit the user's credit
// balance for the call's cost (tokens × model rate × margin). Per-USER only —
// AI usage, calls, and credits are individual concerns; household-level
// counters were retired with the per-user billing restructure (fleet analytics
// sum the user counters). `action` gets a per-action token split for
// analytics; `model` picks the credit rate. Fire-and-forget; returns the
// token count.
function bumpTokenCounters({ userId, tokens, action = null, model = null }) {
  if (!tokens) return 0;
  const period = currentPeriodKey();
  if (userId) {
    const inc = { [`usageTokens.${period}.tokens`]: tokens };
    if (action) inc[`usageTokens.${period}.byAction.${action}`] = tokens;
    User.updateOne({ _id: userId }, { $inc: inc })
      .catch((err) => console.error('[recordTokens] user inc failed:', err.message));
    getConfig()
      .then((config) => credits.debitUsageMc(userId, credits.tokenDebitMc(tokens, model, config)))
      .catch((err) => console.error('[recordTokens] credit debit failed:', err.message));
  }
  return tokens;
}

// Record tokens an AI call consumed. Used by the in-request path (patched
// Anthropic client / chat stream), so it reads the scope off `req`. Returns the
// token count so handlers can echo `tokensUsed`.
async function recordTokens(req, usage, action = null, model = null) {
  return bumpTokenCounters({
    userId: req.user?._id,
    tokens: totalTokens(usage),
    action,
    model,
  });
}

// ── Call-time recording ──────────────────────────────────────────────────────
// Phone calls are billed by Vapi per-minute (STT + TTS + telephony dominate; the
// LLM tokens are a rounding error), so connected seconds are priced into credits
// at the call rate rather than the token rate.

// Record connected call seconds on the per-user counter and debit the user's
// credit balance for the call's cost. Keyed by explicit id — phone calls
// settle during a lazy refresh with no `req` in scope. Fire-and-forget;
// returns the seconds recorded.
function recordCallSecondsById({ userId }, seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return 0;
  const period = currentPeriodKey();
  if (userId) {
    User.updateOne({ _id: userId }, { $inc: { [`usageCallSeconds.${period}.seconds`]: s } })
      .catch((err) => console.error('[recordCallSeconds] user inc failed:', err.message));
    getConfig()
      .then((config) => credits.debitUsageMc(userId, credits.callDebitMc(s, config)))
      .catch((err) => console.error('[recordCallSeconds] credit debit failed:', err.message));
  }
  return s;
}

// 402 payload for an exhausted balance, shared by meter() and
// meterCallSeconds(). Includes the pack catalog so the buy-credits sheet can
// render before the store loads.
function exhaustedPayload(action, status, config) {
  return {
    error: 'You’re out of AI credits. Buy a credit pack to continue.',
    code: 'CREDITS_EXHAUSTED',
    action,
    balance: status.balance,
    packs: credits.packsHint(config),
  };
}

// Count a refused request per user: repeated attempts after the block are the
// primary abuse signal the admin AI-usage view surfaces.
function countBlocked(user, action) {
  if (!user?._id) return;
  const period = currentPeriodKey();
  User.updateOne({ _id: user._id }, { $inc: { [`usageBlocked.${period}.${action}`]: 1 } })
    .catch((err) => console.error('[usageMeter] blocked-attempt inc failed:', err.message));
}

// `action` is the analytics bucket (chat/scan/generation/manualParse/aiHelper).
// Optional `surface` records a finer-grained analytics label (e.g. which chat
// surface) under a separate `breakdown` path — additive only, it never affects
// enforcement.
function meter(action, surface = null) {
  return async function usageMeter(req, res, next) {
    try {
      const user = req.user;
      const config = await getConfig();
      const period = currentPeriodKey();

      // Pre-check the prepaid balance (see file header: last call may overdraw;
      // the NEXT one is blocked). Exempt admins skip the block, not the debit.
      const status = creditStatus(user, config);
      if (status.exhausted) {
        countBlocked(user, action);
        return res.status(402).json(exhaustedPayload(action, status, config));
      }

      // Increment the per-action COUNT on success (analytics only). Credit cost
      // is debited separately by recordTokens() once the Claude call returns,
      // since token cost is known only after it runs.
      res.on('finish', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        // Per-user counter: drives the Credits screen's "By feature" display
        // AND fleet admin analytics (which sum the user counters). Household
        // counters were retired — AI usage/credits are per-user concerns.
        if (user?._id) {
          const inc = { [`usage.${period}.${action}`]: 1 };
          // Finer-grained surface, when provided, so the admin app can break
          // "chat" down by feature area (periodUsage() skips `breakdown`).
          if (surface) inc[`usage.${period}.breakdown.${action}.${surface}`] = 1;
          User.updateOne({ _id: user._id }, { $inc: inc })
            .catch((err) => console.error('[usageMeter] user increment failed:', err.message));
        }
      });

      // Auto-attach the tokens this request consumed to JSON responses, so the
      // one-shot AI endpoints report `tokensUsed` without per-handler edits.
      const { withMeter, meteredTokens } = require('../services/aiUsage');
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (body && typeof body === 'object' && !Array.isArray(body)
            && body.tokensUsed === undefined && meteredTokens() > 0) {
          body.tokensUsed = meteredTokens();
        }
        return origJson(body);
      };
      // Run the rest of the request inside a metering context so the patched
      // Anthropic client records token usage for every AI call it makes.
      withMeter(req, action, () => next());
    } catch (err) {
      console.error('[usageMeter] error:', err.message);
      // Fail open: never let a metering bug take down a feature.
      next();
    }
  };
}

// Pre-check the credit balance before placing an assistant phone call, and count
// the placement on success. A call must be affordable up front — the balance has
// to cover at least ONE MINUTE at the call rate (calls can't be stopped
// mid-sentence when the balance hits zero, so we demand a sensible floor). The
// seconds a call actually consumes are debited later, when Vapi reports its
// duration (services/phoneCalls → recordCallSecondsById). Used on the direct
// call-placement routes; the chat call_business tool pre-checks inline.
function meterCallSeconds() {
  return async function guard(req, res, next) {
    try {
      const config = await getConfig();
      const status = creditStatus(req.user, config);
      const floorMc = credits.callDebitMc(60, config);
      if (!status.unlimited && status.balanceMc < floorMc) {
        countBlocked(req.user, 'call');
        return res.status(402).json(exhaustedPayload('call', status, config));
      }
      // Count the placement on a 2xx (analytics; same shape as meter()'s counter).
      res.on('finish', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        const period = currentPeriodKey();
        if (req.user?._id) {
          User.updateOne({ _id: req.user._id }, { $inc: { [`usage.${period}.call`]: 1 } })
            .catch((err) => console.error('[meterCallSeconds] user increment failed:', err.message));
        }
      });
      next();
    } catch (err) {
      console.error('[meterCallSeconds] error:', err.message);
      next(); // fail open — never let a metering bug block a call
    }
  };
}

// In-process daily abuse guard for the Google Maps endpoints. Maps is a
// fundamental feature (not credit-metered), so this is NOT a product limit —
// just a runaway-cost backstop keyed per household per UTC day. In-memory is
// fine for a backstop; on multi-instance deploys swap for a shared store.
const mapsHits = new Map(); // `${householdId}:${day}` -> count

function mapsGuard() {
  return async function guard(req, res, next) {
    try {
      const config = await getConfig();
      const max = config.guards?.mapsPerDay;
      if (!max || max <= 0) return next(); // 0 / unset = disabled
      const day = new Date().toISOString().slice(0, 10);
      const key = `${req.household?._id || req.user?._id || req.ip}:${day}`;
      const n = (mapsHits.get(key) || 0) + 1;
      mapsHits.set(key, n);
      if (n > max) {
        return res.status(429).json({ error: 'Daily location-search limit reached. Please try again tomorrow.' });
      }
      next();
    } catch {
      next(); // fail open
    }
  };
}

// Periodically drop stale day-keys so the map can't grow unbounded.
const mapsSweep = setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const key of mapsHits.keys()) if (!key.endsWith(today)) mapsHits.delete(key);
}, 60 * 60 * 1000);
if (typeof mapsSweep.unref === 'function') mapsSweep.unref();

module.exports = {
  meter, mapsGuard, getConfig, invalidateConfigCache, currentPeriodKey, nextPeriodResetAt,
  adminUnlimited, creditStatus, periodUsage,
  // Token recording
  recordTokens, totalTokens, bumpTokenCounters,
  // Call-time recording
  meterCallSeconds, recordCallSecondsById,
};
