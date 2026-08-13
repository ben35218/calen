import React, { useLayoutEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, FlatList, TouchableOpacity, Dimensions } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, recipeScheduleApi, Recipe } from '../../api';
import { sealNew } from '../../lib/e2ee';
import { openRecipe } from '../../lib/recipeNames';
import { pickVariation } from '../../lib/recipeVariations';
import { RECIPE_SCHEDULE_ENC } from '../../lib/encSubsets';
import * as replica from '../../lib/replica';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { SkeletonList } from '../../components/ui';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'AddMeal'>;
type Rt = RouteProp<KitchenStackParamList, 'AddMeal'>;

// A stable, top-level component so React Navigation reuses (not remounts) the
// TextInput on option updates — keeping keyboard focus while typing. Uncontrolled
// (onChangeText only) so the parent's search state never re-feeds it a value.
function HeaderSearch({ onChangeText }: { onChangeText: (t: string) => void }) {
  return (
    <View style={styles.headerSearch}>
      <Ionicons name="search" size={16} color={colors.textMuted} />
      <TextInput
        placeholder="Search recipes…"
        placeholderTextColor={colors.textMuted}
        onChangeText={onChangeText}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.headerSearchInput}
      />
    </View>
  );
}

export default function AddMealScreen() {
  const navigation = useNavigation<Nav>();
  const { date } = useRoute<Rt>().params;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  const [search, setSearch] = useState('');

  // The search field replaces the header title. Set once (stable deps) so the
  // input keeps focus as the user types.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: 'left',
      headerTitle: () => <HeaderSearch onChangeText={setSearch} />,
    });
  }, [navigation]);

  const recipesQ = useQuery({
    queryKey: ['recipes'],
    // Offline-first, mirroring RecipesScreen: sync the replica, then decrypt.
    queryFn: async () => {
      const rows = await replica.syncedList<Recipe>('Recipe', async () => (await recipesApi.list()).data);
      return Promise.all(rows.map((r) => openRecipe(r)));
    },
  });

  const schedule = useMutation({
    // Sealed create (Signal-parity D5): schedule notes are content, so every
    // entry carries an enc blob for the write-guard.
    mutationFn: async ({ recipeId, variation }: { recipeId: string; variation: string | null }) => {
      const payload = { recipeId, scheduledDate: date, ...(variation ? { variation } : {}) };
      return recipeScheduleApi.schedule(await sealNew('RecipeSchedule', payload, RECIPE_SCHEDULE_ENC(payload)));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
      qc.invalidateQueries({ queryKey: ['grocery-list'] });
      navigation.goBack();
    },
  });

  const q = search.trim().toLowerCase();
  const recipes = (recipesQ.data ?? []).filter(
    (r) => !q || r.title.toLowerCase().includes(q) || r.tags?.some((t) => t.toLowerCase().includes(q)),
  );

  if (recipesQ.isLoading) {
    return (
      <View style={styles.pane}>
        <SkeletonList />
      </View>
    );
  }

  return (
    <View style={styles.pane}>
      <FlatList
        data={recipes}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <TouchableOpacity style={styles.createRow} onPress={() => navigation.navigate('RecipeForm', { scheduleDate: date })}>
            <View style={[styles.createIcon, { backgroundColor: accent }]}>
              <Ionicons name="add" size={20} color="#fff" />
            </View>
            <Text style={[styles.createText, { color: accent }]}>Create new recipe</Text>
          </TouchableOpacity>
        }
        ListEmptyComponent={<Text style={styles.empty}>No recipes found.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            disabled={schedule.isPending}
            onPress={async () => {
              // A recipe with flavor variations schedules as ONE of them (the
              // grocery list buys only that kit); cancelling aborts the add.
              const variation = await pickVariation(item);
              if (variation === undefined) return;
              schedule.mutate({ recipeId: item._id, variation });
            }}
          >
            <MaterialCommunityIcons name="silverware-fork-knife" size={20} color={colors.textMuted} />
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            {schedule.isPending && schedule.variables?.recipeId === item._id ? (
              <ActivityIndicator size="small" color={accent} />
            ) : (
              <Ionicons name="add" size={22} color={accent} />
            )}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Fill the header width left of the right edge, leaving room for the back button.
  headerSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    width: Dimensions.get('window').width - 96,
    height: 36,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerSearchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
  pane: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.sm },
  createIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  createText: { fontSize: 16, fontWeight: '600' },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
});
