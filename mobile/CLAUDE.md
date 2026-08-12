# Mobile app — UI conventions

Read this before adding or editing a screen. The goal is that every view reaches
for the same shared primitive instead of re-rolling one. All primitives live in
[src/components/ui.tsx](src/components/ui.tsx); design tokens in
[src/theme.ts](src/theme.ts); the grouped-form styles in
[src/components/formStyles.tsx](src/components/formStyles.tsx).

Never hard-code colours, spacing, or radii — use `colors`, `spacing`, `radius`
from the theme.

## Presentation & dismissal — how a view opens and how it closes

The app has exactly **four** ways a view can appear. Pick by what the view *is*,
never by how important it feels. Adding a fifth, or using one of these outside
its rule, is drift.

| Idiom | Use it for | Closes by |
| --- | --- | --- |
| **Push** (the default) | Going *deeper into content* — a list → its detail → its edit form. Anything with somewhere further to drill. | Back chevron, iOS swipe-back |
| **Modal** (`presentation: 'modal'`) | A *self-contained task* you complete and dismiss, which returns nothing to a hierarchy: Print, Buy credits, a media preview. | Header **✕**, native swipe-down |
| **`<BottomSheet>`** | A picker, action list, or confirm attached to the screen *behind* it — the user never leaves the current view. | Scrim tap, grabber drag-down, Android back |
| **Headerless + floating chrome** | Full-bleed canvases only (`CalendarHome`, `CalendarDay`, `ViewerHome`), where a header bar would cover content. | The screen's own back pill |

- **The push/modal test:** can the user go *further* from here? Calendars drills
  into Add Calendar / Colours & Order / Print, so it pushes. Print produces a
  PDF and is done, so it's a modal. When genuinely torn, push — a wrong push
  costs one extra tap; a wrong modal strands the user at a dead end.
- **Every modal's ✕ is `<HeaderCloseButton>`** in `headerLeft` — the same button
  the form chrome installs, so the glyph, tap target, and "Close" label are
  identical everywhere. Use the `modalTask(title)` helper in
  [AppNavigator](src/navigation/AppNavigator.tsx); never hand-roll a
  `TouchableOpacity` + `Ionicons name="close"` in screen options.
- **Never disable swipe-back** (`gestureEnabled: false`) unless the screen owns
  the horizontal gesture for its own paging *and* supplies a visible back
  affordance. `CalendarDay` is the only such screen.
- **A modal may push inside itself.** Its children are ordinary pushes with back
  chevrons; only the modal's own root carries the ✕.

## Screen scaffolding

- **Forms / detail screens** → wrap in `<Screen>` (handles the keyboard-aware
  scroll + padding). `<Screen scroll={false}>` for a non-scrolling screen.
- **Inline dropdown under an input** (autocomplete / suggestions) → the
  keyboard-aware scroll only keeps the *input* above the keyboard, so a
  dropdown rendered below it opens exactly behind the keyboard. Wrap the
  input + dropdown pair in `<RevealWrap open count>` (components/ui); `<Screen>`
  scrolls the pair clear when the dropdown opens. Do NOT call `useRevealOnOpen`
  from the screen component itself — it renders `<Screen>`, so the hook reads a
  null scroll context and silently no-ops; the hook is only for components
  already rendered inside a Screen (e.g. `PlacesAutocomplete`).
  Picking a suggestion in a **single-value** field completes the entry —
  `Keyboard.dismiss()` so the field blurs and shows the value from its start.
  A **multi-add** field (invitees: type, pick, type the next) keeps the
  keyboard open, like a mail To: field.
- **Contact autocomplete on a share/invite field** (household invite, calendar
  outside-share) → `useRosterSuggestions(query, takenSet)` — the decrypted
  contacts roster matched by name/email/phone, resolved to primary email else
  E.164 phone. Don't re-roll the matching per screen.
- **Lists** → `FlatList` / `SectionList` (not a `ScrollView.map`). Every
  top-level, query-backed list gets pull-to-refresh:
  `refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} />}`.
- Scroll content bottom padding: `spacing.xl` by default; `96` only when a FAB
  overlaps the list.

## Text-input keyboard hints

Every text field sets `autoCapitalize` to match what it holds; anything else is
drift. The mapping:

- **Prose & titles** (event/chore/task titles, notes, descriptions, chat,
  feedback) → the default `sentences`; don't set anything. Matches Apple
  Calendar — titles are *not* title-cased.
- **Proper nouns** (person first/last/full names, trip & household names,
  city/place fields) → `autoCapitalize="words"`, plus the matching
  `textContentType` (`givenName` / `familyName` / `name`) so iOS QuickType can
  autofill.
- **Machine input** (email, URL, username, password, invite fields) →
  `autoCapitalize="none"` + `autoCorrect={false}` + the matching `keyboardType`.
- **Search fields** (every search pill/input) → `autoCapitalize="none"` +
  `autoCorrect={false}` — matching is case-insensitive, so a shifted first
  letter is pure friction.
- **Short codes** (recovery codes, PINs) → `autoCapitalize="characters"`.

## The section accent

Each feature area has an accent colour from `useCalendarColors().colors.<area>`
(`chores`, `maintenance`, `vacations`, `recipes`, …). Tint the area's add button,
FAB, save check, spinners, empty-state CTA, and primary buttons with it — don't
default those to `colors.primary` inside an accented area.

## Loading & empty & error states

**The loading rule: a content-shaped area load gets a skeleton in the shape of
what's coming; an action or wait gets a spinner.** If the user is waiting for a
region of known shape to fill in (a list, a detail page, a planner grid, an AI
result with a known layout — the recipe import's `ImportSkeleton` is the model),
shimmer that shape with `Skeleton` blocks. If they're waiting on something they
triggered (button submit, inline row action, upload, purchase/IAP or approval
wait, pull-to-refresh, pagination) or on a branch whose resolved shape is
unknown (entitlement gates, the bootstrap splash), spin.

| Need | Use | Notes |
| --- | --- | --- |
| List loading | `<SkeletonList />` | Skeleton rows, not a spinner |
| Section loading inside a rendered card | `<SkeletonRows count />` | Bare staggered lines; `SkeletonList` is too heavy in a card interior |
| Detail screen with a visible fetch | `<SkeletonDetail />` | Deep-link / push-notification entries, uncached pulls |
| Bespoke canvas (planner grid, weather, hero + cards) | compose `<Skeleton />` blocks | Mirror the real layout — see `ImportSkeleton` (RecipeForm) and `CellSkeleton` (CalendarScreen) |
| Long AI wait producing a known shape | skeleton of the result | The recipe-import precedent; a button spinner alone under-signals a multi-second wait |
| Edit-form seed, entitlement gate, unknown-shape branch | `<CenteredLoader color={accent} />` | Replica-fast seeds flash too briefly for a skeleton to help |
| Image pop-in (hero photo, static map) | `<Skeleton />` behind the image until `onLoad` | |
| Empty list | `<EmptyState icon/mdiIcon title message actionLabel onAction accent />` | `variant="inline"` inside a populated scroll view; `children` for extra links |
| Form/validation error | `<FormError>{error}</FormError>` | Renders null when empty |
| Explainer text above content | `<Hint>…</Hint>` | The muted 13px helper line |
| Optional explanation | `<HintDisclosure label hint />` | Folded away behind an **ⓘ** toggle until asked for |

**Hints are disclosed with the ⓘ, always.** An explanation that isn't required
to act belongs behind `HintDisclosure` — the whole label row is the tap target
(an 18px glyph is well under 44pt, and a question printed beside an untappable
glyph traps the user who needs the answer), and the glyph is the information
circle, filling in while open (`information-circle-outline` →
`information-circle`). Keep the revealed hint to a sentence or two. A screen
that stacks prose above its buttons reads as broken to a nontechnical user; the
same screen showing two buttons gets a tap. Any hand-rolled reveal (the
Import-options switch rows) uses the same ⓘ pair — **never an eye**, which means
"show a masked value" (a password), not "explain this".

## Headers, buttons, rows

- **Header background matches the body.** Every list / detail / form screen
  registers its navigation header with `hdr(colors.background)` +
  `headerShadowVisible: false`, so the header bar blends seamlessly into the
  screen body (`colors.background`) with no divider. Do **not** tint the header
  bar with a feature accent — the accent lives *in the body* (add button, FAB,
  save check, primary buttons), never on the header chrome. A header whose
  background differs from its body is drift, not a highlight. The tint is always
  `#fff`, never `colors.text`. Two exceptions, both WebView media viewers where
  the chrome should disappear around the content: `AttachmentPreview` and
  `PlacePreview` use pure black. A screen that re-declares its header in a
  layout effect (`TripDetail`) must still be registered with the matching
  background in the navigator, or the push transition flashes the old colour.
- **Filled accent disc vs. transparent white — the header-action rule.** A
  header button gets a solid-fill circular disc **only when it carries a feature
  accent** (`useCalendarColors().colors.<area>`). A header action in a
  non-accented area (the app-primary blue — e.g. Calendars, Contacts, Account,
  New/Subscribe Calendar, generic forms) is instead a **transparent white, thick
  icon** matching the header close **✕** — never a primary-coloured disc. A
  primary-blue disc in the header is drift; either it belongs to an accented
  area (use the accent) or it doesn't (make it transparent white).
- **Add action on a list** → in an **accented** area, `RoundIconButton icon="add"`
  in `headerRight`, `bg={accent}` (solid disc). In a **non-accented** area,
  `<HeaderIconButton icon="add" size={30} accessibilityLabel />` (transparent white).
- **Header action on a detail screen** (edit pencil / share / print) → `<HeaderIconButton icon onPress accessibilityLabel />` in `headerRight`.
- **Floating action button** (detail screen adds a sub-item, or the AI assistant) → `<Fab icon onPress bg={accent} />` (or `<Fab>` with a custom glyph child).
- **AI assistant on an add/edit form** → `<FormAssist>` at the top of the form;
  never hand-roll the card. Its header is fixed chrome — CalenChatIcon +
  "Ask Calen" + a trailing chevron — and it **defaults collapsed** (the form is
  the screen's job; the assistant is an accelerator). Pass `defaultExpanded`
  only when the user arrives from a flow whose expected next step *is* the
  assistant (a just-completed recipe import). In an accented area pass
  `accent` to tint the action button; the card chrome stays app-primary (it is
  Calen's, not the section's). `onSubmit` swaps the `/form-assist` fill for a
  screen-specific AI action (the recipe form's `/edit-with-ai`), with
  `actionLabel` naming what it does ("Apply changes" vs "Fill in the form").
  Icon vocabulary — three marks, don't cross them:
  - **`<CalenGlyph>`, the gradient "C", means "this is Calen"** — the calendar's
    assistant FAB and the "Ask Calen" card header both wear it. Its blue
    gradient is baked in and is **never tinted**, so it needs a dark/neutral
    surface behind it.
  - **`<CalenChatIcon>`** is the white-on-colour fallback for the same idea,
    used only where Calen sits on an accent-FILLED disc (the chores /
    maintenance / trips assistant FABs) and the mark must go flat white to hold
    contrast.
  - **sparkles** means a *generic* AI action, not Calen (grocery Organize,
    feature marketing rows).
- **Grouped info rows on a detail screen** → `<InfoCard>` wrapping `ListRow`s (InfoCard = a Card that hands its padding to the rows).
- **Form save/close chrome** → `useHeaderCheckButton(navigation, { onPress, loading, color: accent })`.
  Pass `color={accent}` in an accented feature area for the tinted save disc;
  **omit `color`** in a non-accented area to get the neutral transparent white
  check (matches the close ✕). Never pass `color: colors.primary`.
- **Titles/labels** — three distinct roles, don't mix them:
  - `<ScreenTitle>` = the bold 24px in-body header title on a detail screen (the
    item/recipe/event name at the top of its page).
  - `<SectionTitle>` = the bold in-form heading (add/edit forms).
  - `<SectionHeader>` = the quiet uppercase eyebrow above a group of rows/cards
    (lists & detail screens).
- **Bottom sheet** (custom picker / action / confirm sheet) → `<BottomSheet visible onClose title? style? avoidKeyboard? onShow?>`. `avoidKeyboard` when it holds text inputs; `onShow` to position content on open (Select's initial scroll). Don't hand-roll a `Modal` + backdrop + slide-up `Pressable` — the shared sheet is what supplies the slide-up, the grabber, drag-to-dismiss, the home-indicator inset, and the scrim fade, and a hand-rolled one silently drops all five. `Select`, `DateField`/`TimeField`, and `PhoneField`'s country picker all render through it.
  - Its drag lives on the **grabber/title strip only**, so a sheet holding a
    scrolling list keeps its scroll. Content sits below that strip.
  - **A picker sheet commits on dismissal.** A sheet whose content is a wheel,
    a date/time picker, or a list of options saves what it is showing when the
    user taps the scrim, drags it down, or presses Android back — the same value
    a Done button would save. The sheet is chrome around a picker, not a form to
    submit, so tapping away accepts (`DateField`/`TimeField` and the custom
    alert sheet both do this). The exception is a sheet the user never touched:
    it opens on a seeded value, and a seed is not a choice, so an untouched
    dismissal writes nothing.
  - **Who closes it decides whether it animates.** A *user* dismissal (scrim,
    grabber drag, Android back) slides out and then reports `onClose`. The
    *caller* dropping `visible` tears it down in that commit, with no exit
    animation — and that asymmetry is load-bearing, not a shortcut. iOS presents
    a Modal as its own view controller, so a second sheet mounted while the
    first is still dismissing never appears while the first keeps swallowing
    touches (the symptom is "the picker closed and did nothing, and now the form
    is frozen"). Callers close a sheet precisely when something else is taking
    the screen — the alert picker's "Custom…" opens a second sheet, the Repeat
    picker's pushes a screen — so a caller-driven close must leave instantly.
    Anything that opens a sheet or navigates from inside one MUST do it by
    flipping the caller's `visible`, never by delaying the teardown.
- **Leading disc on a row** → `<IconAvatar icon/mdiIcon bg size={44} />`
  (`radius` for a rounded-square instead of a circle).
- **Settings-style tappable row** (inside an InfoCard/GroupCard) → `<ListRow icon title subtitle onPress right />`.
- **Standalone list card** (its own tappable Card: avatar + title + subtitle + trailing) → `<CardRow leading title subtitle right onPress titleRight />`. `subtitle` may be a node (icon-studded meta row); `right` falls back to a chevron when `onPress` is set. Keep a raw Card for bespoke cards (expandable, flush colour-bar).
- **Deleting a row from a list** → wrap it in `<SwipeableRow onDelete label? actionStyle? accessibilityLabel? />`
  and let the swipe be the only affordance. Never park a persistent ✕ / trash
  glyph on the row: it's a permanent target for a mistap on something the user
  overwhelmingly wants to *open*, and it competes with the row's real tap. The
  revealed action travels with the content (not parked behind it), so the row
  underneath may be transparent — a bare row inside a Card works, not just an
  opaque Card. Pass the geometry through `actionStyle` so the action looks like
  it slid out of that particular thing: a standalone card passes its outer corner
  radius + the row gap its `marginBottom` leaves; an interior row passes a small
  radius on both edges. `onDelete` fires on tap and MUST raise the native confirm
  (below) — the swipe reveals, the confirm commits.
  The action's *contents* aren't a choice the caller makes: the row measures
  itself and shows the trash glyph over the word only when there's room for both
  (≥56pt), the word alone below that. Don't hand-tune it per screen.
  **A reveal is always undoable in place** — swiping back, or tapping the open
  row, puts it away. That undo swipe runs straight into the screen's own
  back-gesture zone, so an open row suspends `gestureEnabled` until it closes;
  without that, swiping right to undo pops the user out of the whole screen.
  Any new horizontal-drag affordance owes the same courtesy.
- **Phone number** → `<PhoneField value onChangeText label? highlight? containerStyle? fieldStyle? />`
  (country picker with flag/dial code + as-you-type formatting; emits canonical
  E.164 for storage). Never a bare `<Input keyboardType="phone-pad" />`. For a
  flush grouped-card row pass `containerStyle={fs.headField}` + `fieldStyle={fs.headInput}`;
  for a standalone bordered field pass `label`. When a flush row shares its line
  with other controls and the picker button would crowd the number (the person
  form's multi-value rows), use the picker-free `<PhoneTextField value onChangeText
  label? highlight? containerStyle? style? />` instead — no country selector; the
  user types a local number or a leading `+<country code>`, and it still emits
  E.164. Read-only display → `formatDisplay()` from `lib/phone`.
- **Text-field clear button** — `Input` (and `PhoneField`/`PhoneTextField`)
  shows an Apple-style ✕ that empties the field while it's focused and holds
  text; it auto-suppresses for multiline, `secureTextEntry`, and non-editable
  fields. Never hand-roll a close-circle clear inside an `Input`. Pass
  `clearable={false}` only for: right-aligned label/value rows (`fs.rowInput` —
  Servings, Airline, Cost…), and fields whose right edge is already occupied
  inside the field box or by an identical adjacent glyph (recipe ingredient
  cells next to their close-circle remove button). On a non-surface background
  (the blue pre-auth screens) pass `clearColor` so the ✕ matches that screen's
  placeholder tint instead of the muted grey — `authInputProps` already does.
  A search pill built from a
  raw `TextInput` (People, Calendar search) hand-rolls the same close-circle,
  with `clearButtonMode="never"` so iOS doesn't double it.
- **Buttons** → `<Button variant="primary|ghost|danger" color={accent} />`.
- **Filter pills** → `<Chip label selected onPress color={accent} />`.
- **Colour picker** → `<ColorPicker value onChange options={COLOR_PRESETS} />`.

## Destructive actions

Always `Button variant="danger"` + a native confirm:

```ts
Alert.alert('Delete X?', 'This cannot be undone.', [
  { text: 'Cancel', style: 'cancel' },
  { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
]);
```

Do not build a custom `<Modal>` confirm dialog. On a list row the trigger is
`SwipeableRow` rather than a `Button`, but the confirm is the same and is not
optional — a swipe is easy to make by accident, so nothing destructive commits
on the swipe itself.

**Say what actually gets destroyed.** Removing a scheduled meal from a day is
not deleting the recipe, and the prompt has to draw that line ("will be taken
off this day's plan. The recipe stays in your library.") — otherwise the safe
action reads as the dangerous one and the user backs out of it. Word the action
to match: `Remove` when something is being detached, `Delete` when the record
itself goes.

## Unsaved-changes guard

Any form/edit screen that can lose typed-but-unsaved data on the way out must
guard it with `useUnsavedChangesGuard(navigation, isDirty)`
([src/hooks/useUnsavedChangesGuard.ts](src/hooks/useUnsavedChangesGuard.ts)). It
listens on React Navigation's `beforeRemove`, so a single call covers **every**
exit — the header ✕, the back chevron, the iOS swipe-back gesture, and Android
hardware back — and shows the Apple-style "Discard Changes?" action sheet when
`isDirty` is true. Don't wire the confirm onto the ✕ button alone; that misses
the gesture and hardware back.

- Compute `isDirty` by comparing the live form to a baseline snapshot captured
  once the form is initialized (immediately for a create; after the edit query
  seeds for an update). A `JSON.stringify(form) !== baselineRef.current` compare
  is the norm.
- The hook returns `allowLeave` — call it right before an intentional
  programmatic exit (inside a save/delete mutation's `onSuccess`, just before
  `navigation.goBack()`) so a successful save doesn't re-prompt on its own way
  out.

## Known distinct patterns (intentionally not the above)

- Removable **tag tokens** (RecipeForm) are a chip with an ✕ — not the filter `Chip`.
- Calendar-grid event chips are their own tiny component, not the filter `Chip`.
- `CalendarColorsScreen`'s recolour+reset modal is a superset of `ColorPicker`.
