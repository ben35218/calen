---
title: Kitchen (recipes, meal planning, grocery)
status: current
last-verified: 3cd3b36+ (2026-08-11); the recipe add/edit form guards against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29); recipe sharing is now device-composed via the OS share sheet (`RecipeDetail` `Share.share`) — the server-sent styled email (`POST /recipes/:id/share-email`) was retired 2026-08-01, removing the decrypted-recipe plaintext round-trip (2026-08-01); kitchen search fields (Recipes search, Add-meal header search, step ingredient-linker browse search) set `autoCapitalize="none"` + `autoCorrect={false}` per the app-wide input-hint convention (mobile/CLAUDE.md) (2026-08-10); the meal planner's week window + recipe-title join moved on-device (`lib/mealSchedule.ts`) — the leftover `{start,end}` range param hit the record store's equality-only filter and emptied both the Meals view and the grocery list (2026-08-10); a recipe's upcoming "Next scheduled" date is now a link into the meal planner — it opens the Meals view on that shopping period with the day scrolled to and highlighted, and the featured-schedule pick moved to `lib/mealSchedule.featuredSchedule` (sorted, so "next" is genuinely next) (2026-08-10); planner meal rows lost their red ✕ for swipe-to-Remove behind the native confirm, and the `SwipeableRow` that was local to `RecipesScreen` was promoted to the shared kit (components/ui) so both use one implementation (2026-08-10); the grocery cart now queues a planner highlight for the shopping day (`pane` alone picks a pane — `scrollToDate` no longer implies the Planner), scheduled meals get their real recipe name back on the calendar via an on-device title join (`lib/mealSchedule.populateRecipeRefs`), and the meal/shopping glyphs moved to shared `RECIPE_ICON`/`GROCERY_ICON` constants used by the month grid, list, day view, search, and the planner (2026-08-10); the shared `SwipeableRow`'s revealed action now follows the row's measured height — the word alone on a short interior row (the planner meal row, where the glyph + word pair didn't fit), glyph over word on a tall card — and the reveal became undoable: swipe back or tap the open row to put it away, with the screen's back gesture suspended while any row is open so the undo swipe stops popping the user out of the Meals view (2026-08-10); Organize now returns shopper-facing item names — Title Case with the prep clause and filler stripped ("garlic cloves, minced" → "Garlic Cloves", "fresh basil leaves" → "Basil") — set by the prompt and made deterministic by `services/groceryNames.js`, which also abbreviates spoon units to tbsp/tsp (every recipe spelling, single-letter T/t left alone as ambiguous) and merges items whose cleaned names collide inside a section; an empty section no longer renders its header (dropped server-side and skipped at render, since pre-existing organized lists are persisted in `ShoppingSession`) (2026-08-10); the grocery card's header was decrowded — title + progress stack with only the sections glyph beside them, and the Organize / view-flip control moved to its own band below the divider (filled accent = the billable AI call, outline = the free flip) — and "Plain list" stopped discarding the organized result, so flipping back is free; the organized list was made change-aware via `organizedFor` (2026-08-10); the Meals view's top was rebuilt: above the tabs there is now only the period (relative label + the concrete date range it stands for, non-interactive), the Grocery Schedule card appears only while the schedule is unset, and this screen's two settings (Grocery Shopping Schedule, Grocery List Sections) moved out of the content into a single `⋯` nav-bar overflow sheet — the grocery card's unlabelled sort glyph went with them; Recipes then joined that menu too, leaving `headerRight` with the `⋯` alone so the "Meals" title sits centred like every other view (2026-08-10); the planner's shopping-day marker now distinguishes the next upcoming trip (accent ring + "Next Shopping Day") from one already taken ("Shopped") — and the day comparison behind it, shared with the "Today" pill, was moved off `iso(new Date())`, which read the UTC date and rolled the day over after ~8pm Eastern (2026-08-10); the `n of m` shopping progress now counts the rows on screen rather than the raw aggregated list — it sat frozen at "0 of 13" for anyone shopping the organized view, whose renamed rows share no keys with the plain list — and every wordless control on an item row gained an accessibility label (2026-08-10); the recipe library's "All" view became a flat alphabetical list showing each recipe once — the old group-by-tag sections repeated a multi-tagged recipe under every tag it carried, reading as duplicates — with per-tag sections now appearing only when a chip is selected (2026-08-11); the recipe form's Title input now enforces a capital first letter on the value itself via `lib/strings.capFirst` — the `sentences` keyboard hint alone let a lowercase title through (2026-08-11); cooking mode and the recipe edit form now decrypt their fetched recipe via `openRecord` like every other reader — both fetched the raw sealed row, so per-step ingredient tags and timers never rendered in cooking mode, and an edit form seeded from a sealed row could save enc-only fields back emptied (2026-08-11); the quick import gained multi-photo capture — up to 5 photos of one recipe extracted in a single `from-photo` request (library multi-select, or a camera "Add another page?" loop) — the form body shimmers a form-shaped skeleton while any import is in flight (replacing a lone spinner over the empty form), and a successful import now swaps the Quick import card for the AI assistant so the result can be refined before first save (2026-08-11); a drifted organized list is now patched locally instead of retired — added ingredients surface in a leading "New Items" section, removed ones drop out, re-portioned amounts are rewritten deterministically, and a Re-organize pill appears only while the plan has drifted — with the name normalizer promoted to the shared `@household/grocery` package so the server's organize response and the client's reconcile clean names identically; the sections also became hand-editable — tap an item's name in the organized view to file it via a section sheet, with the first move from the plain list creating the organized list (no mode, no button — a standing gesture explained by an ⓘ disclosure on the card title), manual moves committing the patched list + fingerprint, and the AI Organize/Re-organize action always present in the band (2026-08-11); the recipe form now seals saves with the canonical `lib/encSubsets.RECIPE_ENC` — its stale local subset omitted `instructionIngredients`/`instructionTimers`/`imageUrl`/`sourceUrl`, and since only `enc` reaches the opaque store those fields were dropped on every save (why per-step tags and timers stayed missing in cooking mode even after the reader-side decrypt fix; pre-fix recipes need them re-entered) (2026-08-11); cooking mode went hands-free — an opt-in mic pill runs continuous on-device keyword spotting (`hooks/useVoiceCommands`: next/back/start timer/ingredients, no AI or telephony cost, restarts across OS session ends, shares the dictation recognizer behind active-flag guards) with haptic + pill-label feedback, knuckle-tap zones on the step area (right two-thirds = next, left third = back, screen-reader-hidden), and the screen now stays awake via `expo-keep-awake` (NEW NATIVE MODULE → needs EAS rebuild; voice + tap zones work on existing builds) (2026-08-11); voice commands then got faster and richer — matching moved to the first interim result (a final only lands after the utterance ends, and that delay read as "not heard", inviting repeats; one command per utterance, reset on the final), the grammar gained "go to step # / step #" jumps (digits, number words, and to/for-style homophones; out-of-range ignored), the mic pill widened to read at arm's length (fixed minWidth, "Listening…" while live), and an ⓘ HintDisclosure under the progress bar lists the spoken commands (2026-08-11); recipes gained ingredient groups + flavor variations — `Ingredient.group` sections with `Recipe.variations` naming the mutually exclusive flavor kits (a shared base + "Lemon Blueberry" / "Chocolate Peanut Butter" options, the baking pattern), taught to every AI capture/edit prompt, rendered as section headers on the detail/form/share/cooking surfaces, chosen per-meal at scheduling (`RecipeSchedule.variation`, sealed; detail-pad chips / Add-meal prompt / create-then-schedule prompt) and honored by the grocery aggregation, which buys base + component groups + only the chosen kit (no recorded choice fails open) (2026-08-11); variations reached cooking — steps are variation-tagged (`instructionVariations`, sealed, taught to every AI prompt, editable via per-step chips on the form, annotated "X only" on the detail page), "Start Cooking" asks which variation is being made (cancel doesn't start), and cooking mode walks only the applicable steps by real instruction index (tags/timers stay aligned; progress counts the visible set) with other kits' ingredients filtered out of the reference panel (2026-08-11); ingredient names are now title-cased everywhere they are read — every word capitalized except the minor ones, anything the writer already capitalized left alone, and the prep clause kept (unlike the shopping row) — using the same shared `@household/grocery` `titleCase` the grocery normalizer uses, applied on the way in: server-side as an AI draft is parsed (`services/recipeDraft.js`, the one door for from-url/from-photo/from-ai/generate/edit-with-ai) and on-device at every recipe read (`lib/recipeNames.openRecipe` — decrypt, then case, which is what makes already-sealed recipes imported all-lowercase display correctly) plus each keystroke in the form's ingredient-name field (2026-08-11); the Plain list ⇄ By section toggle was removed — once an organized list exists it is the only view (New Items already guarantees every item is visible), the action band holds just the always-present AI pill, and a pre-fingerprint legacy list now diffs against an empty fingerprint so items it doesn't cover surface in New Items instead of hiding with no plain list to fall back on; that pill then moved up onto the card title's row (top-aligned, so the ⓘ hint can't push it off the title) and lost its second label — always "Organize", since the "Re-" prefix claimed a prior AI run that a hand-filed or member-organized list never had; the period caption then became the trip that opens the period and how far off it is ("Shop Sat, Aug 15 (in 4 days)", in the true tense, the span dropped since a period starts on its shopping day, and the period labels themselves became fully relative ("Three Weeks" / "Three Weeks Ago" instead of a date range, counted in weeks so biweekly reads true), omitted until a shopping day is configured) — the Grocery tab carried no date at all and the header only implied one, and since the shopping day is a property of the period both tabs now read it from one place, with the Planner's three-state logic extracted to a shared `shoppingDayState` helper so the two can't disagree about what day it is (2026-08-11); leaving cooking mode no longer kills a running timer — the countdowns moved to a module store (`lib/cookTimers`) as wall-clock deadlines that outlive the screen, and the exit asks through `usePreventRemove` (a bare `beforeRemove` preventDefault does not hold a NATIVE stack — Cancel popped the screen anyway) whether to keep them running (armed as per-deadline local notifications, disarmed on return, re-armed after the reminder scheduler's cancel-everything pass) or stop them (2026-08-11); cooking mode gained a "read" voice command (also "read step"/"read it"/"repeat") — the current step is spoken via on-device `expo-speech` TTS ("Step N. <instruction>"), with the recognizer parked while the phone talks (`useVoiceCommands.suspend/resume`; a suspended session's trailing end/error are no-ops) and resumed however the speech ends, narration cut short on step change and on leaving the screen; `expo-speech` is a SECOND NEW NATIVE MODULE (bundle with the keep-awake EAS rebuild — on an older binary "read" flashes "Reading needs an app update") (2026-08-11); voice mode gained "down"/"up" (also "scroll down"/"scroll up") for steps too long for their viewport — each command scrolls the step area by a partial page (60% of the visible height, `lib/scrollPage.pagedScrollTarget`) so repeated commands walk the whole instruction with overlap, clamped at both ends, with consecutive scrolls stacking optimistically and a step change rewinding to the top (2026-08-11); recipes gained a real photo: the add/edit form can attach a picture OF the dish (`POST /recipes/photo` — no AI, no meter), a URL import copies the page's own hero image (og:image/twitter:image/JSON-LD, read from the raw HTML and downloaded rather than hot-linked), and a photo import crops the finished-dish photograph out of the scanned page — taking NOTHING when the page shows no food, and no longer keeping the scans themselves; `imageUrl` is stored as a path with the API host joined at display time (`lib/recipePhoto.recipeImageUri`), which is also what makes the library thumbnail and the detail hero render at all; and photo files are now OWNED (`RecipePhoto` rows claimed by `PUT /recipes/:id/photo` after a save, reaped on recipe delete) — the nightly orphan sweep asked the empty post-C3b plaintext `Recipe` collection and so deleted every household's recipe photos 24h after upload (2026-08-11); deleting a recipe now cascades to the meal plan — both delete doors (library swipe, edit form) run `lib/recipeDelete.deleteRecipeWithSchedules`, which removes every schedule pointing at the recipe (legacy populated-ref rows and past meals included) before the recipe itself, client-driven because `recipeId` is sealed content the server can't query; both confirms say the planned meals go too, and the grocery list — a saved organized list included — needs no step of its own (the derived aggregation + fingerprint reconcile drop the removed items while sections and checked state survive), and the edit form's delete now pops past the deleted recipe's own detail screen instead of landing back on it (`popCountAfterDelete` — a plain goBack returned to a view whose query could only 404; a form reached without a detail underneath still pops one step) (2026-08-11); the recipe form's assistant card was retitled to Calen (`ASSISTANT_NAME`) and its input now rests at one line, growing only while focused or holding text; the separate "Tag ingredients to instructions" action was retired end-to-end — Apply changes covers it because `/edit-with-ai` returns the modified recipe with `instructionIngredients` already recomputed (`attachIngredientTags`), so `POST /recipes/compute-ingredient-tags`, the client's `recipesApi.computeIngredientTags`, and the dead `runTagging` helper were all removed (manual links stay editable in the per-step linker) (2026-08-11); the Calen card then became collapsible — tapping its header (trailing chevron) folds it to the header alone, open by default — and instruction-step timer derivation moved into the one parse door: `deriveInstructionTimers` relocated from routes/recipes.js into `services/recipeDraft.parseRecipeDraft`, so every AI draft path (from-url, from-photo, from-ai, generate, edit-with-ai — previously generate only) returns steps with their stated wait times as `instructionTimers`, unit-covered in recipeDraft.test.js (2026-08-11); voice scrolling reached the ingredient panel — "ingredients down"/"ingredients up" (also "scroll ingredients …") page the reference panel while bare "down"/"up" stay on the step area (noun-scoped commands, no spoken focus mode), the two panes sharing one `usePagedScroll` plumbing (partial-page targets, optimistic stacking; the ingredient panel rewinds on step change AND the this-step ⇄ view-all flip), and the interim matcher gained a prefix-ambiguity hold (`matchCouldExtend`) so a bare "ingredients" interim no longer flips the toggle and swallows the scroll while "ingredients down" is still arriving — held only while the match ends the transcript, released by the final, never for longer phrases of the same command (2026-08-11); the planner meal row's title no longer truncates to one line — it wraps to as many lines as the recipe name (plus variation) needs, with the meal glyph top-aligned to the first line (2026-08-11); the recipe form's Calen card was unified onto the shared FormAssist panel — "Ask Calen" + CalenChatIcon header (was "Calen" + a sparkles glyph), collapsed by default on a plain edit, expanded (without stealing the keyboard) after a quick import / AI review, Apply changes still → /edit-with-ai via FormAssist's onSubmit mode (3cd3b36+, 2026-08-11); the "Ask Calen" card header now wears the `CalenGlyph` gradient-"C" brand mark (shared with the calendar's assistant FAB) instead of the chat-bubble CalenChatIcon (3cd3b36+, 2026-08-12); the grocery list stopped being only what the meal plan implies — an "Add item" row at the foot of the card takes a name + optional amount, and hand-added rows are merged into the derived list on-device (`lib/groceryExtras`, persisted as `ShoppingSession.state.extras` so the household shares them) as ordinary items: they check off, substitute, file into sections, organize, and reconcile through the same code, with swipe-to-delete on the hand-added rows alone; and the move-to-section sheet was retitled from the item's own name to "Grocery List Sections" (the item moved to a caption line beneath it) (3cd3b36+, 2026-08-12); cooking mode's voice grammar gained "read ingredients" (speaks the ingredient panel's current list via the same parked-mic TTS path as "read") and edge jumps — "top"/"bottom" ("scroll to top"/"scroll to bottom") on the step area, "ingredients top"/"ingredients bottom" on the panel (`usePagedScroll.scrollToEdge`) — and the spoken-command list moved out of the folded prose `HintDisclosure` into a pop-up command chart: a "Voice commands" ⓘ row under the progress bar opens a `BottomSheet` of grouped say-this → get-that rows (`VOICE_GUIDE`) (3cd3b36+, 2026-08-12)
code:
  - mobile/src/screens/kitchen/
  - server/src/routes/recipes.js
  - server/src/routes/recipeSchedule.js
  - server/src/models/{Recipe,RecipePhoto,RecipeSchedule,ShoppingSession}.js
  - server/src/services/{groceryNames,recipeDraft,recipePhoto,recipePhotoReaper}.js
  - shared/grocery/index.js
  - server/src/jobs/cleanupOrphanUploads.js
  - mobile/src/lib/{groceryList,groceryAggregate,groceryOrganize,groceryExtras,mealSchedule,recipeVariations,recipeNames,recipePhoto,cookTimers,scrollPage}.ts
tests:
  - server/src/test/kitchen.integration.test.js
  - server/src/services/{groceryNames,recipeDraft,recipePhoto}.test.js
  - server/src/test/recipePhotos.integration.test.js
  - mobile/src/lib/__tests__/{groceryList,groceryAggregate,groceryOrganize,groceryExtras,mealSchedule,recipeIconTarget,recipeVariations,recipeNames,recipePhoto,strings,encSubsets,scrollPage}.test.ts
  - mobile/src/screens/kitchen/__tests__/{KitchenScreen.weekParam,KitchenScreen.periodHeader,shoppingDayState,PlannerPane.focusDate,PlannerPane.mealRow,PlannerPane.shoppingDay,GroceryPane.sections,GroceryPane.organizeToggle,GroceryPane.progress,GroceryPane.extras,RecipesScreen.tagFilter,CookingModeScreen.stepData,CookingModeScreen.voice,CookingModeScreen.timerGuard,CookingModeScreen.variationSteps,RecipeFormScreen.importFlow,RecipeFormScreen.photo}.test.tsx
  - mobile/src/components/__tests__/ui.swipeableRow.test.tsx
  - mobile/src/hooks/__tests__/useVoiceCommands.test.ts
---

# Kitchen (recipes, meal planning, grocery)

## Purpose

A recipe box, a weekly meal planner, auto-generated grocery lists, and a
hands-free cooking mode. Recipe capture and suggestions are AI-assisted.

## Behavior (normative)

- **Unsaved-changes guard:** the recipe add/edit form prompts an Apple-style
  "Discard Changes?" sheet before leaving with unsaved edits (header ✕ / back /
  swipe-back / Android back), via the shared `useUnsavedChangesGuard` hook — a
  successful save/delete exits without prompting. See
  [calendar.md](calendar.md) and [mobile/CLAUDE.md](../../mobile/CLAUDE.md).

### Add-on gating

- The Kitchen home is gated by the **`recipes` (Meals) add-on** — a one-time
  household-wide purchase specified in
  [billing-plans.md](billing-plans.md#feature-calendar-add-ons). When the
  household doesn't own it, `KitchenScreen` renders the `AddonLockedView`
  purchase interstitial instead of its content (sub-screens are reached only
  through the gated home). Data is retained while locked and reappears on
  purchase; grocery-shopping calendar markers lock with the Meals feature.

### Recipes

- A `Recipe` has a title, description, source/sourceUrl/imageUrl, servings,
  prep/cook times, structured `ingredients` (name/amount/unit), ordered
  `instructions` with per-step ingredient links (`instructionIngredients`) and
  timers (`instructionTimers`), and `tags`.
- **The library lists each recipe once.** `RecipesScreen`'s default ("All")
  view is a flat, alphabetical list with no section headers — grouping it by
  tag repeated a multi-tagged recipe under every tag it carried, which read as
  duplicate recipes rather than categories. Tags surface as filter chips
  (alphabetical, **Untagged** last, present only when a tagless recipe exists);
  selecting a chip narrows the list to that tag's recipes under a single sticky
  header, and Untagged collects the tagless. Search filters by title or tag
  within whichever view is active; the chip row is derived from the full recipe
  set so the available categories stay stable while searching.
- **The title field enforces a leading capital.** The add/edit form's Title
  input uppercases the first character of the value as it's typed
  (`lib/strings.capFirst`) — the keyboard's `sentences` hint is only a
  suggestion (the user can toggle shift off, and it's inert when the OS
  auto-capitalization setting is disabled), so a recipe can't be saved with a
  lowercase first letter typed past it. The rest of the title is left exactly
  as typed — no title-casing, per the app-wide input-hint convention.
- **Ingredient names are title-cased.** An ingredient name is read as a *name* —
  in the recipe's list, in cooking mode, on the grocery list, in the shared text
  — so every word is capitalized except the minor ones convention leaves
  lowercase inside a title ("cream of mushroom soup" → "Cream of Mushroom
  Soup"). Sources disagree: an imported or generated recipe usually arrives
  all-lowercase and hand entry is whatever the keyboard did, and one recipe
  mixing both reads as broken. Unlike the shopping row, **nothing is dropped**:
  the prep clause the recipe writes into the name ("Garlic Cloves, Minced") is
  part of the cooking instruction and stays.
  - A word the writer already capitalized anywhere is left exactly as written —
    "BBQ", "McCormick", "San Marzano" are all things a re-case would damage, and
    the problem being fixed is all-lowercase text, not mixed case.
  - The casing is the **same shared function** the grocery list cleans its names
    with (`@household/grocery` `titleCase`, which `shopperName` also uses), so a
    recipe and its shopping row can never disagree about how a name is written.
  - It is applied on the way **in**, not at render: every AI draft is cased as
    it is parsed server-side (`services/recipeDraft.js`, the one door for
    from-url / from-photo / from-ai / generate / edit-with-ai), and on-device
    every recipe is read through `lib/recipeNames.openRecipe` (decrypt, then
    case) with the form's ingredient-name field casing each keystroke (same
    length in as out, so the caret never jumps). Recipes are sealed, so the
    server can never re-case what is already stored — reading through that one
    door is what makes recipes saved before this existed display correctly, and
    re-saving one stores the cased names.
- CRUD is through the opaque record store (`/records`), not a per-recipe REST
  route. The `recipes` router is **AI/utility only**: `POST /recipes/from-url`,
  `/from-photo`, `/from-ai`, `/generate`, `/edit-with-ai` (capture/generate),
  `/suggest-recipes`. Every draft these return arrives with its
  ingredient-to-step tags already computed (`attachIngredientTags` runs before
  the response) — there is no separate re-tag endpoint; the retired
  `/compute-ingredient-tags` had no caller once the form's standalone tag
  button was dropped, since manual links are edited in the per-step linker.
- **Every AI draft arrives with its timers.** Any stated wait time in an
  instruction step ("simmer 20 to 25 minutes" → 25, "chill 1 hour" → 60; the
  longest time in a step wins, ranges take the upper bound) is surfaced as
  `instructionTimers` by the deterministic `deriveInstructionTimers` (no AI, no
  tokens), which lives in `services/recipeDraft.js` and runs inside
  `parseRecipeDraft` — the one parse door — so from-url, from-photo, from-ai,
  generate, AND edit-with-ai all deliver steps with their timers attached, not
  just generation. A draft that already carries `instructionTimers` is left
  alone; steps stating no time get none.
- **A photo import can span several photos.** A long recipe rarely fits one
  frame (a multi-page cookbook recipe, a card's front and back), so
  `POST /recipes/from-photo` accepts up to **5 images** under the repeated
  `photo` field and extracts them as **one recipe** — the model is told the
  images are pages of a single recipe, in order. On the form, "Choose Photos" multi-selects from the
  library (`pickImages(5)`), and "Take Photos" loops the camera with an
  "Add another page?" prompt after each shot until Done, cancel, or the cap —
  cancelling the camera mid-loop extracts the pages already captured rather
  than discarding them.
- **An import is watched through a form-shaped skeleton.** While a URL or photo
  import is in flight, the form body (title/description, meta rows,
  ingredients, steps) is replaced by shimmering placeholder cards built from
  the shared `Skeleton` pulse — the same treatment as the calendar's loading
  cells — not a spinner over the still-empty form. The **Quick import card goes
  with it**: tapping Import dismisses the keyboard and hides the card, so the
  shimmering placeholders are the only thing on screen while the extraction
  runs. A failed import brings the card back with the URL still typed, ready to
  retry.
- **A successful import hands the form to the assistant.** Once a quick
  import (URL or photos) populates the form, the Quick import card is replaced
  by the same assistant card the edit/review modes show, so the imported recipe
  can be refined ("make it vegan", "double the servings") before it is first
  saved.
- **The form assistant card is the shared `FormAssist` panel** (the same "Ask
  Calen" card every add/edit form shows, per mobile/CLAUDE.md): header =
  the `CalenGlyph` gradient-"C" brand mark + "Ask Calen" + a trailing chevron
  (`chevron-up` open / `chevron-down` folded), tapping the header toggles it.
  It opens **collapsed on a plain edit** (the recipe is the screen's job) and
  **expanded when the form was just populated by a quick import or an AI
  review** — refining the import is the expected next step; the
  default-expanded card does not auto-focus its input, so the keyboard stays
  down over the freshly filled form. Its input rests at a single line and
  grows to a multi-line box only while it is focused or holds text, so the
  card stays compact above the form. Its one action is **Apply changes**
  (recipes-accent) → `/edit-with-ai`, whose response carries freshly
  recomputed `instructionIngredients` — applying a change is also what
  refreshes the ingredient-to-step tags. There is no separate "Tag
  ingredients to instructions" button; hand-corrections happen in the
  per-step ingredient linker.

### The photo on a recipe

A recipe carries one picture — **of the dish**, never of the page it was printed
on. It is the thumbnail on every row of the recipe library and the hero at the
top of the recipe, and a recipe without one shows the fork-and-knife placeholder
rather than a stand-in.

- **The user can add one.** The add/edit form has a Photo row (thumbnail, label,
  and Add/Change) inside the title card; the whole row is the tap target, and it
  offers Take Photo / Choose Photo / Remove Photo. It is **not** the quick
  importer beside it, and the two are not interchangeable: the importer reads a
  recipe *out of* a photo of a page and is metered as an AI scan, while this
  attaches a picture *of the dish* through `POST /recipes/photo` — no AI, no
  meter, no AI-consent gate. The photo uploads when it is picked, so the form
  field holds a server path the sealed record can carry, and the save stays one
  small write.
- **A URL import takes the page's own photo.** The hero image a recipe page
  advertises to link previews (`og:image`, else `twitter:image`, else the
  schema.org JSON-LD `image`) is read from the **raw** HTML — by the time the
  text reaches the model, the `<meta>` tags have been stripped — and **copied
  here** rather than hot-linked: a remote `<Image>` would announce to that site
  every time the household opens the recipe, and the URL rots on the site's next
  redesign.
- **A photo import crops the dish out of the page, or takes nothing.** The same
  extraction call that reads the recipe is asked where the finished-dish
  photograph is (`photo`: the 1-based page plus an `x`/`y`/`w`/`h` box in
  fractions of that image), and that region alone is cropped out and stored.
  When no image shows the finished food — a hand-written card, a plain-text
  printout, a page whose only pictures are process shots or a portrait of the
  cook — the answer is `null` and **the recipe gets no photo**, which is the
  expected outcome for most printed recipes: a crop of a paragraph is worse than
  the placeholder it would replace. The box is a guess, so it is validated
  rather than trusted (non-numeric, inverted, off-page, or smaller than 8% of an
  edge / 120px is treated as "no photo"), and the far edge is clamped to the
  page — `sharp.extract` throws on a rect that spills over. **The scanned pages
  themselves are not kept**: they are photographs of someone's cookbook — the
  whole recipe in plaintext on our disk — and once the crop is taken they have
  no reader.
- **Every photo is stored the same way**: re-encoded to a JPEG no larger than
  1200px on its long edge, under `uploads/recipes/<key>.jpg` where the key is 16
  random bytes. `/uploads` is served unauthenticated (as it is for every
  attachment), so the filename is the capability.
- **`imageUrl` is stored as a path, never an absolute URL**, and the API host is
  joined at display time (`lib/recipePhoto.recipeImageUri`). The API host
  differs per environment, so an absolute URL would pin a household's photos to
  whatever host they were saved from — and passing the raw stored value to
  `<Image>` renders nothing at all.
- **The client tells the server which photo a recipe kept.** `imageUrl` is
  sealed inside the record, so the server can never look at a recipe to decide
  whether a file is still wanted. Ownership is tracked by a `RecipePhoto` row
  written when the file is created — unattached, because an import produces the
  picture while the user is still deciding whether to keep the recipe at all —
  and bound to the recipe by `PUT /recipes/:id/photo` after the save
  (`imageUrl: null` removes it). The claim also drops the recipe's *other*
  photos, so replacing one doesn't leave the old bytes on disk. It is
  best-effort on the client: the recipe is already saved by then, and a failed
  claim costs a picture at worst, never an error the cook has to read. A file
  that predates this tracking is **adopted** on claim rather than rejected.
  - A claim only binds a row this household uploaded, and only clears rows on
    its own recipes; a path that isn't a recipe photo is a 400.
  - **Deleting a recipe reaps its photo.** A delete is a `/records` tombstone,
    so the server never learns the record was a recipe: it asks both reapers
    (`reapEventAttachments`, `reapRecipePhotos`), each a no-op for a record of
    the other kind.
  - **The nightly sweep reaps unclaimed drafts only** — a file whose row was
    never bound to a recipe and is older than the 24h grace window (an import
    the user abandoned, a photo picked in a form that was never saved), and its
    row with it. Before the rows existed this job asked the plaintext `Recipe`
    collection for referenced `imageUrl`s; that collection is empty post-C3b, so
    it answered "nothing is referenced" and **deleted every recipe photo in
    every household a day after upload**.

### Ingredient groups & flavor variations

- **Ingredients can carry a section, and some sections are variations.** Each
  `Ingredient` has an optional `group` label ("Base", "For the sauce", or a
  variation name); the recipe's `variations` array names the groups that are
  **mutually exclusive flavor choices** — a shared base plus e.g. a
  "Lemon Blueberry" kit and a "Chocolate Peanut Butter" kit (common in baking).
  Component sections ("For the sauce") are ordinary groups and are never listed
  in `variations`. The ingredient array stays **flat and in order** —
  `instructionIngredients` links by index, so grouping must never re-sort it
  (`lib/recipeVariations.ingredientRuns` renders consecutive runs as sections).
  Both fields are sealed content (`RECIPE_ENC`).
- **Steps are variation-tagged too.** `Recipe.instructionVariations` is
  parallel to `instructions` (sealed in `RECIPE_ENC`): `null`/`[]` for a step
  every variation shares, else the variation names the step is only for
  ("fold in the blueberries" → `["Lemon Blueberry"]`). The edit form shows a
  per-step chip row when the recipe has variations (no chips selected reads
  "All variations"; toggling tags the step), the detail page annotates tagged
  steps ("Lemon Blueberry only"), and a step tag pointing at a variation that
  was dropped on save is pruned with it.
- **Every AI path preserves the structure.** `RECIPE_SCHEMA` +
  `GROUPING_GUIDANCE` teach extraction (URL/photo), generation, and
  edit-with-ai to emit `group`/`variations` **and `instructionVariations`**, so
  an imported energy-balls page arrives with its base and each flavor kit —
  ingredients and steps — already separated.
- **A meal is planned as ONE variation.** Scheduling a recipe that has
  variations records the choice on the `RecipeSchedule` (`variation`, sealed in
  `RECIPE_SCHEDULE_ENC`): the detail screen's schedule pad shows variation
  chips (first pre-selected), the Add-meal list prompts via
  `lib/recipeVariations.pickVariation` (cancel aborts the add), and the
  create-then-schedule path (RecipeForm with a `scheduleDate`) prompts too —
  there a cancel still schedules, with no choice recorded, since the recipe is
  already saved. The planner's meal row shows "Title — Variation", wrapping to
  as many lines as the name needs (never truncated to an ellipsis), with the
  meal glyph pinned to the first line.
- **The grocery list buys only the chosen kit.** `aggregateGroceryList` skips
  ingredients whose group is a variation other than the schedule's recorded
  choice; base ingredients and component groups always count. A schedule with
  **no** recorded choice fails open and buys every kit (legacy rows, or a
  declined prompt).
- **Cooking is done as ONE variation.** "Start Cooking" on a recipe with
  variations asks which one is being made (`pickVariation`, cooking wording;
  cancel doesn't start) and passes it as the `CookingMode` route's `variation`.
  Cooking mode then walks only the steps that apply — shared steps plus the
  chosen kit's, via `lib/recipeVariations.visibleStepIndices`, which returns
  **real instruction indices** so per-step ingredient tags and timers stay
  aligned — with progress counting the visible set ("Step 2 of 5"), and
  filters the other kits' ingredients out of the reference panel entirely
  (`ingredientInKit`). **The kit's name belongs in the header** ("Cooking —
  Lemon Blueberry"), not on the progress line: that line shares its row with
  the voice pill, and appending the variation there crowded it. A tagging degeneracy that would leave
  zero visible steps falls back to showing all of them. Without a chosen
  variation (recipe has none), behavior is unchanged and flavor-kit
  ingredients are annotated with their kit name instead.
- **Readers show the sections.** The detail page and the shared/exported text
  render group headers (variation groups marked "Variation"); the edit form
  shows the same headers inline (a new ingredient row continues the section
  it's added under, and a variation whose last ingredient is deleted is dropped
  from `variations` on save).
- **Sharing a recipe is device-composed** (like the household/calendar/trip
  invites — see [households-sharing.md](households-sharing.md)): `RecipeDetail`'s
  share action hands the fully rendered recipe (title, meta, description,
  ingredients, instructions, + a website link) to the OS share sheet
  (`Share.share`), so the sender picks Mail/Messages/Notes/etc. from their own
  device. The recipe is already decrypted on-device, so the content travels in
  the message and the recipient needs nothing installed. The old server-sent
  styled email (`POST /recipes/:id/share-email`, `recipe_share` template) was
  **retired 2026-08-01** — it required POSTing the decrypted recipe back to the
  server in the clear, a plaintext round-trip the share sheet removes.
- All AI capture paths are consent-gated and annotated (and refused
  server-side via `requireAiEnabled` when the account's AI toggle is off) — see
  [ai-assistant.md](ai-assistant.md).

### Meal planner & grocery

- **Above the tabs there is the period and nothing else.** The week navigator
  shows **where you are, relatively** — `This Week`, `Next Week`, `Last Week`,
  then `Three Weeks` / `Three Weeks Ago` — and beneath it a muted caption naming
  **the trip that opens the period and how far off it is** —
  `Shop Sat, Aug 15 (in 4 days)`. No date appears in the label at any distance:
  the label answers "where am I?", the caption answers "when do I shop?". The caption is deliberately **not** a tap
  target: it describes what you're looking at rather than offering to change
  something. The label itself still taps back to the current period.
  - **The span is not stated anywhere.** A period *starts* on its shopping day,
    so a range only ever restated the trip date and then added an end date
    nobody shops by. What the header has to answer is *when do I go, and how
    soon* — which is why the relative distance is in the caption.
  - `periodLabel` (`screens/kitchen/constants.ts`) counts in **weeks, not
    periods**, so a biweekly shopper's next trip reads `Two Weeks` — which is
    when it actually is; calling it "Next Week" would be a fortnight wrong.
    Words carry to twelve, then numerals (`20 Weeks`).
  - **Why the trip belongs here.** A period *starts* on its shopping day, so the
    range's first date already is the trip — but that is a rule you have to know,
    and nothing said it. Naming the date outright (`Sat, Aug 15`) is what
    replaced the range rather than sitting beside it. The whole date comes from
    one `toLocaleDateString`, so the comma and the field order follow the
    reader's locale rather than a hand-joined format. The Planner spells it out on its first day card; the
    Grocery tab carried no date at all. The shopping day is a property of the
    period, and both tabs share this header, so stating it once here serves both.
    (It lived briefly on the Grocery card instead; that belonged to one tab only.)
  - **In whichever tense is true** — `Shop Sat, Aug 15 (in 4 days)` ahead,
    `Shop Sat, Aug 15 (today)` on the day, `Shopped Sat, Aug 8 (4 days ago)`
    once it has been and gone, which is what explains why last period's list is already checked
    off instead of leaving the shopper unsure which week they are looking at.
    The state comes from `shoppingDayState` in `screens/kitchen/constants.ts`
    (with `dayStart`, the local-midnight normalization) — the same helper the
    Planner marks its day card with, because two copies would eventually
    disagree about what day it is, including about the evening UTC rollover. The
    parenthetical comes from `relativeDay` in the same module, which counts
    **calendar** days between local midnights — 23:30 tonight to 00:30 tomorrow
    is "tomorrow", not "today", however few hours separate them.
  - **Until a shopping day is configured there is no trip to name** — the period
    maths falls back to Saturday, and announcing a day nobody chose would be a
    lie the setup card above is busy asking them to fix. The range stands in as
    the period's only date context in that state, unless the label already is it.
  - This replaced a caption reading "Every week on Saturday" — a recurrence rule
    stacked under a period label with nothing to say what it referred to. A
    period header describes the period; a recurrence *rule* is configuration and
    lives in the ⋯ menu, but a concrete trip date is a fact about what you're
    looking at.
- **Everything this screen leads to lives in one nav-bar overflow menu.** The
  `⋯` button — the only thing in `headerRight` — opens an **untitled**
  `BottomSheet` action list holding **Recipes**, **Grocery Shopping Schedule**,
  and **Grocery List Sections**. Untitled because the nav bar behind it already
  says "Meals" and every row states what it is; the button keeps
  "Meals options" as its `accessibilityLabel`, where the words describe the
  control rather than the contents. Each settings row states its current
  value ("Every week on Saturday") so the menu answers the question without the
  user having to open the screen behind it. Rows are named for the screens they
  open — a row whose words don't match the title it lands on reads as a wrong
  turn — and each carries a single `accessibilityLabel` joining title and value,
  or VoiceOver reads them as two unrelated strings. All three previously had entry points scattered
  into the chrome or the content: Recipes as a title-shoving header button, the
  schedule as a hero card above the list, the section order as an unlabelled
  sort glyph on the grocery card. All three are gone. Closing is caller-driven (flip `visible`, then navigate) per the
  sheet rules in [mobile/CLAUDE.md](../../mobile/CLAUDE.md), so the sheet leaves
  instantly instead of animating out over the pushed screen.
- **The setup card survives, and only the setup card.** While no shopping day is
  chosen the full card stays at the top of the Meals view: "Not set — tap to
  choose a shopping day" is a real call to action, and the whole screen's period
  maths hangs off the answer. Once a day *is* set the card would only be echoing
  a setting, so it goes and the week nav takes over the top padding it supplied.
- **The shopping day is stated where it explains something.** It is not in the
  period header; it is on the planner's first day card — the card *is* the
  shopping day, because a period starts on it (`periodStartOf` snaps to the
  grocery day). That placement answers the question the header never could: why
  the planner always opens on a Saturday.
  - **A day card is headed `Sat, Aug 29`** — weekday, month, and date, from one
    `toLocaleDateString` so the comma and the field order follow the reader's
    locale. It used to read `Sat 29`, which forced the reader to carry the month
    down from a header that no longer states one (the period label is relative
    now). The same format spells the trip in the period caption, so the shopping
    card and the caption naming it are written identically.
  - **The marker says which shopping day it is**, because a period opening on
    its own shopping day means the period you're standing in almost always opens
    on a trip you already took — 6 days out of 7 the trip you're preparing for
    belongs to the *next* period. Periods tile end to end, so this period's
    shopping day is the **next upcoming** one exactly when it hasn't passed and
    the previous period's has (`shoppingDayState`, shared with the Grocery
    pane's trip line; the marker treats `today` as upcoming):
    - `next` → **Next Shopping Day** in the section accent, and the card carries
      a standing accent ring + faint wash. This is the highlight; it is lighter
      than the deep-link focus ring, which is transient and answers a different
      question ("the day you tapped"), and is listed first so focus still wins.
    - `past` → **Shopped**, muted. A trip already taken is a fact about the past,
      not a thing to act on; labelling it "Grocery Shopping Day" presented a
      finished trip as the one ahead.
    - `later` → **Shopping Day**, plain. True but not next.
  - The marker is plain text, not a link into the schedule: configuration lives
    in the `⋯` menu now.
  - **Day comparisons here normalize to local midnight first.** `iso()` reads the
    *UTC* date, which is fine for the local-midnight dates the period maths
    produces but wrong for `new Date()`, which carries a time: after ~8pm Eastern
    the UTC day has already rolled over, so both the "Today" pill and the
    shopping-day marker would read a day ahead. This was a live defect in the
    "Today" pill before the marker was built on the same comparison.
- The planner schedules recipes onto dates: `RecipeSchedule`
  (recipeId, scheduledDate, servings, notes). Since C3b its CRUD rides the
  opaque record store (`/records`), not the legacy `/recipe-schedule` collection
  routes — only the grocery-organize and shopping-session endpoints there are
  still live.
- **The planner's week window is built on-device** (`lib/mealSchedule.ts`). The
  store is content-blind and filters the decrypted replica by field *equality*
  only, so neither a `start`/`end` date range nor a populated `recipeId` ref can
  come back from the server: the client selects the days in range itself and
  joins each schedule's recipe title from the Recipe replica. A schedule whose
  recipe is missing still renders (titled "Recipe") rather than vanishing.
  Passing a range param through to the store instead matches no field and
  silently returns nothing — the defect that made every scheduled meal invisible
  in the Meals view *and* emptied the grocery list; `recordStore.list` now warns
  in dev when a filter names a field no record carries.
- The grocery list is **derived** by aggregating ingredients across the planned
  week (`lib/groceryAggregate.ts`, `groceryList.ts`), with an AI tidy pass
  (`POST /recipe-schedule/organize-grocery-list`).
- **Organize renames items for the aisle, not for the recipe.** An ingredient is
  written for cooking ("garlic cloves, minced", "fresh basil leaves"), but the
  shopping list is read while walking a store, so every organized item name is a
  Title Case label with the prep clause and filler gone: "Garlic Cloves" · 3
  cloves, "Basil" · 2 tbsp. Words that change *what gets bought* stay ("Ground
  Beef", "Smoked Paprika", "Unsalted Butter", "Whole Milk"); the amount stays in
  the amount field, never in the name. The prompt asks for this shape, and the
  response is then normalized server-side (`services/groceryNames.js`,
  `normalizeOrganizedList`) — a model is not reliable about casing or about
  dropping every prep tail, so the prompt sets the intent and the normalizer
  makes it deterministic. It strips the clause after a comma / dash /
  parenthesis, leading and trailing prep participles, and herb form words
  ("leaves", "sprigs"), never reducing a name to nothing, and merges items whose
  cleaned names collide inside a section (joining their amounts) so the cleanup
  can't produce a visible duplicate row. Section names come from the household's
  own order and are left untouched.
  - **Spoon units are abbreviated**: an amount reads "2 tbsp" / "1 tsp", never
    "2 tablespoons" / "1 teaspoon" — the long word eats a row that is scanned,
    not read. Recipes spell them a dozen ways
    (tablespoon/Tablespoons/Tbsp./tbs/tbls, teaspoon/tsp/tspn) and every
    spelling collapses to the one short form (`shopperAmount`). The
    **single-letter** forms are deliberately left alone: `T` vs `t` is
    ambiguous, and guessing wrong turns a teaspoon into a tablespoon. Every
    other unit (cups, cloves, lb, oz) rides through untouched — this is a unit
    *spelling* pass, not a measurement parser. Amounts are shortened before the
    duplicate merge compares them, so "2 tablespoons" and "2 tbsp" dedupe into
    one amount instead of both being listed.
  - **A section with nothing in it doesn't get a header.** The household's
    section order constrains the model to a fixed list, so it routinely returns
    sections the week's meals never filled (and the name cleanup can empty one
    on its own) — a bare "Bakery" over no rows reads as a list that failed to
    load. `normalizeOrganizedList` drops them, and `GroceryPane` skips them at
    render as well, because an organized list built before that shipped is
    persisted in `ShoppingSession` and would otherwise keep showing its empty
    headers until the user re-organizes.
- **The grocery card's header holds identity on the left and the card's one
  action on the right.** The title block stacks — "Grocery List" with the
  `n of m` shopping progress as a status line beneath it — and the **Organize**
  pill sits on the title's line: an accent-filled button with the app's
  `sparkles` glyph, marking it as the one thing here that spends a credit (the
  `CreditsBanner` sits just below). This row once read as crowded with *four*
  things on one baseline (title, count, Organize, a sections glyph); the glyph
  left for the Meals options menu and the count moved under the title, so two
  columns fit comfortably. The row is **top-aligned**, not centred: the ⓘ hint
  expands the title block downward, and a centred button would drift away from
  the title it belongs to.
  - **The label is always "Organize" — never "Re-organize".** The button runs
    the same AI filing in every state, and the "Re-" prefix asserted a history
    the shopper may not have: a list filed by hand, or one a household member
    organized on another device, both arrive looking like nobody's prior AI
    run. One verb for one action.
- **The organized list, once it exists, is THE list — there is no plain-list
  view.** The flat aggregate renders only until the first organize (or first
  manual move) creates sections; after that, every item is visible in the
  organized view — filed rows in their sections, everything else under New
  Items — so a second arrangement of the same rows had nothing left to say.
  (The pane briefly had a Plain list ⇄ By section toggle; it was removed once
  New Items guaranteed nothing could hide.)
  - Because the organized list is permanent, it has to stay honest as the
    plan keeps moving — and it does so **by local patching, not by retiring**
    (retiring made every mid-week recipe add cost a credit to get sections
    back). Organize stamps the session with `organizedFor` — a fingerprint of
    the items it ran over (cleaned name → portion signature,
    `lib/groceryOrganize.groceryFingerprint`) — and on every later visit the
    saved list is reconciled against the current week
    (`reconcileOrganizedList`), deterministically and free:
    - **Added** ingredients appear in a **New Items** section, first in the
      list — the shopper has to notice them precisely because no aisle claims
      them yet.
    - **Removed** ingredients drop their organized rows (a section emptied this
      way disappears with them).
    - **Re-portioned** items (a servings change, a second recipe needing the
      same thing) get their amount rewritten with the deterministic entries
      join — no AI consolidation, but never wrong.
    - Matching is by cleaned name, which is why the normalizer is a **shared
      package** (`@household/grocery`) used verbatim by the server's organize
      response and this client-side patch — two copies would drift and misfile
      every reconcile. A row the AI renamed beyond the normalizer matches no
      key and is left untouched: a lingering row beats deleting a real one.
    - A list saved before fingerprints shipped carries none and **diffs
      against an empty fingerprint**: nothing is ever dropped on the strength
      of a missing fingerprint, but any item its rows don't cover surfaces
      under New Items. With no plain list to fall back on, a stale legacy list
      that "trusted as-is" could silently hide groceries — a duplicate-looking
      row (one Re-organize or manual move fixes it for good) beats an
      invisible one.
- **Sections can also be built and edited by hand — no AI, no mode.**
  - **Tapping an item's name opens a `BottomSheet` titled "Grocery List
    Sections"** — the same words the settings screen that *orders* those
    sections uses, because the rows in the sheet are that same list. It holds
    the household's sections in their walking order (else the standard walk,
    `DEFAULT_SECTIONS` in `lib/groceryOrganize` — one constant shared with the
    Grocery List Sections screen), plus any section the list already has; the
    row's current section is marked and just closes. The item being filed is a
    caption line under the title ("Move Seedless Dates to:"), not the title
    itself — set tight to the title above it and to the rows below (`Hint`'s own
    paragraph margin is cancelled: at full spacing the caption floated in the
    middle of a gap, belonging to neither) — titled with the item, the sheet read as a detail page *about*
    "Seedless Dates", which made the section rows look like facts about the
    item rather than the places it could go. Filing a row is `moveItemToSection`: the emptied
    section disappears, and a section not yet in the list is created **at its
    place in the walking order**, not appended.
  - There is deliberately **no "sort manually" button or mode**: the gesture is
    standing, and when nothing is organized yet the first move *creates* the
    organized list (the commit seeds an empty list, files the whole week under
    New Items, and applies the move). Manual organizing is assumed, not opted
    into.
  - A manual move **commits the patched list** as the saved organized list and
    stamps the current fingerprint — what the shopper arranged is what persists,
    and the patch stops being recomputed against a stale baseline.
  - The gesture is explained by an **ⓘ `HintDisclosure` on the card's title**
    ("Tap an item to move it into a section.") — the app-wide disclosure
    pattern, the whole title row as the toggle, replacing the earlier inline
    hint under the New Items header. Per mobile/CLAUDE.md the glyph is the
    information circle, never an eye.
  - Shopping state (checked / not-found / have-at-home / substitution) is keyed
    by the **displayed name** — organizing renames rows, so state written
    against the flat pre-organize list doesn't carry onto the renamed rows.
  - **The `n of m` progress counts the rows on screen**, not the raw aggregated
    list — both the done tally and the total (they legitimately differ: Organize
    merges items). Counting the raw list under the organized view is what once
    froze the progress at `0 of 13`.
  - Every control on an item row is a wordless icon, so each carries an
    `accessibilityLabel` naming both the action and the item ("Not in the store:
    Basil"); the check box is a `checkbox` role carrying the item name and its
    checked state. Without them a row announces as a name followed by four
    anonymous buttons.
- **The list is not only what the meal plan implies — items are added by
  hand.** The week's list is *derived* from the planned recipes, which left no
  way to buy paper towels, coffee, or anything else a recipe never mentions. An
  **Add item** row sits at the **foot of the list** (a quiet ghost row with a
  `add-circle-outline` glyph in the section accent — the card's one *filled*
  control stays Organize, the thing that spends a credit), and it also renders
  under the empty state, where "the plan isn't the only source" most needs
  saying: a shopper with nothing planned would otherwise read the card as
  unusable.
  - Tapping it opens an inline **Item + Amount** pair with an accent **Add**
    button. Adding **keeps the field open and emptied** for the next thing (the
    multi-add convention in mobile/CLAUDE.md — a shopper adds three items, not
    one), so there is no Done: an empty submit, or blurring both empty fields,
    closes the row.
  - The typed name is **title-cased on the way in** (`titleCase`, the shared
    `@household/grocery` casing every other name on the list goes through) —
    casing only, so nothing the shopper wrote is stripped or re-spaced. Adding a
    name already on the list **updates it** rather than stacking a second row.
  - Hand-added rows live in the shopping session as `state.extras`
    (`{ name, amount? }`), which makes them **per shopping period and shared by
    the household**, like every other thing the shopper (rather than the plan)
    decides. They are merged into the derived list on-device by
    `lib/groceryExtras.mergeExtraItems`, **as ordinary `GroceryItem`s** —
    alphabetical among the ingredients, and from there indistinguishable: they
    check off, substitute, mark not-found/at-home, file into sections, ride
    along to Organize, and reconcile like anything else. A typed amount becomes
    a single source **entry**, not just the display `amount`, because the
    fingerprint and the reconcile patch both read `entries` — an amount living
    only on the row would be blanked by the first Organize.
  - An extra whose cleaned name **collides with something the plan already
    buys** is dropped as a duplicate rather than rendered twice, and the
    surviving row belongs to the recipe.
  - **Only a hand-added row can be taken off the list**, by swiping it (shared
    `SwipeableRow`, native confirm — an interior row, so its revealed action
    carries a small radius on both edges). An ingredient's row belongs to the
    meal plan; the way to lose it is to unschedule the meal, and the confirm on
    an extra says so ("Your meal plan is unchanged."). Matching a displayed row
    back to its extra is by **cleaned name** (`shopperName`, lowercased) — the
    same key space the organized list matches in, since an extra that reaches a
    section has been through the normalizer.
  - **Clear** clears shopping *state* (checked / not-found / substitutions /
    at-home); it does not empty the list, so hand-added rows survive it.
- Shopping progress persists per week in `ShoppingSession`
  (`weekStart` + a `state` blob — checked / not-found / at-home /
  substitutions / `extras` / `organizedList` + `organizedFor`):
  `GET/PUT /recipe-schedule/session`. The
  session is **household-shared** (one row per household × week, carrying
  `householdId` routing so the household scope clause can match and upsert it);
  moving a meal across shopping weeks invalidates the affected weeks'
  `organizedList` while leaving the rest of the state (checked items) intact.
- **A planned meal is removed by swiping it, not by a delete glyph.** Each meal
  row on a day card is a shared `SwipeableRow` (components/ui): the row's own tap
  opens the recipe, and swiping it left reveals **Remove**, which raises the
  native confirm before anything is taken off the plan. Because a meal row is a
  short interior row, its revealed action is the **word alone** — the trash glyph
  belongs to the taller recipe-library card, and stacking both in a ~28pt row
  crushes the pair. The reveal is undoable in place: swiping back (or tapping the
  open row) puts the action away, and the screen's back gesture is suspended for
  as long as a row is open, so the swipe that undoes the reveal can't be read as
  a swipe out of the Meals view. The row carries no
  persistent ✕ — a delete target parked on a row the user overwhelmingly means to
  open is a mistap waiting to happen. The confirm says the recipe stays in the
  library, because removing a *scheduled meal* is not deleting the *recipe*
  (that deletion lives on the recipe library's own swipe action). The row's
  glyph is `RECIPE_ICON` in white — the same meal glyph every calendar surface
  uses, and white rather than the app primary because the accent in this area
  belongs to the card chrome, not to per-row icons.
- **Deleting a recipe deletes its planned meals with it.** Both delete doors —
  the library card's swipe action and the edit form's Delete button — run the
  same cascade (`lib/recipeDelete.deleteRecipeWithSchedules`): every
  `RecipeSchedule` pointing at the recipe is deleted first, then the recipe.
  The cascade is the **client's job of necessity** — a schedule's `recipeId` is
  sealed content, so the server can never find "the schedules of this recipe"
  to clean up after the `/records` tombstone. Details that matter:
  - Schedules are matched with `scheduleRecipeId` (not the record store's
    equality param), so legacy rows carrying the populated `{ _id, title }` ref
    shape are found too — and **past meals go as well**: a dangling schedule is
    pure debris (the planner and calendar render it as the literal word
    "Recipe", and the grocery aggregation skips it).
  - The **schedules-first ordering is load-bearing**: a cascade that dies
    partway (offline, a crash) leaves the recipe in the library to retry, never
    a deleted recipe with orphaned meals behind it.
  - Both confirms say the meals go too ("…and any meals planned with it will be
    permanently removed") — the say-what-actually-gets-destroyed rule
    (mobile/CLAUDE.md), mirroring how the planner row's Remove confirm promises
    the recipe *stays*.
  - **The edit form's delete never lands back on the dead recipe.** The form is
    usually pushed by the recipe view's pencil, so a plain goBack returned to
    the RecipeDetail of the recipe that was just deleted — a screen whose query
    can only 404. After deleting, the form pops past that detail when it sits
    directly underneath (`popCountAfterDelete`), landing wherever the recipe
    was opened from (library, planner, calendar); a form reached without a
    detail underneath (the calendar's edit shortcut) still pops a single step.
  - **The grocery list follows on its own — no step in the cascade touches
    it.** The week's list is derived from schedules + recipes on every visit,
    so the deleted recipe's ingredients drop out of the aggregation by
    construction; and a saved **organized** list is already reconciled against
    the current week by fingerprint (`reconcileOrganizedList`, above): the
    removed items' rows drop (an emptied section with them) while the shopper's
    sections, checked / have-at-home / not-found / substitution state, and
    manual filing survive untouched. Deleting a recipe never retires an
    organized list or costs a credit.
- **The Meals header carries one action.** The recipe library used to sit in
  `headerRight` as a wide text button, which pushed the "Meals" title off the
  centre every other view in the app centres its title on. Recipes is a
  destination, so it moved into the `⋯` menu as its first row — above the two
  settings, since it's the one you reach for most — and the header is left with
  the overflow button alone. In the menu the row carries the shared
  `RECIPE_ICON`, unlike the retired header button which was deliberately
  glyphless: a row without one would hang off the icon column the other rows
  establish.
- **A recipe's schedule card links into the planner.** `RecipeDetail` shows the
  recipe's soonest still-to-come meal as "Next scheduled" (falling back to
  "Last scheduled" when nothing is coming up — `featuredSchedule` in
  `lib/mealSchedule.ts`, which sorts the rows because the record store returns
  them in no order). When that date is **upcoming**, it is a tap target: it
  reads in the section accent with a chevron and opens the Meals view on the
  shopping period containing that day, scrolled to it and **highlighted** (a
  thicker accent ring + faint accent wash, the same focus treatment the
  Occasions timeline gives a tapped-from-calendar row). A past date is plain
  text — there is no planner destination worth landing on.
  - The navigation is `StackActions.popTo('KitchenHome', { pane: 'planner', weekStart, scrollToDate }, { merge: true })`,
    so it unwinds to the Meals view already on the stack instead of pushing a
    second one (and still opens it when the recipe was reached from elsewhere).
  - `weekStart` and `scrollToDate` are two steps, and the order matters:
    `KitchenScreen` realigns the shopping period first, so `PlannerPane` renders
    once with the *old* period still mounted. The pane therefore **ignores — and
    does not consume — a `scrollToDate` outside the period it is showing**;
    consuming it on that pass would clear the param before the right week ever
    rendered. The focus highlight is dropped whenever the period changes.
- **`pane` alone chooses the pane; `scrollToDate` never does.** The three
  `KitchenHome` params are independent (see `navigation/types.ts`), and that
  separation is what makes the calendar's **grocery cart** work: it navigates
  with `{ pane: 'grocery', weekStart: day, scrollToDate: day }` — the shopping
  list opens on that day's period, and because `scrollToDate` is consumed by
  `PlannerPane` (not by `KitchenScreen`), it survives in the route params until
  the user taps **Meal Planner**, which then lands on the shopping day,
  highlighted. Every grocery entry point passes the same three params: the month
  grid's cart chip, the List view's "Grocery shopping" row, and the day view's
  all-day grocery item.
- **Cooking mode** (`CookingModeScreen`) steps through instructions. Each step
  shows the ingredients tagged to it (`instructionIngredients`, with a
  view-all toggle) and its configured timer (`instructionTimers`) as a hint
  that starts counting down on Continue; several timers can run at once. The
  screen stays awake while open (`expo-keep-awake`; optional-required so a
  binary predating the module skips it instead of crashing).
- **A running timer outlives the screen.** Timers live in a module store
  (`lib/cookTimers`) keyed by recipe, held as wall-clock deadlines rather than
  decrementing counts, so they stay correct across a backgrounded app and
  across leaving the view — a countdown owned by the screen died with it, and
  the pot simmered on untimed. Leaving with one still counting is therefore a
  question, raised through `usePreventRemove` so it covers every exit (back
  chevron, iOS swipe-back, Android back, and the Finish button): **Keep Timer
  Running**, **Stop Timer and Leave** (destructive), or Cancel — pluralized when several
  are counting. Keeping **arms** them: one local notification per deadline,
  because an in-app buzz from a screen nobody is looking at is not an alert.
  Coming back disarms them and the chips resume alerting; stopping drops the
  timers and their alarms outright. **The hook, not a hand-rolled `beforeRemove`
  + `preventDefault`**: this is a native stack, where preventing the JS event
  alone does not stop the native pop — Cancel dropped the cook back on the
  recipe list and React Navigation warned that the screen had been "removed
  natively, but didn't get removed from JS state". `usePreventRemove` holds the
  native screen too (`preventNativeDismiss`); re-dispatching the event's own
  action is what lets the confirmed leave through, since that action carries the
  route keys it has already asked. Finished timers are cleared on the way out,
  so no stale "Done!" chip greets the next cook of that recipe. The reminder
  scheduler re-arms cook timers after its cancel-everything pass
  (`lib/notifications`), which would otherwise disarm a running kitchen timer
  on the next app foreground.
- **Cooking mode is hands-free.** Two complementary affordances, neither of
  which costs AI credits or telephony:
  - **Voice commands** (`hooks/useVoiceCommands`): an opt-in mic pill beside
    the step counter starts continuous **on-device** keyword spotting
    (`requiresOnDeviceRecognition` — audio never leaves the phone) over a fixed
    grammar: *next/continue*, *back/previous*, *go to step # / step #*,
    *read/read step/read it/repeat*, *read ingredients*, *down/scroll down*,
    *up/scroll up*, *top/scroll to top*, *bottom/scroll to bottom*,
    *ingredients down/scroll ingredients down*, *ingredients up/scroll
    ingredients up*, *ingredients top*, *ingredients bottom*, *start
    timer/timer*, *ingredients/show ingredients*. The `#` slot captures
    a spoken step number — digits, number words, or the homophones recognizers
    emit mid-sentence ("step to" → 2, "step for" → 4) — and jumps straight to
    that step; out-of-range numbers are ignored. Matching is whole-word phrase
    containment, longest phrase first, and it acts on the **first interim
    result** that matches — a final only arrives after the recognizer decides
    the utterance is over, and that beat of delay read as "it didn't hear me"
    and invited repeating the word. One utterance fires at most one command
    (the hold resets on the final). One exception to interim firing: a match
    the transcript might still extend into a longer phrase of a **different**
    command is held (`matchCouldExtend`) until a later interim resolves it or
    the final lands — a bare "ingredients" must not flip the ingredient panel
    while "ingredients down" may still be on its way (which would also swallow
    the scroll: one utterance, one command). The hold applies only while the
    match sits at the transcript's tail ("ingredients please" fires
    immediately), and longer phrases of the *same* command ("read" → "read
    step") never hold. A recognized command buzzes and flashes its
    label in the pill — **except the read commands**, which flash without the
    haptic: the narration starting is the confirmation, and a rumble right
    before the phone speaks reads as a glitch. The pill is sized to read at arm's length (fixed minWidth
    so the label flip doesn't jiggle it) and shows *Listening…* while the mic
    is live. A "Voice commands" ⓘ row under the progress bar pops up the
    **command chart** — a `BottomSheet` of grouped say-this → get-that rows
    (Steps / Read aloud / Scroll the step / Ingredients / Scroll the
    ingredients / Timer, the
    module-level `VOICE_GUIDE`, kept in step with the grammar) — replacing the
    folded prose `HintDisclosure`, which the grammar outgrew: a chart scans, a
    sentence listing fifteen phrases doesn't. Unlike dictation there is no
    silence auto-stop — the hook
    restarts the recognizer whenever the OS ends a session and listens until
    the pill is toggled off or the screen closes. It shares the singleton
    recognizer with `useDictation`; both guard with an active flag so neither
    leaks results into the other.
  - **Read-aloud** (*"read"*, *"read ingredients"*): the current step is
    spoken with on-device TTS
    (`expo-speech`, free) as "Step N. <instruction>"; *"read ingredients"*
    speaks the ingredient panel's **current** list — what the cook sees is
    what they hear: this step's tagged ingredients ("Ingredients for step N.
    …") or the full list while view-all is on ("All ingredients. …"), each as
    "amount unit name", with an empty panel flashing *No ingredients to read*
    instead of speaking. The ingredient list is read **slower** than a step
    (`rate: 0.8` vs the voice's default 1.0, `INGREDIENTS_SPEECH_RATE`) — the
    cook is measuring along, and the amounts carry all the information with
    none of a sentence's redundancy. While the phone talks the
    recognizer is **parked** (`useVoiceCommands.suspend/resume`) — an open mic
    would hear the phone's own voice, and a step text containing "next" or
    "timer" would fire commands out of the recipe — and it resumes whichever
    way the speech ends (done, stopped, error); a suspended session's trailing
    `end`/`error` events are no-ops rather than a restart or shutdown. Moving
    to another step cuts the narration short; leaving the screen never leaves
    the phone talking. `expo-speech` is optional-required like keep-awake: on
    a binary predating it, "read" flashes *Reading needs an app update*
    instead of crashing.
  - **Voice scrolling** (*"down"* / *"up"* / *"top"* / *"bottom"*,
    *"ingredients down"* /
    *"ingredients up"* / *"ingredients top"* / *"ingredients bottom"*): two
    independently paged panes. Bare commands scroll
    the **step area** (the primary content keeps the short command);
    *ingredients …* commands scroll the **ingredient panel** — noun-scoped rather
    than a spoken "focus" mode, which would be invisible state the cook can't
    see. *Top/bottom* jump straight to the pane's edge
    (`usePagedScroll.scrollToEdge`; the bottom target clamps at 0 for content
    shorter than the viewport); *down/up* move by a **partial page** — 60% of the
    visible height (`lib/scrollPage.pagedScrollTarget`, one `usePagedScroll`
    instance per pane), so consecutive commands walk through
    the whole content with overlap for reading continuity, never a jump
    straight to the bottom — clamped to the scrollable range (a "down" at the
    bottom or "up" at the top goes nowhere, and content shorter than the
    viewport never moves). Consecutive voice scrolls stack (the target is
    tracked optimistically, not read back from scroll events). Changing steps
    rewinds the step area to its top; the ingredient panel rewinds on a step
    change and on the this-step ⇄ view-all flip (its content changes under
    both). The pill flashes which pane it heard ("Down" vs "Ingredients
    down").
  - **Tap zones**: an overlay on the step area (hidden from screen readers —
    the nav buttons are the accessible path) where the right ~two-thirds
    advances and the left third goes back, so a knuckle tap works with messy
    hands. A drag still scrolls a long step.
  - Neither path finishes the recipe: *next* and the next-zone stop at the
    last step — leaving the screen stays a deliberate button tap.
- **Every recipe reader decrypts.** The store row is sealed, so any screen
  fetching a recipe must route it through `openRecord` (the list/planner paths
  go via the replica helpers, which do this). Cooking mode and the edit form's
  seed query fetched the raw row until 2026-08-11 — legacy plaintext fields
  (title, instructions) still rendered, but everything living only in the enc
  blob (per-step ingredient tags, timers) silently vanished, and an edit form
  seeded from a sealed row could save those fields back emptied.
- **Every recipe writer seals the full subset.** Only `enc`/`keyVersion` reach
  the opaque store — a field left out of the seal subset is silently dropped on
  every save, unrecoverably. Recipe saves therefore seal with the canonical
  `RECIPE_ENC` from `lib/encSubsets` (all content fields, incl.
  `instructionIngredients`, `instructionTimers`, `imageUrl`, `sourceUrl`);
  never a hand-rolled local subset. The form carried a stale local copy until
  2026-08-11 that omitted those four fields, so every recipe saved through it
  lost its per-step ingredient tags, timers, image, and source URL the moment
  the authoring device's replica row was replaced by a sync — recipes saved
  before the fix need those fields re-entered.

## Data & API surface

- **Models:** `Recipe`, `RecipeSchedule`, `ShoppingSession` (all content records;
  sealed in the opaque store — see [platform/data-model.md](../platform/data-model.md)).
- **Endpoints:** `recipes.js` (AI/utility only — sharing is device-composed),
  `recipeSchedule.js` (planner, grocery, session).
- **Client:** `screens/kitchen/*` (Kitchen, Recipes, RecipeDetail/Form,
  FindRecipes, PlannerPane, GroceryPane/Schedule, CookingMode, AddMeal,
  MealPlannerSettings).

## Encryption boundary

Recipes, schedules, and shopping state are sealed content records. Sharing is
device-composed from the decrypted on-device recipe (OS share sheet), so a
recipe's plaintext never round-trips through the server — the former
`share-email` outside-share was retired 2026-08-01. Grocery aggregation happens
on-device over decrypted recipes.

## Verification

- Planner CRUD (create with ciphertext envelope, date-range list, for-recipe,
  delete), envelope-shape validation, the week-move `weekChanged` +
  organized-list invalidation, session upsert/round-trip (incl. the
  household-routing regression this suite caught: the strict upsert through the
  scope clause 500'd until `ShoppingSession` carried `householdId`), and
  cross-household isolation — `kitchen.integration.test.js`.
- organize-grocery-list: item names + household section order reach the model
  (captured at the network edge), the shopper-name and short-unit instructions
  are in the prompt, the organized JSON returns normalized ("whole milk,
  chilled" → "Whole Milk", "2 Tablespoons" → "2 tbsp"), a non-JSON model reply
  degrades to 422, and AI-off returns 403 — `kitchen.integration.test.js`.
- The normalizer itself — title casing (incl. already-capitalized names left
  alone and hyphenated names, minor words kept lowercase mid-name), the
  casing-only `titleCase` used by recipe ingredients (prep clause kept, spacing
  and length preserved, idempotent), prep-clause stripping, filler and
  herb-form removal, the words that must survive, the never-empty floor, every
  spoon-unit spelling collapsing to tbsp/tsp while other units and the ambiguous
  single letters are left alone, the duplicate merge, and empty sections being
  dropped — `services/groceryNames.test.js`.
- AI recipe drafts parse fenced or bare and come back with ingredient names
  title-cased (title/instructions untouched, a malformed `ingredients` tolerated,
  a non-JSON reply still throwing for the route's 422) —
  `services/recipeDraft.test.js`. The device-side half — casing on read
  (`openRecipe` decrypts *then* cases, so a recipe stored lowercase displays
  right), the prep clause surviving, and the typed value never changing length —
  `mobile/src/lib/__tests__/recipeNames.test.ts`.
- The organized list renders a section header only for a section that has
  something to buy (incl. a section the model returned with no `items` key at
  all) — `GroceryPane.sections.test.tsx`.
- Hand-added items — title-casing and trimming on the way in, re-adding a name
  updating it instead of duplicating, removal by the *cleaned* name the
  organized row displays, alphabetical merge into the derived list, a typed
  amount surviving as a source entry (so a reconcile keeps it), a collision with
  something the plan already buys dropped as a duplicate and left undeletable,
  and an extra dropping its organized row once removed —
  `groceryExtras.test.ts`. The pane's half — the Add row saving a title-cased
  item with its amount and staying open for the next one, swipe-delete offered
  on the hand-added row alone, and the move sheet titled "Grocery List Sections"
  over a "Move <item> to:" caption — `GroceryPane.extras.test.tsx`.
- The progress counter advances against the organized rows (whose names never
  match the raw list's keys) and against the flat list before anything is
  organized — `GroceryPane.progress.test.tsx`.
- The header action and single view: Organize is offered (under that one label,
  never "Re-organize") when nothing is organized yet, a drifted organized list is
  patched in place (sections survive, New Items surfaces, the progress total
  follows the patched rows), Organize stays present once a list exists, and a
  pre-fingerprint saved list keeps rendering —
  `GroceryPane.organizeToggle.test.tsx`.
  The reconcile itself (fingerprint keying/stability, added/removed/re-portioned
  patches, spoon-unit abbreviation in patched amounts, the AI-renamed row left
  alone, the pre-fingerprint empty-diff that surfaces uncovered items without
  dropping rows) plus the manual machinery (section choices
  incl. AI-invented ones, filing into existing/new sections at walking-order
  position, emptied-section drop, no-op moves) — `groceryOrganize.test.ts`.
  The manual flows end-to-end (the ⓘ hint renders, a plain-list name-tap's
  first move creates the organized list and files the row with no AI call, the
  current section is marked in the sheet, Re-organize is present even with
  nothing drifted) — `GroceryPane.organizeToggle.test.tsx`.
- The shopping-day marker: the next upcoming trip is marked (incl. when it is
  today), a period whose shopping day has passed reads as `Shopped`, a period
  further out is not called next, and the whole thing reads the local day rather
  than the UTC one late in the evening — `PlannerPane.shoppingDay.test.tsx`.
- Period labels: the three either side of now, further ones in words then
  numerals, both directions, and weeks-not-periods so a biweekly next trip reads
  "Two Weeks" — `shoppingDayState.test.ts`; a far period labelled by distance
  with no date in the label, and a past one counting backwards —
  `KitchenScreen.periodHeader.test.tsx`.
- The shared date helpers (`shoppingDayState`: next / today / past / later, with
  "next" measured against the period length so biweekly reaches further, and the
  local-day read at 23:30; `relativeDay`: today/tomorrow/yesterday, counts in
  both directions, calendar days rather than elapsed hours) —
  `shoppingDayState.test.ts`. The period caption carrying the trip and its
  distance (future and past tenses, the span never appearing in the caption, the
  range shown once as the label when far out, and no trip named while the
  shopping day is unset) — `KitchenScreen.periodHeader.test.tsx`.
- The period header and the options menu: the relative label carries the
  concrete range beneath it and no schedule text, the range isn't repeated when
  the label already is the range, the `⋯` menu holds Recipes plus both settings
  (Grocery Shopping Schedule, Grocery List Sections) with their current values,
  Recipes is no longer a header button, and each row closes the sheet before navigating, and a null shopping day
  keeps the full "Not set" card — `KitchenScreen.periodHeader.test.tsx`.
- Client-side grocery aggregation/list building —
  `mobile/src/lib/__tests__/{groceryList,groceryAggregate}.test.ts`; the week
  deep-link param — `KitchenScreen.weekParam.test.tsx`.
- The recipe → planner jump: the featured-schedule pick (soonest upcoming from
  unordered rows, today counts as upcoming, past fallback, pre-C3b ISO date) —
  `mealSchedule.test.ts`; the planner's arrival (highlights the requested day and
  consumes the param, leaves the param alone while the shown period doesn't
  contain the date, drops the highlight on a period change) —
  `PlannerPane.focusDate.test.tsx`.
- The meal row's swipe-to-remove (the row's tap still opens the recipe; the
  swipe action commits nothing until the native confirm's destructive button is
  answered, and that confirm says the recipe survives) —
  `PlannerPane.mealRow.test.tsx`. The shared row underneath it (word-alone action
  on a short row vs glyph + word on a tall one; the back gesture suspended while
  open and restored on close; a right flick shorter than half the action still
  closing; tapping an open row closing it rather than deleting) —
  `mobile/src/components/__tests__/ui.swipeableRow.test.tsx`.
- The recipe-delete cascade (every schedule of the recipe removed — legacy
  populated-ref shape and past meals included — before the recipe itself; other
  recipes' schedules untouched; a no-meals recipe deleting without touching the
  schedule store; a failed schedule removal keeping the recipe retryable) and
  the post-delete pop depth (past the deleted recipe's own detail screen when
  directly underneath; one step for a different recipe's detail, the calendar
  edit shortcut, or an empty stack) —
  `mobile/src/lib/__tests__/recipeDelete.test.ts`.
- `pane` vs `scrollToDate` (a grocery arrival carrying a highlight stays on the
  Grocery pane and leaves the day unconsumed; `pane: 'planner'` opens the
  planner) — `KitchenScreen.weekParam.test.tsx`.
- The on-device recipe-title join that keeps meals from rendering as the literal
  word "Recipe" (populated ref, unknown id keeps the reader's fallback,
  already-populated and recipe-less rows survive, no input mutation) —
  `mealSchedule.test.ts`; the day view's meal/shopping glyphs and recipe name —
  `dayViewLayout.test.ts`.
- The on-device planner window (inclusive range filter, day sort, recipe-title
  join, missing-recipe fallback, pre-C3b ISO `scheduledDate`) —
  `mobile/src/lib/__tests__/mealSchedule.test.ts`; the equality-only store
  contract that forces it — `recordStore.test.ts`.
- Cooking mode decrypts the sealed row through `openRecord` and renders the
  current step's tagged ingredients (that step's only, not the whole list) and
  the next step's timer hint after advancing —
  `CookingModeScreen.stepData.test.tsx`.
- Leaving with a timer still counting: a clean exit is silent, a live one is
  blocked and offers keep / stop / cancel, Cancel keeps the cook on the screen
  with the countdown intact, Keep arms a deadline notification and the timer
  survives the unmount (disarming when the screen comes back), Stop drops it
  from the store — `CookingModeScreen.timerGuard.test.tsx`.
- Hands-free navigation: voice mode is opt-in and starts on-device continuous
  recognition with interim results, keywords navigate steps, the first matching
  interim acts immediately and the same utterance can't re-fire (resets on the
  final), a spoken step number jumps to that step with out-of-range ignored,
  "next" is ignored on the last step, mic-off aborts the recognizer, an
  OS-ended session restarts while listening, "read" speaks the step with the
  recognizer parked (no restart on the aborted session's `end`; speech
  finishing resumes it) and a step change cuts the narration, and the tap
  zones advance/go back (stopping at the last step), "down"/"scroll up" and
  "top"/"bottom" ("ingredients top"/"bottom" for the panel, toggle untouched)
  are recognized scroll/jump commands, "read ingredients" speaks the panel's
  list with the mic parked, and the "Voice commands" row pops up the command
  chart sheet — `CookingModeScreen.voice.test.tsx`. The
  voice-scroll paging itself (60% pages that stack, clamped at both ends,
  short content never moves, unmeasured viewport is a no-op) —
  `mobile/src/lib/__tests__/scrollPage.test.ts`. The keyword
  grammar itself (whole-word containment, case/punctuation-insensitive, longest
  phrase wins, number slots as digits/words/homophones, a slot phrase without a
  number not matching) — `hooks/__tests__/useVoiceCommands.test.ts`.
- The canonical Recipe seal subset carries every persisted content field
  (incl. per-step ingredient tags, timers, image and source URLs) —
  `mobile/src/lib/__tests__/encSubsets.test.ts`.
- The recipe title's enforced first capital (lowercase first letter raised,
  already-capitalized / empty / non-letter-first values passed through, the
  rest of the string untouched) — `mobile/src/lib/__tests__/strings.test.ts`.
- The recipe library's list shape: the All view lists a multi-tagged recipe
  once with no section headers, a selected chip narrows to that tag's recipes
  under a single header, and Untagged collects the tagless —
  `RecipesScreen.tagFilter.test.tsx`.
- Recipe content storage rides the opaque record store — verified under
  [platform/data-model.md](../platform/data-model.md); the born-encrypted
  write-guard in `e2eeMandate.integration.test.js`.

## Open questions

- Confirm whether `ShoppingSession.state` (Mixed) is sealed like other content or
  stored plaintext, and pin it in [platform/data-model.md](../platform/data-model.md).
- Document the meal-planner week model + settings (`MealPlannerSettingsScreen`).
