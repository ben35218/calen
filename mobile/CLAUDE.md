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

## The section accent

Each feature area has an accent colour from `useCalendarColors().colors.<area>`
(`chores`, `maintenance`, `vacations`, `recipes`, …). Tint the area's add button,
FAB, save check, spinners, empty-state CTA, and primary buttons with it — don't
default those to `colors.primary` inside an accented area.

## Loading & empty & error states

| Need | Use | Notes |
| --- | --- | --- |
| List loading | `<SkeletonList />` | Skeleton rows, not a spinner |
| Detail/other loading | `<CenteredLoader color={accent} />` | |
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
- **Standalone list card** (its own tappable Card: avatar + title + subtitle + trailing) → `<CardRow leading title subtitle right onPress titleRight />`. `subtitle` may be a node (icon-studded meta row); `right` falls back to a chevron when `onPress` is set. Keep a raw Card for bespoke cards (expandable, swipeable, flush colour-bar).
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

Do not build a custom `<Modal>` confirm dialog.

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
