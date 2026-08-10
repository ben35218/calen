import React, { useLayoutEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Share } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp, StackActions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, recipeScheduleApi } from '../../api';
import { openRecord, sealNew } from '../../lib/e2ee';
import { featuredSchedule } from '../../lib/mealSchedule';
import { RECIPE_SCHEDULE_ENC } from '../../lib/encSubsets';
import { Button, Card, Screen, Divider, Badge, DateField, CenteredLoader, ScreenTitle, HeaderIconButton } from '../../components/ui';
import { formatCalendarDate } from '../../lib/recurrence';
import { ymd } from '../../lib/calendar';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'RecipeDetail'>;
type Rt = RouteProp<KitchenStackParamList, 'RecipeDetail'>;

export default function RecipeDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { id } = useRoute<Rt>().params;
  const qc = useQueryClient();
  // Meals/recipes calendar colour (respects user overrides) — the section accent.
  const accent = useCalendarColors().colors.recipes;
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const recipeQ = useQuery({ queryKey: ['recipes', id], queryFn: async () => openRecord('Recipe', (await recipesApi.get(id)).data) });
  const schedulesQ = useQuery({ queryKey: ['recipe-schedule', 'forRecipe', id], queryFn: async () => (await recipeScheduleApi.forRecipe(id)).data });
  const recipe = recipeQ.data;

  const schedule = useMutation({
    // Sealed create (Signal-parity D5): schedule notes are content.
    mutationFn: async () => {
      const payload = { recipeId: id, scheduledDate: date };
      return recipeScheduleApi.schedule(await sealNew('RecipeSchedule', payload, RECIPE_SCHEDULE_ENC(payload)));
    },
    onSuccess: () => {
      setScheduleOpen(false);
      qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
    },
  });

  // Share the recipe as self-contained text via the OS share sheet (mirrors the
  // trip share entry point) — recipes need no invite code, the content travels.
  // This is the ONLY share path: like the household/calendar/trip invites, the
  // sender composes from their own device, so the recipient's address and the
  // decrypted recipe never touch the server (the server-sent styled email was
  // retired 2026-08-01).
  const shareRecipe = () => {
    if (!recipe) return;
    const mins = (recipe.prepTimeMins || 0) + (recipe.cookTimeMins || 0);
    const meta = [mins ? `${mins} min` : '', recipe.servings ? `${recipe.servings} servings` : '']
      .filter(Boolean)
      .join(' · ');
    const lines = [
      recipe.title,
      ...(meta ? [meta] : []),
      ...(recipe.description ? ['', recipe.description] : []),
      '',
      'Ingredients:',
      ...(recipe.ingredients ?? []).map(
        (ing) => `• ${[ing.amount, ing.unit, ing.name].filter(Boolean).join(' ')}`,
      ),
      '',
      'Instructions:',
      ...(recipe.instructions ?? []).map((step, i) => `${i + 1}. ${step}`),
      '',
      'Shared from Calen — https://householdcalendar.com',
    ];
    Share.share({ message: lines.join('\n') }, { subject: recipe.title });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Recipe',
      // Share sits tight to the title's right; the left spacer mirrors its
      // width so the title stays centered (same trick as the trip header).
      // The header title is static — long recipe names live in the body.
      headerTitle: () => (
        <View style={styles.headerTitleRow}>
          <View style={styles.titleSpacer} />
          <Text style={styles.headerTitleText} numberOfLines={1}>Recipe</Text>
          <View style={styles.titleActions}>
            <TouchableOpacity onPress={shareRecipe} hitSlop={8}>
              <MaterialCommunityIcons name="share" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      ),
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit recipe" onPress={() => navigation.navigate('RecipeForm', { id })} />
      ),
    });
  }, [navigation, id, recipe]);

  if (recipeQ.isLoading || !recipe) {
    return <CenteredLoader color={accent} />;
  }

  const total = (recipe.prepTimeMins || 0) + (recipe.cookTimeMins || 0);
  const feat = featuredSchedule(schedulesQ.data ?? [], ymd(new Date()));
  // A still-to-come meal is somewhere the user can go: tapping the date opens
  // the Meals view on the shopping period containing it, with that day scrolled
  // into view and highlighted. `popTo` unwinds to the Meals view already on the
  // stack (rather than pushing a second one) and falls back to opening it when
  // the recipe was reached from somewhere else. A past date has no planner
  // destination worth landing on, so it stays plain text.
  const openInPlanner = feat?.upcoming
    ? () => navigation.dispatch(
        StackActions.popTo('KitchenHome', { pane: 'planner', weekStart: feat.day, scrollToDate: feat.day }, { merge: true }),
      )
    : null;

  return (
    <View style={{ flex: 1 }}>
      <Screen>
        {recipe.imageUrl ? <Image source={{ uri: recipe.imageUrl }} style={styles.hero} /> : null}

        <ScreenTitle style={styles.recipeTitle}>{recipe.title}</ScreenTitle>

        <View style={styles.metaRow}>
          {total ? <Badge label={`${total} min`} color={accent} /> : null}
          {recipe.servings ? <Badge label={`${recipe.servings} servings`} color={accent} /> : null}
          {recipe.tags?.map((t) => (
            <Badge key={t} label={t} />
          ))}
        </View>

        {recipe.description ? <Text style={styles.desc}>{recipe.description}</Text> : null}

        {/* Schedule card */}
        <Card style={styles.scheduleCard}>
          <View style={styles.scheduleRow}>
            <Ionicons name={feat ? 'calendar' : 'calendar-outline'} size={20} color={accent} />
            <TouchableOpacity
              style={styles.scheduleText}
              activeOpacity={0.7}
              disabled={!openInPlanner}
              accessibilityRole={openInPlanner ? 'button' : undefined}
              accessibilityLabel={openInPlanner ? `Next scheduled ${formatCalendarDate(feat!.day)}, open in meal planner` : undefined}
              onPress={openInPlanner ?? undefined}
            >
              <Text style={styles.scheduleLabel}>{feat ? (feat.upcoming ? 'Next scheduled' : 'Last scheduled') : 'Not yet scheduled'}</Text>
              {feat ? (
                <View style={styles.scheduleDateRow}>
                  <Text style={[styles.scheduleDate, openInPlanner ? { color: accent } : null]}>{formatCalendarDate(feat.day)}</Text>
                  {openInPlanner ? <Ionicons name="chevron-forward" size={14} color={accent} /> : null}
                </View>
              ) : null}
            </TouchableOpacity>
            <Button title="Schedule" color={accent} onPress={() => setScheduleOpen((o) => !o)} />
          </View>
          {scheduleOpen ? (
            <View style={styles.schedulePad}>
              <DateField label="Date" value={date} onChange={setDate} />
              <Button title="Add to Planner" color={accent} loading={schedule.isPending} onPress={() => schedule.mutate()} />
            </View>
          ) : null}
        </Card>

        {/* Ingredients */}
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Ingredients</Text>
          <Divider />
          {recipe.ingredients?.map((ing, i) => (
            <View key={i} style={styles.ingRow}>
              <Text style={styles.ingAmount}>{[ing.amount, ing.unit].filter(Boolean).join(' ')}</Text>
              <Text style={styles.ingName}>{ing.name}</Text>
            </View>
          ))}
        </Card>

        {/* Instructions */}
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Instructions</Text>
          <Divider />
          {recipe.instructions?.map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={[styles.stepBadge, { backgroundColor: accent }]}>
                <Text style={styles.stepNum}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </Card>
      </Screen>

      <View style={styles.actionBar}>
        <Button
          title="Start Cooking"
          color={accent}
          onPress={() => navigation.navigate('CookingMode', { id })}
          disabled={!recipe.instructions?.length}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  headerTitleText: { color: '#fff', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  // Left spacer mirrors the share icon's width so the title stays centered.
  titleSpacer: { width: 30 },
  titleActions: { flexDirection: 'row', alignItems: 'center', width: 30 },
  hero: { width: '100%', height: 200, borderRadius: 12, marginBottom: spacing.md },
  recipeTitle: { marginBottom: spacing.sm },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.md },
  desc: { fontSize: 15, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 21 },
  scheduleCard: { marginBottom: spacing.md },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  scheduleText: { flex: 1 },
  scheduleLabel: { fontSize: 12, color: colors.textMuted },
  scheduleDateRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  scheduleDate: { fontSize: 15, fontWeight: '600', color: colors.text },
  schedulePad: { marginTop: spacing.md, gap: spacing.sm },
  sectionCard: { padding: 0, paddingTop: spacing.md, marginBottom: spacing.md },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.text, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  ingRow: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingVertical: 8 },
  ingAmount: { width: 80, fontSize: 14, fontWeight: '600', color: colors.textMuted },
  ingName: { flex: 1, fontSize: 15, color: colors.text },
  stepRow: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.md },
  stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  stepNum: { color: '#fff', fontWeight: '700', fontSize: 13 },
  stepText: { flex: 1, fontSize: 15, color: colors.text, lineHeight: 22 },
  actionBar: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
