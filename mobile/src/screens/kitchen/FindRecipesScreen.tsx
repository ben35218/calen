import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi } from '../../api';
import { Button, Card, Chip, Input, Skeleton } from '../../components/ui';
import CreditsBanner from '../../components/CreditsBanner';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { ingredientName } from '../../lib/recipeNames';
import { colors, spacing } from '../../theme';
import type { KitchenStackParamList } from '../../navigation/KitchenNavigator';

type Suggestion = {
  title: string;
  description?: string;
  time?: string;
  usedIngredients?: string[];
  needsOther?: string[];
};
// "What are you in the mood for?" free text in, AI recipe suggestions out.
export default function FindRecipesScreen() {
  const nav = useNavigation<NativeStackNavigationProp<KitchenStackParamList>>();
  // Carried from the planner's "Add recipe" for a date, so a saved recipe lands
  // on that date and returns to Meals.
  const scheduleDate = useRoute<RouteProp<KitchenStackParamList, 'RecipeAssistant'>>().params?.scheduleDate;
  const accent = useCalendarColors().colors.recipes;

  const [queryText, setQueryText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [generatingIdx, setGeneratingIdx] = useState<number | null>(null);

  async function suggest() {
    setError('');
    setBusy(true);
    try {
      const { data } = await recipesApi.suggestRecipes({ query: queryText.trim() });
      setSuggestions(data.recipes);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to suggest recipes');
    } finally {
      setBusy(false);
    }
  }

  // Expand a lightweight suggestion into a full recipe (one AI generation) and open
  // it in the review screen. Nothing is saved until the user taps save there — and
  // that save reuses this generated recipe, so it costs no extra tokens.
  async function preview(s: Suggestion, i: number) {
    setError('');
    setGeneratingIdx(i);
    try {
      const description = [
        `Recipe: ${s.title}.`,
        s.description,
        s.usedIngredients?.length ? `Main ingredients: ${s.usedIngredients.join(', ')}.` : '',
        s.needsOther?.length ? `Also needs: ${s.needsOther.join(', ')}.` : '',
        s.time ? `Estimated time: ${s.time}.` : '',
      ].filter(Boolean).join(' ');
      const { data } = await recipesApi.generateFromAi(description);
      nav.navigate('RecipeForm', { initial: data, scheduleDate });
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to build that recipe. Please try again.');
    } finally {
      setGeneratingIdx(null);
    }
  }

  // ── Results: generate ──
  if (suggestions) {
    return (
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
        <ResultsHeader title="Recipe Suggestions" onBack={() => setSuggestions(null)} />
        <Text style={styles.previewHint}>Tap a suggestion to see the full recipe, then save it.</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {suggestions.map((r, i) => (
          <TouchableOpacity
            key={i}
            activeOpacity={0.7}
            disabled={generatingIdx !== null}
            onPress={() => preview(r, i)}
          >
            <Card style={styles.card}>
              <Text style={styles.recipeTitle}>{r.title}</Text>
              {r.description ? <Text style={styles.recipeDesc}>{r.description}</Text> : null}
              {r.time ? <Text style={styles.time}>⏱ {r.time}</Text> : null}
              {/* Suggestion stubs come back however the model wrote them; the
                  chips are ingredient names, so they're cased like every other
                  ingredient name in the app (lib/recipeNames). */}
              <View style={styles.tags}>
                {(r.usedIngredients ?? []).map((ing) => <Chip key={ing} label={ingredientName(ing)} color={colors.success} />)}
                {(r.needsOther ?? []).map((ing) => <Chip key={ing} label={ingredientName(ing)} color={colors.textMuted} />)}
              </View>
              <View style={styles.cardFooter}>
                {generatingIdx === i ? (
                  <>
                    <ActivityIndicator size="small" color={accent} />
                    <Text style={[styles.footerLabel, { color: accent }]}>Building recipe…</Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.footerLabel, { color: accent }]}>Preview</Text>
                    <Ionicons name="chevron-forward" size={16} color={accent} />
                  </>
                )}
              </View>
            </Card>
          </TouchableOpacity>
        ))}
      </KeyboardAwareScrollView>
    );
  }

  // ── Selector ──
  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
      <CreditsBanner />
      <Card style={styles.card}>
        <Text style={styles.title}>What are you in the mood for?</Text>
        <Input
          placeholder="e.g. quick vegetarian pasta dinner"
          value={queryText}
          onChangeText={setQueryText}
          multiline
        />
      </Card>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Button
        title="Generate"
        onPress={suggest}
        loading={busy}
        color={accent}
        disabled={!queryText.trim()}
      />

      {/* The suggest call runs for several seconds; shimmer the cards the
          results will land in so the wait reads as loading, not stalling. */}
      {busy ? <SuggestionsSkeleton /> : null}
    </KeyboardAwareScrollView>
  );
}

// Placeholder suggestion cards in the shape the results render: title line,
// two description lines, then a row of ingredient-chip blocks (same pulse the
// recipe form's ImportSkeleton uses).
function SuggestionsSkeleton() {
  return (
    <View style={styles.skelWrap}>
      {[0, 1, 2].map((i) => (
        <Card key={i} style={styles.card}>
          <Skeleton width={i === 1 ? '48%' : '62%'} height={16} />
          <Skeleton width={'92%'} height={13} style={styles.skelGap} />
          <Skeleton width={'70%'} height={13} style={styles.skelGapSm} />
          <View style={styles.tags}>
            {[52, 68, 44].map((w, j) => (
              <Skeleton key={j} width={w} height={24} radius={12} />
            ))}
          </View>
        </Card>
      ))}
    </View>
  );
}

function ResultsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.resultsHeader}>
      <TouchableOpacity onPress={onBack}><Ionicons name="arrow-back" size={22} color={colors.text} /></TouchableOpacity>
      <Text style={styles.resultsTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  card: { marginBottom: spacing.md },
  title: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6 },
  errorText: { color: colors.error, marginBottom: spacing.sm },
  resultsHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  resultsTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  recipeTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  recipeDesc: { fontSize: 13, color: colors.textMuted, marginBottom: 6, lineHeight: 18 },
  time: { fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  previewHint: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.md },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  footerLabel: { fontSize: 14, fontWeight: '600' },
  skelWrap: { marginTop: spacing.md },
  skelGap: { marginTop: spacing.sm },
  skelGapSm: { marginTop: 6 },
});
