import React, { useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Image,
  Alert,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, Recipe } from '../../api';
import { deleteRecipeWithSchedules } from '../../lib/recipeDelete';
import { openRecipe } from '../../lib/recipeNames';
import { recipeImageUri } from '../../lib/recipePhoto';
import * as replica from '../../lib/replica';
import { Card, Input, Badge, Chip, RoundIconButton, SectionHeader, SkeletonList, EmptyState, SwipeableRow } from '../../components/ui';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, radius, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'Recipes'>;

// Recipes with no tags collect under this pseudo-category.
const UNTAGGED = 'Untagged';

function totalMins(r: Recipe) {
  return (r.prepTimeMins || 0) + (r.cookTimeMins || 0);
}

// The recipe library, a standalone screen reached from the Meals view's
// Recipes button (it used to be a segmented pane inside KitchenScreen).
export default function RecipesScreen() {
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.recipes;
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const confirmDelete = (recipe: Recipe) =>
    Alert.alert('Delete recipe?', `"${recipe.title}" and any meals planned with it will be permanently removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate(recipe._id) },
    ]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <RoundIconButton icon="add" onPress={() => navigation.navigate('RecipeForm', {})} bg={accent} />,
    });
  }, [navigation, accent]);

  const recipesQ = useQuery({
    queryKey: ['recipes'],
    // Offline-first (Phase 4b): sync the replica, fall back to cache offline,
    // then decrypt content over the plaintext rows.
    queryFn: async () => {
      const rows = await replica.syncedList<Recipe>('Recipe', async () => (await recipesApi.list()).data);
      return Promise.all(rows.map((r) => openRecipe(r)));
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteRecipeWithSchedules(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
      qc.invalidateQueries({ queryKey: ['grocery-list'] });
    },
  });

  const recipes = recipesQ.data ?? [];

  // Chip list is derived from the full recipe set (not the search results) so the
  // available categories stay stable while searching. Alphabetical, Untagged last.
  const tags = useMemo(() => {
    const set = new Set<string>();
    let hasUntagged = false;
    for (const r of recipes) {
      if (r.tags?.length) r.tags.forEach((t) => set.add(t));
      else hasUntagged = true;
    }
    const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));
    if (hasUntagged) sorted.push(UNTAGGED);
    return sorted;
  }, [recipes]);

  // The "All" view lists each recipe exactly once, alphabetically — grouping it
  // by tag repeats a multi-tagged recipe under every tag it carries, which reads
  // as duplicates rather than categories. A selected chip narrows to that tag's
  // recipes under a single header.
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bySearch = recipes.filter((r) => {
      if (!q) return true;
      return r.title.toLowerCase().includes(q) || r.tags?.some((t) => t.toLowerCase().includes(q));
    });

    if (!selectedTag) {
      const flat = [...bySearch].sort((a, b) => a.title.localeCompare(b.title));
      return flat.length ? [{ title: '', data: flat }] : [];
    }

    const inTag = bySearch.filter((r) =>
      selectedTag === UNTAGGED ? !r.tags?.length : r.tags?.includes(selectedTag),
    );
    return inTag.length ? [{ title: selectedTag, data: inTag }] : [];
  }, [recipes, search, selectedTag]);

  if (recipesQ.isLoading) {
    return <SkeletonList />;
  }

  return (
    <View style={styles.pane}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled
        ListHeaderComponent={
          <View>
            <Input placeholder="Search recipes…" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} />
            {tags.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Chip label="All" selected={!selectedTag} color={accent} onPress={() => setSelectedTag(null)} />
                {tags.map((t) => (
                  <Chip key={t} label={t} selected={selectedTag === t} color={accent} onPress={() => setSelectedTag((cur) => (cur === t ? null : t))} />
                ))}
              </ScrollView>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) =>
          section.title ? <SectionHeader style={styles.stickyHeader}>{section.title}</SectionHeader> : null
        }
        refreshControl={<RefreshControl refreshing={recipesQ.isRefetching} onRefresh={recipesQ.refetch} />}
        ListEmptyComponent={
          <EmptyState
            variant="inline"
            mdiIcon="silverware-fork-knife"
            title={search.trim() ? 'No matches' : 'No recipes yet'}
            message={search.trim() ? 'Try a different search.' : 'Tap + to add your first recipe.'}
            accent={accent}
          />
        }
        renderItem={({ item }) => (
          <SwipeableRow
            onDelete={() => confirmDelete(item)}
            accessibilityLabel={`Delete ${item.title}`}
            // Shaped to the card it slides out from: same corner radius, and
            // stopping short of the card's row gap.
            actionStyle={styles.rowSwipeAction}
          >
            <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('RecipeDetail', { id: item._id })}>
              <Card style={styles.row}>
                {recipeImageUri(item.imageUrl) ? (
                  <Image source={{ uri: recipeImageUri(item.imageUrl)! }} style={styles.thumb} />
                ) : (
                  <View style={[styles.thumb, styles.thumbPlaceholder]}>
                    <MaterialCommunityIcons name="silverware-fork-knife" size={24} color={colors.textMuted} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                  <View style={styles.metaRow}>
                    {totalMins(item) ? <Text style={styles.meta}>{totalMins(item)} min</Text> : null}
                    {item.servings ? <Text style={styles.meta}>· {item.servings} servings</Text> : null}
                    {item.source && item.source !== 'manual' ? <Badge label={item.source.toUpperCase()} color={colors.primary} /> : null}
                  </View>
                </View>
              </Card>
            </TouchableOpacity>
          </SwipeableRow>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: 96 },
  chips: { gap: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  // Sticky section header keeps a solid background so rows scroll under it; the
  // typography comes from the shared SectionHeader.
  stickyHeader: { backgroundColor: colors.background, paddingVertical: 6, marginBottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.md },
  thumb: { width: 56, height: 56, borderRadius: 8 },
  thumbPlaceholder: { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  meta: { fontSize: 13, color: colors.textMuted },
  // The revealed Delete matches the card's outer corners and stops at the row
  // gap the card's own marginBottom leaves; its inner edge stays square so it
  // reads as continuous with the card it slid out of.
  rowSwipeAction: { bottom: spacing.sm, borderTopRightRadius: radius.lg, borderBottomRightRadius: radius.lg },
});
