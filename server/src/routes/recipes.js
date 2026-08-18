const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const RecipePhoto = require('../models/RecipePhoto');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter } = require('../middleware/usageMeter');
const { activity } = require('../middleware/activity');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { parseRecipeDraft } = require('../services/recipeDraft');
const {
  publicUrl, storageKeyFromUrl, photoExists, storePhoto, deletePhoto,
  storeCropOfPage, pageImageUrl, storeRemoteImage,
} = require('../services/recipePhoto');
const { plaintextCreateBlocked, E2EE_REQUIRED_MESSAGE, stripSealedContent } = require('../services/e2eePolicy');
const { fetchPublicUrl } = require('../services/urlGuard');

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
  "ingredients": [{ "name": "string", "amount": "string", "unit": "string", "group": "string (optional — the ingredient section this belongs to, e.g. 'Base', 'For the sauce', or a variation name; omit for ungrouped)" }],
  "instructions": ["string"],
  "tags": ["string (optional, e.g. dinner, italian, pasta)"],
  "variations": ["string (optional — names of ingredient groups that are MUTUALLY EXCLUSIVE flavor/variation choices; omit when the recipe has none)"],
  "instructionVariations": ["array parallel to instructions, REQUIRED whenever \\"variations\\" is present, omitted otherwise — one entry per instruction step: null for a step shared by every variation, else an array of the variation names the step is only for"]
}`;

// How to use ingredients[].group + variations. Appended to every prompt that
// returns RECIPE_SCHEMA so imports, generation, and AI edits all preserve the
// structure (the meal planner schedules ONE variation and the grocery list
// buys only that one's ingredients).
const GROUPING_GUIDANCE = `Ingredient sections:
- If the recipe presents its ingredients in sections, keep them: set each ingredient's "group" to its section name. Ingredients before/outside any section get no "group".
- Some recipes have a shared base plus alternative flavors or variations (e.g. energy balls with a "Lemon Blueberry" option and a "Chocolate Peanut Butter" option — very common in baking). Put each option's ingredients in a group named after that option, and list exactly those group names in "variations". A cook makes ONE variation, so these groups are mutually exclusive.
- Component sections that are all part of one dish ("For the sauce", "For the dough", "Topping") are ordinary groups — do NOT list them in "variations".
- When "variations" is present, also tag the STEPS via "instructionVariations" (exactly one entry per instruction, in order): null for steps every variation shares (mixing the base, rolling, chilling), or the list of variation names a step is only for (folding in the blueberries → ["Lemon Blueberry"]). Cooking mode shows a cook only the steps for the variation they're making, so an untagged variation-specific step would wrongly appear for everyone.
- If there are no sections at all, omit "group", "variations", and "instructionVariations" entirely.`;

// Photo extraction, asked for ONLY on the photo-import path (a webpage supplies
// its own hero image, and a generated recipe has no picture to find). The model
// is looking at pages, so the answer that matters most is "there isn't one" —
// most printed recipes are text, and a crop of a paragraph is worse than the
// fork-and-knife placeholder it would replace.
const DISH_PHOTO_GUIDANCE = `Photograph of the dish:
- If one of the images contains a PHOTOGRAPH OF THE FINISHED DISH, set "photo" to its location: the 1-based "page" (which image it is in the order given) and the box "x"/"y"/"w"/"h" as fractions of that image's width and height (x,y = top-left corner). Box the photograph itself, tightly — not the page, not the caption, not the text beside it.
- Set "photo" to null when no image shows the finished food: a hand-written card, a plain-text printout, a screenshot of ingredients, or a page whose only pictures are step-by-step process shots, decorative borders, logos, or portraits of the cook. A missing photo is the expected answer — do NOT invent a box to fill the field.`;

// The photo-import schema: the recipe, plus where its photo is. `photo` is a
// locator the route consumes (crop coordinates), never a recipe field.
const RECIPE_SCHEMA_WITH_PHOTO = RECIPE_SCHEMA.replace(
  /\n}$/,
  `,\n  "photo": { "page": "number (1-based image index)", "x": "number 0-1", "y": "number 0-1", "w": "number 0-1", "h": "number 0-1" } | null\n}`,
);

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
      content: `${prompt}\n\n${GROUPING_GUIDANCE}\n\nRespond with ONLY valid JSON matching this schema (no markdown, no explanation):\n${RECIPE_SCHEMA}`,
    }],
  });
  return parseRecipeDraft(message.content[0].text);
}

// GET / (recipe list) retired (Signal-parity C3b): the client reads recipes from
// its replica (populated by /records/sync).

// Record a freshly stored photo as this household's, unattached, and describe it
// to the client. Unattached because the recipe it illustrates does not exist
// yet — an import produces the picture while the user is still deciding whether
// to keep the recipe at all — so the row is what the save later claims
// (PUT /:id/photo) and what the nightly sweep reaps if the save never comes.
async function claimableDraftPhoto(req, storageKey) {
  if (!storageKey) return {};
  await RecipePhoto.create({
    userId: req.user._id,
    householdId: req.household?._id ?? null,
    storageKey,
  });
  return { imageUrl: publicUrl(storageKey) };
}

// A photo the user picked for a recipe they're writing, with no AI in it: this
// is the manual counterpart to the import paths, so it is neither metered nor
// gated on AI consent. Stored through the same normalizer as every other source.
router.post('/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo is required' });
  try {
    const storageKey = await storePhoto(req.file.path);
    res.status(201).json(await claimableDraftPhoto(req, storageKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // The upload is a temp file whatever happened: `storePhoto` wrote its own
    // normalized copy, and a failure has nothing to keep.
    fs.unlink(req.file.path, () => {});
  }
});

// "This recipe's photo is now that file" — sent once the recipe is saved and has
// an id. `imageUrl: null` removes the photo. Either way the recipe's OTHER
// photos are dropped, so replacing one doesn't leave the old bytes on disk
// forever: the client is the only party that can know which it kept (the URL is
// sealed inside the record), so what it claims is definitive.
router.put('/:id/photo', async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid recipe id' });
  const keep = storageKeyFromUrl(req.body?.imageUrl);
  if (req.body?.imageUrl && !keep) return res.status(400).json({ error: 'imageUrl is not a recipe photo' });
  try {
    const mine = { ...req.scopeFilter };
    // Scoped by household on BOTH sides: a claim can only bind a row this
    // household uploaded, and can only unbind rows on its own recipes.
    if (keep) {
      const owned = await RecipePhoto.findOne({ storageKey: keep }, '_id').lean();
      if (owned) {
        const claimed = await RecipePhoto.findOneAndUpdate(
          { storageKey: keep, ...mine },
          { $set: { recipeId: req.params.id } },
        ).lean();
        // The row exists but not in this scope — someone else's photo.
        if (!claimed) return res.status(404).json({ error: 'Photo not found' });
      } else {
        // No row at all, but the file is there: a photo imported before this
        // ownership tracking existed. Adopt it rather than 404 — otherwise the
        // sweep below is the only thing that ever touches it again, and it
        // deletes it. The filename is the only capability on such a file, which
        // is the same posture as `/uploads` serving it unauthenticated.
        if (!(await photoExists(keep))) return res.status(404).json({ error: 'Photo not found' });
        await RecipePhoto.create({
          userId: req.user._id,
          householdId: req.household?._id ?? null,
          recipeId: req.params.id,
          storageKey: keep,
        });
      }
    }
    const stale = await RecipePhoto.find({
      recipeId: req.params.id,
      ...(keep ? { storageKey: { $ne: keep } } : {}),
      ...mine,
    }, 'storageKey').lean();
    for (const row of stale) await deletePhoto(row.storageKey);
    if (stale.length) await RecipePhoto.deleteMany({ _id: { $in: stale.map((r) => r._id) } });
    res.json({ claimed: keep ?? null, removed: stale.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/from-url', requireAiEnabled, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // SSRF-guarded fetch (services/urlGuard): the URL is user-supplied and the
    // extraction below reads the response back to the user, so a bare fetch
    // was a proxy into localhost / cloud-metadata / the private network.
    // http(s) only, every DNS answer must be public, the socket pins the
    // vetted address, and each redirect hop is re-vetted; size + time capped.
    const response = await fetchPublicUrl(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HouseholdCalendar/1.0)' },
      maxBytes: 5 * 1024 * 1024,
    });

    const html = String(response.data);
    const text = stripHtml(html).slice(0, 10000);
    const parsed = await parseRecipeWithAI(
      `Extract the recipe from this webpage content:\n\n${text}\n\n${EXTRACTION_INSTRUCTION_GUIDANCE}`
    );
    await attachIngredientTags(parsed);

    // The page's own photo of the dish, copied here rather than hot-linked: a
    // remote <Image> would announce to that site every time the household opens
    // the recipe, and the URL rots on the site's next redesign. Read from the
    // RAW html — `stripHtml` has already thrown the <meta> tags away by now.
    const photo = await claimableDraftPhoto(req, await storeRemoteImage(pageImageUrl(html, url)));

    // Return for review/edit (saved later via the form) — mirrors the Ask AI flow.
    res.json({ ...parsed, ...photo });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not parse a recipe from that URL. Try adding it manually.' });
    }
    // A guarded URL (private/loopback/metadata target, bad scheme, redirect
    // overrun) is the caller's input, not a server fault.
    if (err.blocked) return res.status(400).json({ error: 'That URL can’t be imported from.' });
    res.status(500).json({ error: err.message });
  }
});

// A long recipe can span several photos (a multi-page cookbook recipe, a card's
// front and back), so the field accepts up to 5 images in one request — all of
// them go to the model as one extraction, in the order they were attached.
router.post('/from-photo', meter('scan'), requireAiEnabled, upload.array('photo', 5), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'photo is required' });
  try {
    const imageBlocks = files.map((file) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: file.mimetype,
        data: fs.readFileSync(file.path).toString('base64'),
      },
    }));
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `Extract the recipe from ${files.length > 1 ? 'these images. They are pages/parts of ONE recipe, in order — combine them into a single recipe' : 'this image'}.\n\n${EXTRACTION_INSTRUCTION_GUIDANCE}\n\n${GROUPING_GUIDANCE}\n\n${DISH_PHOTO_GUIDANCE}\n\nRespond with ONLY valid JSON matching this schema (no markdown, no explanation):\n${RECIPE_SCHEMA_WITH_PHOTO}`,
          },
        ],
      }],
    });
    const parsed = parseRecipeDraft(message.content[0].text);
    // `photo` is a locator for the crop below, not a field of a recipe — take it
    // off before anything else sees the draft.
    const box = parsed.photo;
    delete parsed.photo;
    await attachIngredientTags(parsed);

    // A scan is a picture of a PAGE. What belongs on the recipe card is the
    // dish, so the photograph is cropped out of the page it was printed on — and
    // a page that shows no food (a hand-written card, a plain-text printout)
    // yields no picture at all, rather than a thumbnail of typography.
    const page = files[Number(box?.page) - 1] || files[0];
    const storageKey = await storeCropOfPage(page.path, box);
    const photo = await claimableDraftPhoto(req, storageKey);

    // The pages themselves are not kept. They are photos of someone's cookbook —
    // the whole recipe in plaintext on our disk — and once the crop is taken
    // they have no reader.
    for (const file of files) fs.unlink(file.path, () => {});

    // Return for review/edit (saved later via the form) — mirrors the Ask AI flow.
    res.json({ ...parsed, ...photo });
  } catch (err) {
    for (const file of files) fs.unlink(file.path, () => {});
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not extract a recipe from those photos. Try adding it manually.' });
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

// Author a recipe from a natural-language description, with well-sequenced
// instructions, then tag each step's ingredients before returning. Stated
// wait times are already surfaced as instructionTimers by parseRecipeDraft —
// the one door every AI draft (import, generate, edit) leaves through.
async function generateRecipeWithAI(description) {
  const parsed = await parseRecipeWithAI(
    `Generate a complete recipe based on this description: "${description}"\n\n${GENERATION_GUIDANCE}`
  );
  await attachIngredientTags(parsed);
  return parsed;
}

// Recipe content CRUD (GET / POST / GET:id / PUT:id / DELETE:id) RETIRED
// (Signal-parity C3b): recipes live in the unified opaque store — the client reads
// them from its replica and writes through /records. The AI helpers above (from-
// url/from-photo/from-ai/suggest/generate/edit-with-ai) stay; they return a
// draft the client seals + creates. Per-recipe on-demand tag-ingredients was
// retired (the server can't read a sealed recipe), and the standalone
// /compute-ingredient-tags endpoint went with it (2026-08-11): every AI draft
// path — including edit-with-ai — already returns instructionIngredients via
// attachIngredientTags, and manual links are edited in the form's per-step
// linker, so nothing called it.

// Recipe email-share (POST /:id/share-email) RETIRED 2026-08-01: recipe sharing
// is device-composed — the sender hands the decrypted recipe to the OS share
// sheet from RecipeDetailScreen, so the recipient's address and the recipe body
// no longer round-trip through the server. See mailer.js "Recipe shares".

module.exports = router;
