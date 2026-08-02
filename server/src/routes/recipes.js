const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Recipe = require('../models/Recipe');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter } = require('../middleware/usageMeter');
const { activity } = require('../middleware/activity');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { plaintextCreateBlocked, E2EE_REQUIRED_MESSAGE, stripSealedContent } = require('../services/e2eePolicy');

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads', 'recipes');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

const router = express.Router();
router.use(requireAuth);

const client = new Anthropic();

const RECIPE_SCHEMA = `{
  "title": "string",
  "description": "string (1-2 sentence summary, optional)",
  "servings": "number (optional)",
  "prepTimeMins": "number (optional)",
  "cookTimeMins": "number (optional)",
  "ingredients": [{ "name": "string", "amount": "string", "unit": "string" }],
  "instructions": ["string"],
  "tags": ["string (optional, e.g. dinner, italian, pasta)"]
}`;

// Extra guidance for AUTHORING a recipe from scratch (not extraction).
// Makes the instructions a properly sequenced, time-aware procedure.
const GENERATION_GUIDANCE = `Write the instructions as a well-sequenced procedure a cook can follow in real time:
- Begin with anything that needs lead time: preheating the oven, bringing water to a boil, or marinating/chilling. Preheating should appear at the start so the oven is ready when needed.
- Order steps so their timing works together. Use idle/cooking time productively — e.g. "while the sauce simmers, prep the vegetables" or "as the oven heats, mince the garlic" — instead of front-loading every prep task.
- Make each step one coherent action with concrete cues: temperatures, times, and doneness signals (e.g. "sauté until golden, about 5 minutes").
- Sequence everything so the components finish together and the dish is ready to plate at the end.`;

// Applied when EXTRACTING an existing recipe: clean up instruction sequencing
// for real-time cooking WITHOUT inventing content the source didn't contain.
const EXTRACTION_INSTRUCTION_GUIDANCE = `Keep the source recipe's ingredients, amounts, and actual steps intact, but clean up the instruction sequencing so a cook can follow it in real time:
- Move preheating and other lead-time tasks (boiling water, marinating) to where they need to start, usually near the beginning.
- Where the source implies it, use idle/cooking time for prep (e.g. "while it bakes, prep the toppings") instead of an unordered prep dump.
- Make each step one clear action. Preserve any temperatures, times, and doneness cues from the source, but do NOT invent specific numbers that aren't in or clearly implied by the source.`;

function stripHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function parseRecipeWithAI(prompt) {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `${prompt}\n\nRespond with ONLY valid JSON matching this schema (no markdown, no explanation):\n${RECIPE_SCHEMA}`,
    }],
  });
  const text = message.content[0].text.trim()
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '');
  return JSON.parse(text);
}

// GET / (recipe list) retired (Signal-parity C3b): the client reads recipes from
// its replica (populated by /records/sync).

router.post('/from-url', requireAiEnabled, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HouseholdCalendar/1.0)' },
      maxContentLength: 5 * 1024 * 1024,
    });

    const text = stripHtml(String(response.data)).slice(0, 10000);
    const parsed = await parseRecipeWithAI(
      `Extract the recipe from this webpage content:\n\n${text}\n\n${EXTRACTION_INSTRUCTION_GUIDANCE}`
    );
    await attachIngredientTags(parsed);

    // Return for review/edit (saved later via the form) — mirrors the Ask AI flow.
    res.json(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not parse a recipe from that URL. Try adding it manually.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/from-photo', meter('scan'), requireAiEnabled, upload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'photo is required' });
  try {
    const base64Image = fs.readFileSync(file.path).toString('base64');
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: file.mimetype, data: base64Image },
          },
          {
            type: 'text',
            text: `Extract the recipe from this image.\n\n${EXTRACTION_INSTRUCTION_GUIDANCE}\n\nRespond with ONLY valid JSON matching this schema (no markdown, no explanation):\n${RECIPE_SCHEMA}`,
          },
        ],
      }],
    });
    const text = message.content[0].text.trim()
      .replace(/^```json?\s*/i, '')
      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(text);
    await attachIngredientTags(parsed);

    // Return for review/edit (saved later via the form) — mirrors the Ask AI flow.
    // The uploaded image is kept so the form can carry imageUrl through to save.
    const imageUrl = `/uploads/recipes/${path.basename(file.path)}`;
    res.json({ ...parsed, imageUrl });
  } catch (err) {
    fs.unlink(file.path, () => {});
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not extract a recipe from that photo. Try adding it manually.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/from-ai', meter('generation'), requireAiEnabled, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });

    // Signal-parity C3b (+ closes the pass-3 write-guard bypass): return the AI
    // draft for the client to seal + create through /records — never mint a
    // plaintext Recipe server-side (the server can't write to the opaque store).
    const parsed = await generateRecipeWithAI(description);
    res.json({ source: 'ai', ...parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight "what should I cook?" suggestions for the Find Recipes screen.
// Free-text request in, 5 suggestion stubs out; the user previews one via
// /generate. (Moved here from the retired food-inventory routes.)
router.post('/suggest-recipes', meter('generation'), requireAiEnabled, async (req, res) => {
  try {
    const q = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!q) return res.status(400).json({ error: 'query is required' });

    const OUTPUT_SPEC = `Suggest exactly 5 recipes. For each recipe:\n- "title": recipe name\n- "description": one sentence describing the dish\n- "time": estimated total time (e.g. "30 min")\n- "usedIngredients": array of the main ingredients this recipe uses\n- "needsOther": array of any additional ingredients needed\n\nReturn ONLY valid JSON with no markdown:\n{ "recipes": [{ "title": "...", "description": "...", "time": "...", "usedIngredients": ["..."], "needsOther": ["..."] }] }`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: `Suggest recipes for this request: "${q}".\n\n${OUTPUT_SPEC}` }],
    });
    const text = message.content[0].text.trim()
      .replace(/^```json?\s*/i, '')
      .replace(/\s*```$/i, '');
    res.json(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not generate recipe suggestions.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Generate recipe from description without saving (for preview/edit flow)
router.post('/generate', meter('generation'), requireAiEnabled, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });
    const parsed = await generateRecipeWithAI(description);
    res.json(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not generate a recipe from that description. Try being more specific.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Edit an existing recipe using a natural language instruction (no save)
router.post('/edit-with-ai', meter('aiHelper'), requireAiEnabled, async (req, res) => {
  try {
    const { recipe, instruction } = req.body;
    if (!recipe || !instruction) return res.status(400).json({ error: 'recipe and instruction are required' });
    const parsed = await parseRecipeWithAI(
      `Here is a recipe in JSON format:\n${JSON.stringify(recipe)}\n\nApply this modification: "${instruction}"\n\nReturn the complete modified recipe with all fields.`
    );
    await attachIngredientTags(parsed);
    res.json(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not apply that change. Try rephrasing your request.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Ingredient-to-step tagging via Claude
// Runs async after every save; client falls back to text-matching until done.
// ---------------------------------------------------------------------------
async function tagInstructionIngredients(recipe) {
  if (!recipe.ingredients?.length || !recipe.instructions?.length) return null;

  const ingredientList = recipe.ingredients
    .map((ing, i) => `${i}: ${[ing.amount, ing.unit, ing.name].filter(Boolean).join(' ')}`)
    .join('\n');

  const instructionList = recipe.instructions
    .map((step, i) => `${i}: ${step}`)
    .join('\n');

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You map a recipe's ingredients to the cooking steps that use them.

For each instruction step, return the 0-based indices of the ingredients that are
actively added or used in THAT step. A cook reading the step should see exactly
the ingredients they need to pick up at that moment.

Rules:
- Resolve implicit references to the actual ingredients:
  - "the aromatics" → the onion, garlic, shallots, ginger, etc. in the list
  - "season" / "season to taste" → the salt, pepper, and other seasonings
  - "the dry ingredients" / "the wet ingredients" → the matching members of each group
  - "the sauce" / "the marinade" / "the dough" → the ingredients that compose it
  - "remaining ingredients" → every ingredient not yet used in an earlier step
- Assign an ingredient to the step where it is FIRST added. Repeat it in a later
  step only if that step physically adds more of the raw ingredient (e.g. "add
  another cup of broth").
- If an ingredient is cooked or prepared in one step and its already-cooked form
  is later combined into another part of the recipe, tag it ONLY in the step where
  it was cooked — NOT in the later step that mixes the cooked result in. For example,
  "sauté the mushrooms" then later "fold the mushrooms into the risotto": the
  mushrooms belong to the sauté step only, because no new raw mushrooms are added
  when they are folded in.
- Steps with no specific ingredient (preheat, boil water, rest, plate) → empty array [].
- Garnishes and "for serving" items belong to the step that serves/finishes the dish.

Worked example
Ingredients:
0: 2 tbsp olive oil
1: 1 onion, diced
2: 2 cloves garlic, minced
3: 1 lb ground beef
4: 1 tsp salt
5: 1/2 tsp black pepper
6: 1 can crushed tomatoes
7: 1 lb spaghetti
Instructions:
0: Bring a large pot of water to a boil.
1: Heat the oil and sauté the aromatics until soft.
2: Add the beef, season, and brown.
3: Stir in the tomatoes and simmer 20 minutes.
4: Cook the spaghetti, then serve with the sauce.
Answer: [[],[0,1,2],[3,4,5],[6],[7]]

Now do the same for this recipe.
Ingredients (0-indexed):
${ingredientList}

Instructions (0-indexed):
${instructionList}

Return ONLY a compact JSON array of arrays — exactly ${recipe.instructions.length} arrays, one per step, in order. No explanation.`,
    }],
  });

  const raw = msg.content[0].text.trim()
    .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

function runTagging(recipe) {
  tagInstructionIngredients(recipe)
    .then(tags => {
      if (tags) Recipe.findByIdAndUpdate(recipe._id, { instructionIngredients: tags }).exec();
    })
    .catch(err => console.error('[tagIngredients]', err.message));
}

// Best-effort: tag each instruction step's ingredients in place, so the recipe
// arrives already linked. Failures are non-fatal — the user can re-tag in the editor.
async function attachIngredientTags(parsed) {
  try {
    const tags = await tagInstructionIngredients(parsed);
    if (tags) parsed.instructionIngredients = tags;
  } catch (err) {
    console.error('[tagIngredients]', err.message);
  }
  return parsed;
}

// Pull an explicit timed-wait duration out of each instruction step so the
// planner/cooking view can show a timer chip. Deterministic (no AI, no tokens):
// reads the times the generated steps already state, e.g. "simmer for 20 minutes",
// "bake 25 min", "chill 1 hour". Returns minutes per step (null when none), or
// null overall when no step states a time.
function deriveInstructionTimers(instructions) {
  if (!Array.isArray(instructions) || !instructions.length) return null;
  // A duration, optionally a range ("20 to 25 minutes") whose upper bound wins.
  const DUR = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|to|and)\s*(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|minutes?|mins?)\b/gi;
  let any = false;
  const timers = instructions.map((step) => {
    if (typeof step !== 'string') return null;
    let best = null;
    DUR.lastIndex = 0;
    let m;
    while ((m = DUR.exec(step))) {
      const isHour = m[3].toLowerCase().startsWith('h');
      const val = Number(m[2] ?? m[1]); // upper bound of a range, else the value
      const mins = Math.round(isHour ? val * 60 : val);
      // A step often mentions several times ("sauté 2 min, then simmer 20 min");
      // the longest is the meaningful unattended wait to count down.
      if (mins > 0 && (best == null || mins > best)) best = mins;
    }
    if (best != null) any = true;
    return best;
  });
  return any ? timers : null;
}

// Author a recipe from a natural-language description, with well-sequenced
// instructions, then tag each step's ingredients and surface any stated
// timers before returning.
async function generateRecipeWithAI(description) {
  const parsed = await parseRecipeWithAI(
    `Generate a complete recipe based on this description: "${description}"\n\n${GENERATION_GUIDANCE}`
  );
  await attachIngredientTags(parsed);
  const timers = deriveInstructionTimers(parsed.instructions);
  if (timers) parsed.instructionTimers = timers;
  return parsed;
}

// Recipe content CRUD (GET / POST / GET:id / PUT:id / DELETE:id) RETIRED
// (Signal-parity C3b): recipes live in the unified opaque store — the client reads
// them from its replica and writes through /records. The AI helpers above (from-
// url/from-photo/from-ai/suggest/generate/edit-with-ai/compute-ingredient-tags)
// stay; they return a draft the client seals + creates. Per-recipe on-demand
// tag-ingredients was retired too (the server can't read a sealed recipe) — the
// client re-tags via compute-ingredient-tags with the decrypted body + re-seals.

// Recipe email-share (POST /:id/share-email) RETIRED 2026-08-01: recipe sharing
// is device-composed — the sender hands the decrypted recipe to the OS share
// sheet from RecipeDetailScreen, so the recipient's address and the recipe body
// no longer round-trip through the server. See mailer.js "Recipe shares".

// Compute ingredient-to-step tags from provided data (no DB write — for the edit UI)
router.post('/compute-ingredient-tags', meter('aiHelper'), requireAiEnabled, async (req, res) => {
  try {
    const { ingredients, instructions } = req.body;
    const tags = await tagInstructionIngredients({ ingredients, instructions });
    if (!tags) return res.status(422).json({ error: 'Recipe has no ingredients or instructions to tag' });
    res.json({ instructionIngredients: tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
