---
title: Kitchen (recipes, meal planning, grocery)
status: current
last-verified: d96d6b3 (2026-07-24)
code:
  - mobile/src/screens/kitchen/
  - server/src/routes/recipes.js
  - server/src/routes/recipeSchedule.js
  - server/src/models/{Recipe,RecipeSchedule,ShoppingSession}.js
  - mobile/src/lib/{groceryList,groceryAggregate}.ts
tests:
  - server/src/test/kitchen.integration.test.js
  - mobile/src/lib/__tests__/{groceryList,groceryAggregate,recipeIconTarget}.test.ts
  - mobile/src/screens/kitchen/__tests__/KitchenScreen.weekParam.test.tsx
---

# Kitchen (recipes, meal planning, grocery)

## Purpose

A recipe box, a weekly meal planner, auto-generated grocery lists, and a
hands-free cooking mode. Recipe capture and suggestions are AI-assisted.

## Behavior (normative)

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
  `/suggest-recipes`, `/compute-ingredient-tags`, `/:id/share-email`.
- All AI capture paths are consent-gated and annotated (and refused
  server-side via `requireAiEnabled` when the account's AI toggle is off) — see
  [ai-assistant.md](ai-assistant.md).

### Meal planner & grocery

- The planner schedules recipes onto dates: `RecipeSchedule`
  (recipeId, scheduledDate, servings, notes). Endpoints:
  `GET /recipe-schedule`, `POST`, `PUT/DELETE /:id`, `GET /for-recipe/:recipeId`.
- The grocery list is **derived** by aggregating ingredients across the planned
  week (`lib/groceryAggregate.ts`, `groceryList.ts`), with an AI tidy pass
  (`POST /recipe-schedule/organize-grocery-list`).
- Shopping progress persists per week in `ShoppingSession`
  (`weekStart` + a `state` blob): `GET/PUT /recipe-schedule/session`. The
  session is **household-shared** (one row per household × week, carrying
  `householdId` routing so the household scope clause can match and upsert it);
  moving a meal across shopping weeks invalidates the affected weeks'
  `organizedList` while leaving the rest of the state (checked items) intact.
- **Cooking mode** (`CookingModeScreen`) steps through instructions with timers.

## Data & API surface

- **Models:** `Recipe`, `RecipeSchedule`, `ShoppingSession` (all content records;
  sealed in the opaque store — see [platform/data-model.md](../platform/data-model.md)).
- **Endpoints:** `recipes.js` (AI/utility + share), `recipeSchedule.js` (planner,
  grocery, session).
- **Client:** `screens/kitchen/*` (Kitchen, Recipes, RecipeDetail/Form,
  FindRecipes, PlannerPane, GroceryPane/Schedule, CookingMode, AddMeal,
  MealPlannerSettings).

## Encryption boundary

Recipes, schedules, and shopping state are sealed content records. The
`share-email` path is a deliberate outside-share (a readable recipe snapshot to
the recipient). Grocery aggregation happens on-device over decrypted recipes.

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
- Recipe content storage rides the opaque record store — verified under
  [platform/data-model.md](../platform/data-model.md); the born-encrypted
  write-guard in `e2eeMandate.integration.test.js`.

## Open questions

- Confirm whether `ShoppingSession.state` (Mixed) is sealed like other content or
  stored plaintext, and pin it in [platform/data-model.md](../platform/data-model.md).
- Document the meal-planner week model + settings (`MealPlannerSettingsScreen`).
