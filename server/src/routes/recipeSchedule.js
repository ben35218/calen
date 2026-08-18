const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const RecipeSchedule = require('../models/RecipeSchedule');
const ShoppingSession = require('../models/ShoppingSession');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter } = require('../middleware/usageMeter');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { plaintextCreateBlocked, E2EE_REQUIRED_MESSAGE, stripSealedContent } = require('../services/e2eePolicy');
const { normalizeOrganizedList } = require('../services/groceryNames');

const client = new Anthropic();

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { start, end } = req.query;
    const filter = { ...req.scopeFilter };
    if (start || end) {
      filter.scheduledDate = {};
      if (start) filter.scheduledDate.$gte = new Date(start);
      if (end)   filter.scheduledDate.$lte = new Date(end);
    }
    const schedules = await RecipeSchedule.find(filter)
      .populate('recipeId')
      .sort('scheduledDate')
      .lean();
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /grocery-list was removed (Signal-parity D5): it aggregated
// Recipe.ingredients server-side, which is sealed content the server can't read
// post-drop. The client builds the week's grocery list itself over its decrypted
// recipes + schedules (mobile lib/groceryList.ts) and only the resulting item
// names reach the AI organize endpoint below (explicit consent, as before).

// The response spreads any legacy plaintext state at the top level (old builds
// read the body AS the state), with the sealed envelope + concurrency version
// riding along as extra keys new clients pick off. No session at all stays a
// bare `{}` for both generations.
router.get('/session', async (req, res) => {
  const { weekStart } = req.query;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  try {
    const session = await ShoppingSession.findOne({ ...req.scopeFilter, weekStart }).lean();
    if (!session) return res.json({});
    res.json({
      ...(session.state ?? {}),
      ...(session.enc ? { enc: session.enc, keyVersion: session.keyVersion } : {}),
      version: session.version ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Two write generations during the sealing transition:
// - Current builds send `enc` (+`keyVersion`) and `baseVersion`; the write is
//   accepted only against the version the client read (atomic version-predicate
//   findOneAndUpdate + $inc — never read-then-write) and clears the legacy
//   plaintext `state`. A mismatch is a 409 carrying the current version; the
//   client re-fetches, merges on-device, and retries.
// - Old builds send plaintext `state` with no baseVersion: accepted as before
//   (last-write-wins), clearing `enc` so newer readers see the newest write
//   instead of a stale sealed blob. This lane is a documented transition
//   exception (spec: features/kitchen.md) and tightens after rollout.
// The server never reads inside either blob.
router.put('/session', async (req, res) => {
  const { weekStart, state, baseVersion } = req.body;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  let sealed = null;
  if (req.body.enc != null) {
    try { sealed = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
  }
  const update = {
    ...(sealed
      ? { $set: sealed, $unset: { state: 1 } }
      : { $set: { state }, $unset: { enc: 1, keyVersion: 1 } }),
    $inc: { version: 1 },
    // The scope clause is all operators ($or/$in), so the upsert can't derive
    // any doc fields from the filter — seed the routing explicitly.
    $setOnInsert: { userId: req.user._id, householdId: req.household?._id },
  };
  try {
    if (typeof baseVersion === 'number') {
      // Pre-version docs carry no `version` field; base 0 must match them (and
      // the not-yet-created session, via upsert — a concurrent insert surfaces
      // as the unique-index E11000, which is the same stale-base conflict).
      const versionClause = baseVersion === 0 ? { $in: [0, null] } : baseVersion;
      let doc = null;
      try {
        doc = await ShoppingSession.findOneAndUpdate(
          { ...req.scopeFilter, weekStart, version: versionClause },
          update,
          { upsert: baseVersion === 0, new: true }
        );
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
      if (!doc) {
        const current = await ShoppingSession.findOne({ ...req.scopeFilter, weekStart }, 'version').lean();
        return res.status(409).json({ error: 'Version conflict', version: current?.version ?? 0 });
      }
      return res.json({ ok: true, version: doc.version });
    }
    const doc = await ShoppingSession.findOneAndUpdate(
      { ...req.scopeFilter, weekStart },
      update,
      { upsert: true, new: true }
    );
    res.json({ ok: true, version: doc.version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/organize-grocery-list', meter('aiHelper'), requireAiEnabled, async (req, res) => {
  try {
    const { items, store, sectionOrder } = req.body; // items: [{ name, entries: [{ amount, unit, recipeTitle }] }]
    if (!items?.length) return res.status(400).json({ error: 'items required' });

    const rawList = items.map(item => {
      const amounts = item.entries
        .map(e => [e.amount, e.unit].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ');
      return amounts ? `${item.name}: ${amounts}` : item.name;
    }).join('\n');

    const sectionConstraint = sectionOrder?.length
      ? `You MUST use exactly these section names in exactly this order: ${sectionOrder.map((s, i) => `${i + 1}. ${s}`).join(', ')}. Every item must be placed into one of these sections — use the closest match. Do not create new sections.`
      : `Use standard supermarket sections (Produce, Deli, Bakery, Meat & Seafood, Dairy, Frozen, Pantry, Other).`;

    const storeContext = store
      ? `The shopper is going to ${store}. Set "store_known" to true ONLY if you have reliable knowledge of this specific store chain's typical aisle layout. If you do, include the aisle number or name for each section. If you do NOT have reliable knowledge, set "store_known" to false and leave all aisle fields as empty strings. Do NOT guess or invent aisle numbers.`
      : `Set "store_known" to false. Leave all aisle fields as empty strings.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Organize this grocery list. Consolidate duplicate ingredients and combine amounts where possible. ${sectionConstraint} ${storeContext}

Rewrite every item name as it would be read while walking a store aisle, not as a recipe writes it:
- Title Case each name ("garlic cloves" -> "Garlic Cloves").
- Drop preparation instructions and anything after a comma ("garlic cloves, minced" -> "Garlic Cloves"; "onion, finely diced" -> "Onion").
- Drop filler descriptors that don't change what gets bought — "fresh", "freshly", "chopped", "divided", "to taste", "for garnish" — and herb form words ("fresh basil leaves" -> "Basil").
- Keep words that DO change what gets bought: "ground beef", "smoked paprika", "unsalted butter", "boneless chicken thighs", "whole milk".
- Keep the amount in the "amount" field, never in the name.
- Abbreviate spoon units in the amount: write "tbsp" for tablespoons and "tsp" for teaspoons ("2 tablespoons" -> "2 tbsp").

Raw list:
${rawList}

Respond with ONLY valid JSON (no markdown):
{
  "store_known": true,
  "categories": [
    { "name": "section name", "aisle": "aisle number/name or empty string", "items": [{ "name": "ingredient", "amount": "consolidated amount or empty string" }] }
  ]
}`,
      }],
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[organize-grocery-list] No JSON found in AI response:', raw);
      throw new SyntaxError('No JSON object in response');
    }
    let organized;
    try {
      organized = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[organize-grocery-list] JSON parse failed. stop_reason:', message.stop_reason, '\nRaw response:', raw);
      throw parseErr;
    }
    // The prompt asks for shopper-facing names; this makes them so regardless of
    // what the model returned (services/groceryNames.js).
    res.json(normalizeOrganizedList(organized));
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not organize the list. Try again.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    let enc;
    try { enc = pickRecordEnc(req.body); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (plaintextCreateBlocked(req.household, enc.enc)) {
      return res.status(400).json({ error: E2EE_REQUIRED_MESSAGE });
    }
    const { recipeId, scheduledDate, servings, notes } = req.body;
    const data = {
      ...(isObjectId(req.body._id) ? { _id: req.body._id } : {}),
      userId: req.user._id,
      recipeId,
      scheduledDate: new Date(scheduledDate),
      servings,
      notes,
      ...enc,
    };
    // Steady-state write rule: a sealed meal-plan note stores no plaintext.
    stripSealedContent('RecipeSchedule', req.household, data);
    const schedule = await RecipeSchedule.create(data);
    const populated = await RecipeSchedule.findById(schedule._id).populate('recipeId').lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/for-recipe/:recipeId', async (req, res) => {
  try {
    const schedules = await RecipeSchedule.find({
      ...req.scopeFilter,
      recipeId: req.params.recipeId,
    }).sort('scheduledDate').lean();
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { scheduledDate, servings, notes } = req.body;
    const schedule = await RecipeSchedule.findOne({ _id: req.params.id, ...req.scopeFilter });
    if (!schedule) return res.status(404).json({ error: 'Not found' });

    const oldDate = new Date(schedule.scheduledDate);
    const newDate = new Date(scheduledDate);
    const hh = req.household || req.user;
    const groceryShoppingDay = hh.groceryShoppingDay ?? 6;
    const biweekly = (hh.groceryFrequency ?? 'weekly') === 'biweekly';

    // Start of the shopping period containing `date` — weekly this is the most
    // recent shopping day; biweekly it also snaps to the anchor's parity so
    // both weeks of a period share one session key.
    function weekStartFor(date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const diff = (d.getDay() - groceryShoppingDay + 7) % 7;
      d.setDate(d.getDate() - diff);
      if (biweekly && hh.groceryAnchor) {
        const a = new Date(hh.groceryAnchor);
        a.setHours(0, 0, 0, 0);
        a.setDate(a.getDate() - ((a.getDay() - groceryShoppingDay + 7) % 7));
        const weeks = Math.round((d - a) / 604800000);
        if (((weeks % 2) + 2) % 2 === 1) d.setDate(d.getDate() - 7);
      }
      return d.toISOString().slice(0, 10);
    }

    const oldWeekStart = weekStartFor(oldDate);
    const newWeekStart = weekStartFor(newDate);

    const set = { scheduledDate: newDate };
    if (servings !== undefined) set.servings = servings || null;
    if (notes !== undefined) set.notes = notes;
    // Re-encrypted content from the client (dual-write).
    try { Object.assign(set, pickRecordEnc(req.body)); }
    catch (msg) { return res.status(400).json({ error: String(msg) }); }
    // Steady-state write rule: a sealed meal-plan note isn't re-stored plaintext.
    stripSealedContent('RecipeSchedule', req.household, set);
    Object.assign(schedule, set);
    await schedule.save();

    const weekChanged = oldWeekStart !== newWeekStart;
    if (weekChanged) {
      // Server-side organized-list invalidation only reaches legacy plaintext
      // state — a sealed session's blob is opaque, and its list is instead
      // reconciled on-device against the moved plan (lib/groceryOrganize). The
      // $inc keeps versioned clients from writing over the unset with a stale
      // base.
      const invalidate = { $unset: { 'state.organizedList': 1 }, $inc: { version: 1 } };
      const updates = [
        ShoppingSession.updateOne(
          { ...req.scopeFilter, weekStart: newWeekStart },
          invalidate
        ),
      ];
      // Only invalidate the old week's grocery list if the shopping day hasn't passed yet
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (new Date(oldWeekStart) >= today) {
        updates.push(
          ShoppingSession.updateOne(
            { ...req.scopeFilter, weekStart: oldWeekStart },
            invalidate
          )
        );
      }
      await Promise.all(updates);
    }

    const populated = await RecipeSchedule.findById(schedule._id).populate('recipeId').lean();
    res.json({ schedule: populated, weekChanged, oldWeekStart, newWeekStart });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const schedule = await RecipeSchedule.findOneAndDelete({ _id: req.params.id, ...req.scopeFilter });
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
