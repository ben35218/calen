import React, { useLayoutEffect, useState } from 'react';
import { View, StyleSheet, Image, TouchableOpacity, Share } from 'react-native';
import { Text } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp, StackActions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, recipeScheduleApi } from '../../api';
import { sealNew } from '../../lib/e2ee';
import { openRecipe } from '../../lib/recipeNames';
import { recipeImageUri } from '../../lib/recipePhoto';
import { featuredSchedule } from '../../lib/mealSchedule';
import { ingredientRuns, pickVariation } from '../../lib/recipeVariations';
import { RECIPE_SCHEDULE_ENC } from '../../lib/encSubsets';
import { Button, Card, Chip, Screen, Divider, Badge, DateField, CenteredLoader, ScreenTitle, HeaderIconButton, Skeleton } from '../../components/ui';
import { formatCalendarDate } from '../../lib/recurrence';
import { ymd } from '../../lib/calendar';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, radius, spacing } from '../../theme';

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
  // Flavor variation the meal is planned as; null until the user picks (the
  // first variation is the effective default when the recipe has any).
  const [variation, setVariation] = useState<string | null>(null);
  // The dish photo streams from the API; shimmer its frame until it paints so
  // the hero doesn't pop in over blank space.
  const [heroLoaded, setHeroLoaded] = useState(false);

  const recipeQ = useQuery({ queryKey: ['recipes', id], queryFn: async () => openRecipe((await recipesApi.get(id)).data) });
  const schedulesQ = useQuery({ queryKey: ['recipe-schedule', 'forRecipe', id], queryFn: async () => (await recipeScheduleApi.forRecipe(id)).data });
  const recipe = recipeQ.data;

  const schedule = useMutation({
    // Sealed create (Signal-parity D5): schedule notes are content.
    mutationFn: async () => {
      const chosen = variation ?? recipe?.variations?.[0] ?? null;
      const payload = { recipeId: id, scheduledDate: date, ...(chosen ? { variation: chosen } : {}) };
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
      ...ingredientRuns(recipe.ingredients ?? [], recipe.variations).flatMap((run) => [
        ...(run.group ? [`${run.group}${run.isVariation ? ' (variation — pick one)' : ''}:`] : []),
        ...run.items.map(({ ing }) => `• ${[ing.amount, ing.unit, ing.name].filter(Boolean).join(' ')}`),
      ]),
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
  // Stored as a server path; the API host is joined at display time (lib/recipePhoto).
  const heroUri = recipeImageUri(recipe.imageUrl);
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
        {heroUri ? (
          <View style={styles.hero}>
            {!heroLoaded ? <Skeleton height={200} radius={radius.md} style={styles.heroSkeleton} /> : null}
            <Image source={{ uri: heroUri }} style={styles.heroImg} onLoad={() => setHeroLoaded(true)} />
          </View>
        ) : null}

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
              {recipe.variations?.length ? (
                <View>
                  <Text style={styles.variationLabel}>Variation — the grocery list buys only this one</Text>
                  <View style={styles.variationChips}>
                    {recipe.variations.map((v) => (
                      <Chip key={v} label={v} color={accent} selected={(variation ?? recipe.variations![0]) === v} onPress={() => setVariation(v)} />
                    ))}
                  </View>
                </View>
              ) : null}
              <Button title="Add to Planner" color={accent} loading={schedule.isPending} onPress={() => schedule.mutate()} />
            </View>
          ) : null}
        </Card>

        {/* Ingredients — grouped into their sections; variation groups are the
            mutually exclusive flavor kits picked when scheduling. */}
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Ingredients</Text>
          <Divider />
          {ingredientRuns(recipe.ingredients ?? [], recipe.variations).map((run, r) => (
            <View key={r}>
              {run.group ? (
                <View style={styles.groupHeaderRow}>
                  <Text style={styles.groupHeader}>{run.group}</Text>
                  {run.isVariation ? <Badge label="Variation" color={accent} /> : null}
                </View>
              ) : null}
              {run.items.map(({ ing, index }) => (
                <View key={index} style={styles.ingRow}>
                  <Text style={styles.ingAmount}>{[ing.amount, ing.unit].filter(Boolean).join(' ')}</Text>
                  <Text style={styles.ingName}>{ing.name}</Text>
                </View>
              ))}
            </View>
          ))}
        </Card>

        {/* Instructions */}
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Instructions</Text>
          <Divider />
          {recipe.instructions?.map((step, i) => {
            // A step tagged to specific variations says so — cooking mode
            // will drop it for the kits it doesn't belong to.
            const only = recipe.instructionVariations?.[i];
            return (
              <View key={i} style={styles.stepRow}>
                <View style={[styles.stepBadge, { backgroundColor: accent }]}>
                  <Text style={styles.stepNum}>{i + 1}</Text>
                </View>
                <View style={styles.stepBody}>
                  <Text style={styles.stepText}>{step}</Text>
                  {only?.length ? (
                    <Text style={[styles.stepOnly, { color: accent }]}>{only.join(' / ')} only</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>
      </Screen>

      <View style={styles.actionBar}>
        <Button
          title="Start Cooking"
          color={accent}
          onPress={async () => {
            // A recipe with flavor variations cooks as ONE of them: cooking
            // mode shows only that kit's steps and ingredients. Cancel = don't
            // start (same contract as adding a meal from the planner).
            const cookAs = await pickVariation(
              recipe,
              `Which variation are you making? You'll only see that variation's steps and ingredients.`,
            );
            if (cookAs === undefined) return;
            navigation.navigate('CookingMode', { id, ...(cookAs ? { variation: cookAs } : {}) });
          }}
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
  hero: { width: '100%', height: 200, marginBottom: spacing.md },
  heroImg: { width: '100%', height: '100%', borderRadius: radius.md },
  // Sits behind the image and stretches with it; the image fades it out by
  // covering it once decoded.
  heroSkeleton: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
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
  groupHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: 2 },
  groupHeader: { fontSize: 14, fontWeight: '700', color: colors.text },
  variationLabel: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.xs },
  variationChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  ingRow: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingVertical: 8 },
  ingAmount: { width: 80, fontSize: 14, fontWeight: '600', color: colors.textMuted },
  ingName: { flex: 1, fontSize: 15, color: colors.text },
  stepRow: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.md },
  stepBody: { flex: 1 },
  stepOnly: { fontSize: 12, fontWeight: '700', marginTop: 2 },
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
