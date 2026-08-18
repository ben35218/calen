import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  recipeScheduleApi, settingsApi,
  GroceryItem, GroceryExtra, OrganizedGroceryList, GrocerySessionState,
} from '../../api';
import { loadGroceryList } from '../../lib/groceryList';
import {
  DEFAULT_SECTIONS,
  groceryFingerprint, moveItemToSection, reconcileOrganizedList, sectionChoices,
} from '../../lib/groceryOrganize';
import { addExtraItem, extraKey, mergeExtraItems, removeExtraItem } from '../../lib/groceryExtras';
import { openGrocerySession, saveGrocerySession } from '../../lib/grocerySession';
import { BottomSheet, Card, Divider, Hint, HintDisclosure, Input, Skeleton, SwipeableRow } from '../../components/ui';
import CreditsBanner from '../../components/CreditsBanner';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, radius, spacing } from '../../theme';
import { iso } from './constants';

// The week's shopping list, keyed to the same week the Planner shows
// (weekStart comes from KitchenScreen so flipping panes keeps the week).
export default function GroceryPane({ weekStart, onShowPlanner }: { weekStart: Date; onShowPlanner: () => void }) {
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  const start = iso(weekStart);

  // Grocery session state (persisted server-side per week).
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [substitutions, setSubstitutions] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState<Record<string, boolean>>({});
  const [haveHome, setHaveHome] = useState<Record<string, boolean>>({});
  const [organized, setOrganized] = useState<OrganizedGroceryList | null>(null);
  const [organizedFor, setOrganizedFor] = useState<Record<string, string> | null>(null);
  // Rows the shopper added by hand — the list is derived from the meal plan, so
  // this is the only way paper towels get on it.
  const [extras, setExtras] = useState<GroceryExtra[]>([]);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAmount, setAddAmount] = useState('');
  // The row whose "Move to section" sheet is open — manual filing is the free
  // alternative to the AI call.
  const [movingItem, setMovingItem] = useState<string | null>(null);
  const [subEditing, setSubEditing] = useState<string | null>(null);
  const [subDraft, setSubDraft] = useState('');
  const hydrating = useRef(false);
  // Versioned session sync (lib/grocerySession): the server 409s a save whose
  // base version is stale, and the conflict is merged on-device. Per-week
  // version map (a pending save for last week must not poison this week's),
  // a ready gate so nothing is PUT before the initial GET settles (interacting
  // during load used to overwrite the household's saved session with the
  // pane's empty defaults), and a promise chain so this device's own saves
  // can't race — and 409 — each other.
  const versionsRef = useRef<Record<string, number>>({});
  const sessionReadyRef = useRef<Record<string, boolean>>({});
  const saveChainRef = useRef(Promise.resolve());
  const startRef = useRef(start);
  startRef.current = start;

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  // Built client-side over the decrypted recipes + schedules (Signal-parity D5
  // — ingredients are sealed content the server can't aggregate).
  const frequency = settingsQ.data?.groceryFrequency ?? 'weekly';
  const groceryQ = useQuery({
    queryKey: ['grocery-list', start, frequency],
    queryFn: () => loadGroceryList(start, frequency),
    enabled: !!settingsQ.data,
  });
  const sessionQ = useQuery({ queryKey: ['grocery-session', start], queryFn: async () => (await recipeScheduleApi.sessionGet(start)).data });

  // Push a session state into the pane's fields without triggering a save.
  const applySessionState = (s: GrocerySessionState) => {
    hydrating.current = true;
    setChecked(s?.checked ?? {});
    setSubstitutions(s?.substitutions ?? {});
    setNotFound(s?.notFound ?? {});
    setHaveHome(s?.haveHome ?? {});
    setExtras(Array.isArray(s?.extras) ? s.extras : []);
    setOrganized(s?.organizedList ?? null);
    // A fingerprint is a keyed record; anything else is a pre-fingerprint
    // session shape and means "trusted as-is until the next organize".
    setOrganizedFor(s?.organizedFor && typeof s.organizedFor === 'object' ? s.organizedFor : null);
    setTimeout(() => { hydrating.current = false; }, 0);
  };

  // Hydrate session when the week (or its saved session) loads. The fetched
  // envelope is opened through lib/grocerySession (decrypts a sealed blob,
  // falls back to legacy plaintext fields, tracks the concurrency version).
  useEffect(() => {
    hydrating.current = true;
    sessionReadyRef.current[start] = false;
    let cancelled = false;
    void (async () => {
      const opened = await openGrocerySession(start, sessionQ.data);
      if (cancelled) return;
      versionsRef.current[start] = opened.version;
      // Writes stay gated until the initial GET settled — and stay gated for a
      // sealed session this device can't open (writing blind would clobber
      // state it can't see).
      sessionReadyRef.current[start] = sessionQ.isSuccess && !opened.locked;
      applySessionState(opened.state);
    })();
    return () => { cancelled = true; };
  }, [sessionQ.data, sessionQ.isSuccess, start]);

  // Persist session on change (skip during hydration; never before the week's
  // initial fetch settled). Saves are serialized on a promise chain and go
  // through the versioned seal/merge flow — a 409 from another shopper's write
  // merges their changes in (both sides' checks and extras survive) and the
  // merged result is shown. Also write the state into
  // the query cache so a quick unmount/remount (e.g. switching Kitchen panes)
  // rehydrates the latest edits instead of the pre-edit cached value — the
  // 30s global staleTime would otherwise serve stale data without refetching.
  useEffect(() => {
    if (hydrating.current || !sessionReadyRef.current[start]) return;
    const state: GrocerySessionState = {
      checked, substitutions, notFound, haveHome, extras, organizedList: organized, organizedFor,
    };
    qc.setQueryData(['grocery-session', start], { ...state, version: versionsRef.current[start] ?? 0 });
    const week = start;
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const result = await saveGrocerySession(week, state, versionsRef.current[week] ?? 0);
        versionsRef.current[week] = result.version;
        qc.setQueryData(['grocery-session', week], { ...result.state, version: result.version });
        // A merge pulled in another shopper's changes — reflect them, but only
        // if the pane is still showing that week.
        if (result.merged && startRef.current === week) applySessionState(result.state);
      } catch {
        // Offline or retries exhausted — the next change (or refetch) retries.
      }
    });
  }, [checked, substitutions, notFound, haveHome, extras, organized, organizedFor, start, qc]);

  // The list the pane works over: the meal plan's ingredients plus the shopper's
  // own rows, indistinguishable from here on (they organize, file into sections,
  // reconcile, and check off through the same code).
  const { items: list, extraKeys } = useMemo(
    () => mergeExtraItems(groceryQ.data ?? [], extras),
    [groceryQ.data, extras],
  );

  const organize = useMutation({
    mutationFn: () => recipeScheduleApi.organizeGroceryList(list, settingsQ.data?.grocerySections),
    onSuccess: (res) => {
      setOrganized(res.data);
      setOrganizedFor(groceryFingerprint(list));
    },
  });

  function toggleSub(name: string) {
    if (subEditing === name) { setSubEditing(null); return; }
    setSubEditing(name);
    setSubDraft(substitutions[name] ?? '');
  }
  function commitSub(name: string) {
    setSubstitutions((s) => {
      const next = { ...s };
      if (subDraft.trim()) next[name] = subDraft.trim();
      else delete next[name];
      return next;
    });
    setSubEditing(null);
  }

  // Adding stays open after each save (a shopper adds three things, not one) and
  // closes itself on an empty submit or an empty blur, so it needs no Done.
  function commitAdd() {
    if (!addName.trim()) { setAdding(false); return; }
    setExtras((x) => addExtraItem(x, addName, addAmount));
    setAddName('');
    setAddAmount('');
  }
  function confirmRemoveExtra(name: string) {
    Alert.alert(`Delete ${name}?`, 'It comes off this shopping list. Your meal plan is unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setExtras((x) => removeExtraItem(x, name)) },
    ]);
  }

  const renderItem = (g: GroceryItem) => {
    // "Have at home" is the manual home-icon toggle on each row.
    const have = !!haveHome[g.name];
    const on = checked[g.name];
    const nf = notFound[g.name];
    const struck = have || on || nf;
    // When an item is substituted, its checkbox moves next to the substitution
    // note below (rendered in the substitution's accent color).
    const subbed = !!substitutions[g.name] && subEditing !== g.name;
    const row = (
      <View key={g.name}>
        <View style={styles.grocRow}>
          {have ? (
            <MaterialCommunityIcons name="home-import-outline" size={20} color={accent} />
          ) : subbed ? (
            <MaterialCommunityIcons name="subdirectory-arrow-right" size={20} color={accent} />
          ) : (
            // Every control on the row is an icon with no words, so each states
            // what it is and what it's acting on — otherwise the row announces
            // as an item name followed by four anonymous buttons.
            <TouchableOpacity
              onPress={() => setChecked((c) => ({ ...c, [g.name]: !c[g.name] }))}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !!on }}
              accessibilityLabel={g.name}
            >
              {nf ? (
                <MaterialCommunityIcons name="close-box" size={20} color={colors.error} />
              ) : (
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.success : colors.textMuted} />
              )}
            </TouchableOpacity>
          )}
          {/* The name is the move affordance: tap it to file the item into a
              section by hand (the free path — the ⓘ on the card title explains
              it). Before anything is organized, the first move is what creates
              the organized list. */}
          <TouchableOpacity
            style={styles.grocNameWrap}
            onPress={() => setMovingItem(g.name)}
            accessibilityRole="button"
            accessibilityLabel={`Move ${g.name} to a section`}
          >
            <Text style={[styles.grocNameText, subbed ? { color: accent } : (struck && (nf ? styles.grocNotFound : styles.grocChecked))]}>{g.name}</Text>
          </TouchableOpacity>
          {g.amount ? <Text style={styles.grocAmount}>{g.amount}</Text> : null}
          <TouchableOpacity
            onPress={() => setHaveHome((h) => ({ ...h, [g.name]: !h[g.name] }))}
            accessibilityRole="button"
            accessibilityLabel={`${have ? 'Not at home' : 'Already at home'}: ${g.name}`}
          >
            <MaterialCommunityIcons name={have ? 'home' : 'home-outline'} size={18} color={have ? accent : colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => toggleSub(g.name)}
            accessibilityRole="button"
            accessibilityLabel={`Substitute: ${g.name}`}
          >
            <MaterialCommunityIcons name="swap-horizontal" size={18} color={substitutions[g.name] ? accent : colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setNotFound((n) => ({ ...n, [g.name]: !n[g.name] }))}
            accessibilityRole="button"
            accessibilityLabel={`${nf ? 'Found' : 'Not in the store'}: ${g.name}`}
          >
            <Ionicons name="close-circle-outline" size={18} color={nf ? colors.error : colors.textMuted} />
          </TouchableOpacity>
        </View>
        {subbed ? (
          <View style={styles.subRow}>
            <TouchableOpacity onPress={() => setChecked((c) => ({ ...c, [g.name]: !c[g.name] }))}>
              <Ionicons name={on ? 'checkbox' : 'square-outline'} size={18} color={on ? colors.success : colors.textMuted} />
            </TouchableOpacity>
            <Text style={[styles.subNote, on && styles.grocChecked]}>{substitutions[g.name]}</Text>
          </View>
        ) : null}
        {subEditing === g.name ? (
          <View style={styles.subEdit}>
            <View style={styles.subEditField}>
              <Input value={subDraft} onChangeText={setSubDraft} autoFocus onSubmitEditing={() => commitSub(g.name)} />
            </View>
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: accent }]} onPress={() => commitSub(g.name)}>
              <Text style={styles.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
    // Only a hand-added row can be taken off the list — an ingredient's row
    // belongs to the meal plan, and the way to lose it is to unschedule the
    // meal. Swipe is the affordance (no parked glyph), the confirm commits.
    return extraKeys.has(extraKey(g.name)) ? (
      <SwipeableRow
        key={g.name}
        onDelete={() => confirmRemoveExtra(g.name)}
        actionStyle={styles.extraDelete}
        accessibilityLabel={`Delete ${g.name}`}
      >
        {row}
      </SwipeableRow>
    ) : row;
  };

  // The organized list outlives the plan that produced it, so it's reconciled
  // against the week's current items on every render: added ingredients appear
  // in a "New Items" section, removed ones drop out, re-portioned ones get a
  // deterministic amount — all locally and free. `changed` is what surfaces the
  // Re-organize action, the user-triggered (billable) way to file New Items
  // into real sections.
  const patched = organized && groceryQ.data
    ? reconcileOrganizedList(organized, organizedFor, list)
    : null;


  const sectionOrder = settingsQ.data?.grocerySections?.length
    ? settingsQ.data.grocerySections
    : DEFAULT_SECTIONS;

  // A manual move edits the *displayed* (patched) list and commits it: the
  // moved row lands in its section, the patch stops being recomputed against a
  // stale fingerprint, and what the shopper arranged is what gets saved. With
  // nothing organized yet the move IS the start of manual organizing — it seeds
  // an organized list on the fly (everything under New Items, then the move),
  // which is why no separate "sort manually" mode or button exists.
  const commitMove = (target: string) => {
    if (!movingItem) return;
    const base = patched?.list
      ?? reconcileOrganizedList({ store_known: false, categories: [] }, {}, list).list;
    setOrganized(moveItemToSection(base, movingItem, target, sectionOrder));
    setOrganizedFor(groceryFingerprint(list));
    setMovingItem(null);
  };
  const movingFrom = movingItem
    ? patched?.list.categories.find((c) => (c.items ?? []).some((it) => it.name === movingItem))?.name
    : undefined;

  // The rows actually on screen. Shopping state is keyed by the name a row
  // displays, and Organize renames items ("garlic cloves, minced" → "Garlic
  // Cloves"), so the two views have different key spaces. Counting the plain
  // list while the organized one is showing is what pinned the progress at
  // "0 of 13" no matter how many boxes got ticked — the count has to be taken
  // over whatever the shopper is checking off.
  const displayed = patched
    ? patched.list.categories.flatMap((cat) => cat.items ?? [])
    : list;
  // "Done" while shopping = checked off, marked not-found, or already at home.
  const doneCount = displayed.filter((g) => !!haveHome[g.name] || !!checked[g.name] || !!notFound[g.name]).length;

  // "Add item" sits at the foot of the list, where a shopper who has just read
  // what the plan bought notices what it missed. It stays a quiet ghost row
  // rather than a second filled button — the card's one accent-filled control is
  // Organize, the thing that spends a credit.
  const addItem = adding ? (
    <View style={styles.addRow}>
      <Input
        value={addName}
        onChangeText={setAddName}
        placeholder="Item"
        autoFocus
        returnKeyType="next"
        // Multi-add, like a mail To: field — submitting saves the row and leaves
        // the field ready for the next thing.
        blurOnSubmit={false}
        onSubmitEditing={commitAdd}
        onBlur={() => { if (!addName.trim() && !addAmount.trim()) setAdding(false); }}
        containerStyle={styles.addField}
      />
      <Input
        value={addAmount}
        onChangeText={setAddAmount}
        placeholder="Amount"
        returnKeyType="done"
        onSubmitEditing={commitAdd}
        // Too narrow to hold an amount and a clear ✕ both; the field's own
        // right edge is the whole field here.
        clearable={false}
        containerStyle={styles.addAmountField}
      />
      <TouchableOpacity
        style={[styles.saveBtn, { backgroundColor: accent }]}
        onPress={commitAdd}
        accessibilityRole="button"
        accessibilityLabel="Add to the grocery list"
      >
        <Text style={styles.saveBtnText}>Add</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <TouchableOpacity
      style={styles.addToggle}
      onPress={() => setAdding(true)}
      accessibilityRole="button"
      accessibilityHint="Adds something the meal plan doesn't call for"
    >
      <Ionicons name="add-circle-outline" size={20} color={accent} />
      <Text style={[styles.addToggleText, { color: accent }]}>Add item</Text>
    </TouchableOpacity>
  );

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.pane} contentContainerStyle={styles.content}>
      <Card style={styles.grocCard}>
        {/* Identity on the left, the card's one action on the right. This row
            can carry the button again because the store-section order left it
            for the Meals options menu — what made it read as crowded was four
            things on one baseline, not two. */}
        <View style={styles.grocHeader}>
          <View style={styles.grocTitleWrap}>
            {/* The ⓘ beside the title folds away the how-to for manual filing
                (the app-wide disclosure pattern — the whole title row toggles). */}
            <HintDisclosure
              label={<Text style={styles.grocTitle}>Grocery List</Text>}
              hint="Tap an item to move it into a section."
              accessibilityLabel="How to organize items by hand"
            />
            {list.length > 0 && !groceryQ.isLoading ? (
              <Text style={styles.grocProgress}>{doneCount} of {displayed.length}</Text>
            ) : null}
          </View>
          {/* Always "Organize", never "Re-organize": the button runs the same AI
              filing whether or not sections exist yet, and the "Re-" prefix
              claimed a history the shopper may not have — a hand-filed list, or
              a session another member organized, both read as their own work. */}
          {list.length > 0 && !groceryQ.isLoading ? (
            <TouchableOpacity
              style={[styles.organizeBtn, { backgroundColor: accent }, organize.isPending && { opacity: 0.6 }]}
              disabled={organize.isPending}
              onPress={() => organize.mutate()}
              accessibilityRole="button"
              accessibilityHint="Files every item into store sections"
            >
              {organize.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="sparkles" size={14} color="#fff" />
                  <Text style={styles.organizeBtnText}>Organize</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
        <Divider />
        {/* Organize is an AI call; this card warns as the credit balance runs
            low and, at zero, explains why Organize is refused (taps to Buy credits). */}
        <CreditsBanner />
        {groceryQ.isLoading ? (
          // Placeholder rows in the checkbox-row shape (box disc + item name)
          // so the list loads into the same layout it shimmers in.
          <View style={styles.skelWrap}>
            {(['70%', '52%', '64%', '44%', '58%'] as const).map((w, i) => (
              <View key={i} style={styles.grocRow}>
                <Skeleton width={20} height={20} radius={radius.sm} />
                <Skeleton width={w} height={15} />
              </View>
            ))}
          </View>
        ) : list.length === 0 ? (
          <>
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>Schedule recipes on the Planner to build your grocery list.</Text>
              <TouchableOpacity style={[styles.planBtn, { backgroundColor: accent }]} onPress={onShowPlanner}>
                <Text style={styles.planBtnText}>Plan meals</Text>
              </TouchableOpacity>
            </View>
            {/* The empty list is exactly where "the plan isn't the only source"
                has to be visible — otherwise a shopper with no meals planned
                reads this card as unusable. */}
            {addItem}
          </>
        ) : (
          <>
            {patched ? (
              // An empty section is not a shopping stop — a bare header over no
              // rows reads as a list that failed to load. The server already
              // drops them, but a session organized before that shipped is
              // persisted in ShoppingSession, so the render skips them too.
              patched.list.categories.filter((cat) => cat.items?.length).map((cat) => (
                <View key={cat.name}>
                  <Text style={[styles.catLabel, { color: accent }]}>{cat.name}</Text>
                  {(cat.items ?? []).map(renderItem)}
                </View>
              ))
            ) : (
              list.map(renderItem)
            )}

            {addItem}

            <View style={styles.grocActions}>
              <TouchableOpacity style={[styles.clearBtn, { backgroundColor: accent }]} onPress={() => { setChecked({}); setNotFound({}); setSubstitutions({}); setHaveHome({}); }}>
                <Text style={styles.clearBtnText}>Clear</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </Card>
      {/* Where should this item go? The title names what the list beneath it IS
          — "Grocery List Sections", the same words the settings screen that
          orders them uses — and the item being filed is the caption under it. An
          item-named title ("Seedless Dates") read as a detail sheet about the
          item, leaving the section rows looking like facts about it. */}
      <BottomSheet visible={!!movingItem} onClose={() => setMovingItem(null)} title="Grocery List Sections">
        {movingItem ? <Hint style={styles.moveCaption}>Move {movingItem} to:</Hint> : null}
        {sectionChoices(patched?.list ?? null, settingsQ.data?.grocerySections).map((section) => {
          const current = section === movingFrom;
          return (
            <TouchableOpacity
              key={section}
              style={styles.sectionRow}
              onPress={() => (current ? setMovingItem(null) : commitMove(section))}
              accessibilityRole="button"
              accessibilityLabel={current ? `${section}, current section` : `Move to ${section}`}
            >
              <Text style={[styles.sectionRowText, current && { color: accent }]}>{section}</Text>
              {current ? <Ionicons name="checkmark" size={20} color={accent} /> : null}
            </TouchableOpacity>
          );
        })}
      </BottomSheet>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  grocCard: { padding: 0, paddingTop: spacing.md },
  // flex-start, not center: the ⓘ hint expands the title block downward, and a
  // centred button would drift away from the title it belongs to.
  grocHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  // Stacked, not a baseline row: the count is a status line under the title,
  // not a second title beside it.
  grocTitleWrap: { flex: 1 },
  grocTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  grocProgress: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginTop: 2 },
  // Filled = this one spends a credit. `alignSelf` keeps it hugging its label
  // instead of stretching the width of the card.
  organizeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: radius.sm, paddingVertical: 7, paddingHorizontal: 12, minHeight: 32 },
  organizeBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  saveBtn: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  catLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: 2 },
  grocRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, paddingHorizontal: spacing.md },
  // The tappable name: the touchable takes the row's flex so the whole
  // name-width is the move target, not just the glyphs of the word.
  grocNameWrap: { flex: 1 },
  grocNameText: { fontSize: 15, color: colors.text },
  // The subject line the sheet's title used to carry, now that the title names
  // the list of sections instead. It belongs to the title, so it sits tight
  // under it and tight above the rows — `Hint`'s own paragraph margin (a full
  // spacing.md) left it stranded in the middle of a gap, reading as neither.
  moveCaption: { paddingHorizontal: spacing.xs, marginTop: -spacing.xs, marginBottom: spacing.xs },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, paddingHorizontal: spacing.xs },
  // Ghost row, not a filled button: the card's one filled control is Organize.
  addToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: spacing.md },
  addToggleText: { fontSize: 15, fontWeight: '600' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.md },
  // Cancel the shared Input's bottom margin so the fields and the Add button
  // share one baseline.
  addField: { flex: 1, marginBottom: 0 },
  addAmountField: { width: 92, marginBottom: 0 },
  // An interior row: the revealed action carries a small radius on both edges,
  // so it reads as sliding out of this row rather than out of the card.
  extraDelete: { borderRadius: radius.sm },
  sectionRowText: { fontSize: 16, color: colors.text },
  grocChecked: { textDecorationLine: 'line-through', color: colors.textMuted },
  grocNotFound: { textDecorationLine: 'line-through', color: colors.error },
  grocAmount: { fontSize: 13, color: colors.textMuted },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: 6 },
  subNote: { flex: 1, fontSize: 15, color: colors.text },
  subEdit: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  // Cancel the shared Input's bottom margin so the Save button aligns to the
  // field's top and bottom instead of sitting slightly below it.
  subEditField: { flex: 1, marginBottom: -spacing.md },
  grocActions: { padding: spacing.md },
  clearBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  skelWrap: { paddingBottom: spacing.sm },
  emptyWrap: { padding: spacing.md, alignItems: 'center', gap: spacing.md },
  emptyText: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  planBtn: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  planBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
