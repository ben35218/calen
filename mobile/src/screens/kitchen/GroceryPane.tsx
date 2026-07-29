import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  recipeScheduleApi, settingsApi,
  GroceryItem, OrganizedGroceryList, GrocerySessionState,
} from '../../api';
import { loadGroceryList } from '../../lib/groceryList';
import { Card, Divider, Input } from '../../components/ui';
import CreditsBanner from '../../components/CreditsBanner';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing } from '../../theme';
import { iso } from './constants';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'KitchenHome'>;

// The week's shopping list, keyed to the same week the Planner shows
// (weekStart comes from KitchenScreen so flipping panes keeps the week).
export default function GroceryPane({ weekStart, onShowPlanner }: { weekStart: Date; onShowPlanner: () => void }) {
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  const start = iso(weekStart);

  // Grocery session state (persisted server-side per week).
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [substitutions, setSubstitutions] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState<Record<string, boolean>>({});
  const [haveHome, setHaveHome] = useState<Record<string, boolean>>({});
  const [organized, setOrganized] = useState<OrganizedGroceryList | null>(null);
  const [subEditing, setSubEditing] = useState<string | null>(null);
  const [subDraft, setSubDraft] = useState('');
  const hydrating = useRef(false);

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

  // Hydrate session when the week (or its saved session) loads.
  useEffect(() => {
    hydrating.current = true;
    const s = sessionQ.data;
    setChecked(s?.checked ?? {});
    setSubstitutions(s?.substitutions ?? {});
    setNotFound(s?.notFound ?? {});
    setHaveHome(s?.haveHome ?? {});
    setOrganized(s?.organizedList ?? null);
    setTimeout(() => { hydrating.current = false; }, 0);
  }, [sessionQ.data, start]);

  // Persist session on change (skip during hydration). Also write the state into
  // the query cache so a quick unmount/remount (e.g. switching Kitchen panes)
  // rehydrates the latest edits instead of the pre-edit cached value — the
  // 30s global staleTime would otherwise serve stale data without refetching.
  useEffect(() => {
    if (hydrating.current) return;
    const state: GrocerySessionState = { checked, substitutions, notFound, haveHome, organizedList: organized };
    qc.setQueryData(['grocery-session', start], state);
    recipeScheduleApi.sessionPut(start, state).catch(() => {});
  }, [checked, substitutions, notFound, haveHome, organized, start, qc]);

  const organize = useMutation({
    mutationFn: () => recipeScheduleApi.organizeGroceryList(groceryQ.data ?? [], settingsQ.data?.grocerySections),
    onSuccess: (res) => setOrganized(res.data),
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

  const renderItem = (g: GroceryItem) => {
    // "Have at home" is the manual home-icon toggle on each row.
    const have = !!haveHome[g.name];
    const on = checked[g.name];
    const nf = notFound[g.name];
    const struck = have || on || nf;
    // When an item is substituted, its checkbox moves next to the substitution
    // note below (rendered in the substitution's accent color).
    const subbed = !!substitutions[g.name] && subEditing !== g.name;
    return (
      <View key={g.name}>
        <View style={styles.grocRow}>
          {have ? (
            <MaterialCommunityIcons name="home-import-outline" size={20} color={accent} />
          ) : subbed ? (
            <MaterialCommunityIcons name="subdirectory-arrow-right" size={20} color={accent} />
          ) : (
            <TouchableOpacity onPress={() => setChecked((c) => ({ ...c, [g.name]: !c[g.name] }))}>
              {nf ? (
                <MaterialCommunityIcons name="close-box" size={20} color={colors.error} />
              ) : (
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.success : colors.textMuted} />
              )}
            </TouchableOpacity>
          )}
          <Text style={[styles.grocName, subbed ? { color: accent } : (struck && (nf ? styles.grocNotFound : styles.grocChecked))]}>{g.name}</Text>
          {g.amount ? <Text style={styles.grocAmount}>{g.amount}</Text> : null}
          <TouchableOpacity onPress={() => setHaveHome((h) => ({ ...h, [g.name]: !h[g.name] }))}>
            <MaterialCommunityIcons name={have ? 'home' : 'home-outline'} size={18} color={have ? accent : colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => toggleSub(g.name)}>
            <MaterialCommunityIcons name="swap-horizontal" size={18} color={substitutions[g.name] ? accent : colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setNotFound((n) => ({ ...n, [g.name]: !n[g.name] }))}>
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
  };

  const list = groceryQ.data ?? [];
  // "Done" while shopping = checked off, marked not-found, or already at home.
  const doneCount = list.filter((g) => !!haveHome[g.name] || !!checked[g.name] || !!notFound[g.name]).length;

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.pane} contentContainerStyle={styles.content}>
      <Card style={styles.grocCard}>
        <View style={styles.grocHeader}>
          <View style={styles.grocTitleWrap}>
            <Text style={styles.grocTitle}>Grocery List</Text>
            {list.length > 0 && !groceryQ.isLoading ? (
              <Text style={styles.grocProgress}>{doneCount} of {list.length}</Text>
            ) : null}
          </View>
          <View style={styles.grocHeaderActions}>
            {list.length > 0 && !groceryQ.isLoading ? (
              organized ? (
                <TouchableOpacity style={[styles.organizeBtn, { backgroundColor: accent }]} onPress={() => setOrganized(null)}>
                  <Text style={styles.organizeBtnText}>Plain list</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.organizeBtn, { backgroundColor: accent }, organize.isPending && { opacity: 0.6 }]}
                  disabled={organize.isPending}
                  onPress={() => organize.mutate()}
                >
                  {organize.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.organizeBtnText}>Organize</Text>
                  )}
                </TouchableOpacity>
              )
            ) : null}
            <TouchableOpacity onPress={() => navigation.navigate('MealPlannerSettings')} style={styles.grocHeaderBtn}>
              <MaterialCommunityIcons name="sort" size={20} color={accent} />
            </TouchableOpacity>
          </View>
        </View>
        <Divider />
        {/* Organize is an AI call; this card warns as the credit balance runs
            low and, at zero, explains why Organize is refused (taps to Buy credits). */}
        <CreditsBanner />
        {groceryQ.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ margin: spacing.md }} />
        ) : list.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>Schedule recipes on the Planner to build your grocery list.</Text>
            <TouchableOpacity style={[styles.planBtn, { backgroundColor: accent }]} onPress={onShowPlanner}>
              <Text style={styles.planBtnText}>Plan meals</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {organized ? (
              organized.categories.map((cat) => (
                <View key={cat.name}>
                  <Text style={[styles.catLabel, { color: accent }]}>{cat.name}</Text>
                  {cat.items.map(renderItem)}
                </View>
              ))
            ) : (
              list.map(renderItem)
            )}

            <View style={styles.grocActions}>
              <TouchableOpacity style={[styles.clearBtn, { backgroundColor: accent }]} onPress={() => { setChecked({}); setNotFound({}); setSubstitutions({}); setHaveHome({}); }}>
                <Text style={styles.clearBtnText}>Clear</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </Card>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  grocCard: { padding: 0, paddingTop: spacing.md },
  grocHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  grocTitleWrap: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  grocTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  grocProgress: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  grocHeaderBtn: { padding: 4 },
  grocHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  organizeBtn: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  organizeBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  saveBtn: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  catLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: 2 },
  grocRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, paddingHorizontal: spacing.md },
  grocName: { flex: 1, fontSize: 15, color: colors.text },
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
  emptyWrap: { padding: spacing.md, alignItems: 'center', gap: spacing.md },
  emptyText: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  planBtn: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  planBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
