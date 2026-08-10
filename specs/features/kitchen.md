---
title: Kitchen (recipes, meal planning, grocery)
status: current
last-verified: ddaa21b+ (2026-08-10); the recipe add/edit form guards against discarding unsaved edits with the shared `useUnsavedChangesGuard` "Discard Changes?" prompt (2026-07-29); recipe sharing is now device-composed via the OS share sheet (`RecipeDetail` `Share.share`) — the server-sent styled email (`POST /recipes/:id/share-email`) was retired 2026-08-01, removing the decrypted-recipe plaintext round-trip (2026-08-01); kitchen search fields (Recipes search, Add-meal header search, step ingredient-linker browse search) set `autoCapitalize="none"` + `autoCorrect={false}` per the app-wide input-hint convention (mobile/CLAUDE.md) (2026-08-10); the meal planner's week window + recipe-title join moved on-device (`lib/mealSchedule.ts`) — the leftover `{start,end}` range param hit the record store's equality-only filter and emptied both the Meals view and the grocery list (2026-08-10); a recipe's upcoming "Next scheduled" date is now a link into the meal planner — it opens the Meals view on that shopping period with the day scrolled to and highlighted, and the featured-schedule pick moved to `lib/mealSchedule.featuredSchedule` (sorted, so "next" is genuinely next) (2026-08-10); planner meal rows lost their red ✕ for swipe-to-Remove behind the native confirm, and the `SwipeableRow` that was local to `RecipesScreen` was promoted to the shared kit (components/ui) so both use one implementation (2026-08-10); the grocery cart now queues a planner highlight for the shopping day (`pane` alone picks a pane — `scrollToDate` no longer implies the Planner), scheduled meals get their real recipe name back on the calendar via an on-device title join (`lib/mealSchedule.populateRecipeRefs`), and the meal/shopping glyphs moved to shared `RECIPE_ICON`/`GROCERY_ICON` constants used by the month grid, list, day view, search, and the planner (2026-08-10); the shared `SwipeableRow`'s revealed action now follows the row's measured height — the word alone on a short interior row (the planner meal row, where the glyph + word pair didn't fit), glyph over word on a tall card — and the reveal became undoable: swipe back or tap the open row to put it away, with the screen's back gesture suspended while any row is open so the undo swipe stops popping the user out of the Meals view (2026-08-10)
code:
  - mobile/src/screens/kitchen/
  - server/src/routes/recipes.js
  - server/src/routes/recipeSchedule.js
  - server/src/models/{Recipe,RecipeSchedule,ShoppingSession}.js
  - mobile/src/lib/{groceryList,groceryAggregate,mealSchedule}.ts
tests:
  - server/src/test/kitchen.integration.test.js
  - mobile/src/lib/__tests__/{groceryList,groceryAggregate,mealSchedule,recipeIconTarget}.test.ts
  - mobile/src/screens/kitchen/__tests__/{KitchenScreen.weekParam,PlannerPane.focusDate,PlannerPane.mealRow}.test.tsx
  - mobile/src/components/__tests__/ui.swipeableRow.test.tsx
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
- CRUD is through the opaque record store (`/records`), not a per-recipe REST
  route. The `recipes` router is **AI/utility only**: `POST /recipes/from-url`,
  `/from-photo`, `/from-ai`, `/generate`, `/edit-with-ai` (capture/generate),
  `/suggest-recipes`, `/compute-ingredient-tags`.
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
- Shopping progress persists per week in `ShoppingSession`
  (`weekStart` + a `state` blob): `GET/PUT /recipe-schedule/session`. The
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
- **The Meals header's Recipes button is text only** — no book glyph. The word
  is the affordance; an icon beside it just repeats the label.
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
- **Cooking mode** (`CookingModeScreen`) steps through instructions with timers.

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
  (captured at the network edge), the organized JSON returns, a non-JSON model
  reply degrades to 422, and AI-off returns 403 — `kitchen.integration.test.js`.
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
- Recipe content storage rides the opaque record store — verified under
  [platform/data-model.md](../platform/data-model.md); the born-encrypted
  write-guard in `e2eeMandate.integration.test.js`.

## Open questions

- Confirm whether `ShoppingSession.state` (Mixed) is sealed like other content or
  stored plaintext, and pin it in [platform/data-model.md](../platform/data-model.md).
- Document the meal-planner week model + settings (`MealPlannerSettingsScreen`).
