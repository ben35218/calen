# Mobile app — UI conventions

Read this before adding or editing a screen. The goal is that every view reaches
for the same shared primitive instead of re-rolling one. All primitives live in
[src/components/ui.tsx](src/components/ui.tsx); design tokens in
[src/theme.ts](src/theme.ts); the grouped-form styles in
[src/components/formStyles.tsx](src/components/formStyles.tsx).

Never hard-code colours, spacing, or radii — use `colors`, `spacing`, `radius`
from the theme.

## Screen scaffolding

- **Forms / detail screens** → wrap in `<Screen>` (handles the keyboard-aware
  scroll + padding). `<Screen scroll={false}>` for a non-scrolling screen.
- **Inline dropdown under an input** (autocomplete / suggestions) → the
  keyboard-aware scroll only keeps the *input* above the keyboard, so a
  dropdown rendered below it opens exactly behind the keyboard. Attach
  `useRevealOnOpen(open, itemCount)`'s ref (with `collapsable={false}`) to the
  view wrapping the input + dropdown; `<Screen>` scrolls the pair clear when
  the dropdown opens. See `PlacesAutocomplete` / `EventInviteesScreen`.
  Picking a suggestion in a **single-value** field completes the entry —
  `Keyboard.dismiss()` so the field blurs and shows the value from its start.
  A **multi-add** field (invitees: type, pick, type the next) keeps the
  keyboard open, like a mail To: field.
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

## Headers, buttons, rows

- **Header background matches the body.** Every list / detail / form screen
  registers its navigation header with `hdr(colors.background)` +
  `headerShadowVisible: false`, so the header bar blends seamlessly into the
  screen body (`colors.background`) with no divider. Do **not** tint the header
  bar with a feature accent — the accent lives *in the body* (add button, FAB,
  save check, primary buttons), never on the header chrome. A header whose
  background differs from its body is drift, not a highlight.
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
- **Bottom sheet** (custom picker / action / confirm sheet) → `<BottomSheet visible onClose title? style? avoidKeyboard?>`. `avoidKeyboard` when it holds text inputs. Don't hand-roll a `Modal` + backdrop + slide-up `Pressable`.
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
  cells next to their close-circle remove button). A search pill built from a
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

## Known distinct patterns (intentionally not the above)

- Removable **tag tokens** (RecipeForm) are a chip with an ✕ — not the filter `Chip`.
- Calendar-grid event chips are their own tiny component, not the filter `Chip`.
- `CalendarColorsScreen`'s recolour+reset modal is a superset of `ColorPicker`.
