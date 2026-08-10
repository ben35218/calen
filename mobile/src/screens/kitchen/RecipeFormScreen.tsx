import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp, StackActions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, recipeScheduleApi, Recipe, Ingredient } from '../../api';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { RECIPE_SCHEDULE_ENC } from '../../lib/encSubsets';

// Encrypted recipe content (imageUrl/sourceUrl/instructionIngredients stay plaintext).
const RECIPE_ENC = (p: Record<string, unknown>) => ({
  title: p.title, description: p.description, ingredients: p.ingredients,
  instructions: p.instructions, tags: p.tags,
  servings: p.servings, prepTimeMins: p.prepTimeMins, cookTimeMins: p.cookTimeMins,
});
import { Button, Input, Screen, SectionTitle, useHeaderCheckButton, FormError, CenteredLoader } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import StepIngredientLinker from '../../components/StepIngredientLinker';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import CalenChatIcon from '../../components/CalenChatIcon';
import CreditsBanner from '../../components/CreditsBanner';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { takePhoto, pickImage } from '../../lib/media';
import { uploadFile } from '../../lib/upload';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<KitchenStackParamList, 'RecipeForm'>;
type Rt = RouteProp<KitchenStackParamList, 'RecipeForm'>;

interface FormState {
  title: string;
  description: string;
  sourceUrl: string;
  imageUrl: string;
  servings: string;
  prepTimeMins: string;
  cookTimeMins: string;
  tags: string[];
  ingredients: Ingredient[];
  instructions: string[];
  // Per-step timer in minutes (parallel to instructions); '' = no timer.
  timers: string[];
  // Per-ingredient stable client IDs (aligned to ingredients[]) + per-step links.
  lids: string[];
  linkedIds: string[][];
}

const EMPTY: FormState = {
  title: '',
  description: '',
  sourceUrl: '',
  imageUrl: '',
  servings: '',
  prepTimeMins: '',
  cookTimeMins: '',
  tags: [],
  ingredients: [],
  instructions: [],
  timers: [],
  lids: [],
  linkedIds: [],
};

export default function RecipeFormScreen() {
  const navigation = useNavigation<Nav>();
  const aiEnabled = useAiEnabled();
  const { id, initial, scheduleDate } = useRoute<Rt>().params || {};
  const isEdit = !!id;
  const qc = useQueryClient();
  // Meals/recipes calendar colour (respects user overrides) — the section accent.
  const accent = useCalendarColors().colors.recipes;

  const lidCounter = useRef(0);
  const makeLid = () => `_l${++lidCounter.current}`;

  // New recipes start with a single blank ingredient row; edits and pre-filled
  // reviews (an AI-generated suggestion) populate from data instead.
  const [form, setForm] = useState<FormState>(() =>
    isEdit || initial ? EMPTY : { ...EMPTY, ingredients: [{ amount: '', unit: '', name: '' }], lids: [makeLid()] }
  );
  const [urlInput, setUrlInput] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [aiInput, setAiInput] = useState('');
  const [importer, setImporter] = useState<'url' | null>(null);
  const [error, setError] = useState('');
  // A blank new recipe is ready immediately; an edit or an AI-review prefill
  // waits for its data to populate below before the discard guard snapshots the
  // clean baseline.
  const [seeded, setSeeded] = useState(!isEdit && !initial);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (!form.tags.includes(t)) set({ tags: [...form.tags, t] });
    setTagInput('');
  };
  const removeTag = (i: number) => set({ tags: form.tags.filter((_, j) => j !== i) });

  // _lid -> [1-based step numbers it appears in] (recipe-wide).
  const assignmentsById = useMemo(() => {
    const map: Record<string, number[]> = {};
    form.lids.forEach((lid) => { map[lid] = []; });
    form.linkedIds.forEach((lids, stepIdx) => {
      lids.forEach((lid) => { if (map[lid]) map[lid].push(stepIdx + 1); });
    });
    return map;
  }, [form.lids, form.linkedIds]);

  const lidIngredients = form.ingredients.map((ing, i) => ({ ...ing, _lid: form.lids[i] }));

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Recipe' : 'Add Recipe' });
  }, [navigation, isEdit]);

  const recipeQ = useQuery({
    queryKey: ['recipes', id],
    queryFn: async () => (await recipesApi.get(id!)).data,
    enabled: isEdit,
  });

  const populate = (data: Partial<Recipe>) =>
    setForm((f) => {
      const ingredients = data.ingredients ?? f.ingredients;
      const instructions = data.instructions ?? f.instructions;
      // Regenerate stable lids whenever the ingredient list is replaced.
      const lids = data.ingredients ? data.ingredients.map(() => makeLid()) : f.lids;
      // Build per-step linkedIds from incoming instructionIngredients (indices).
      let linkedIds = f.linkedIds;
      let timers = f.timers;
      if (data.instructions) {
        const incoming = data.instructionIngredients;
        linkedIds = incoming
          ? instructions.map((_, si) => (incoming[si] || []).map((idx) => lids[idx]).filter(Boolean))
          : instructions.map(() => []);
        const incomingTimers = data.instructionTimers;
        timers = instructions.map((_, si) => {
          const t = incomingTimers?.[si];
          return t != null && t > 0 ? String(t) : '';
        });
      }
      return {
        ...f,
        title: data.title ?? f.title,
        description: data.description ?? f.description,
        imageUrl: data.imageUrl ?? f.imageUrl,
        sourceUrl: data.sourceUrl ?? f.sourceUrl,
        servings: data.servings != null ? String(data.servings) : f.servings,
        prepTimeMins: data.prepTimeMins != null ? String(data.prepTimeMins) : f.prepTimeMins,
        cookTimeMins: data.cookTimeMins != null ? String(data.cookTimeMins) : f.cookTimeMins,
        tags: data.tags ? data.tags : f.tags,
        ingredients,
        instructions,
        timers,
        lids,
        linkedIds,
      };
    });

  useEffect(() => {
    if (!recipeQ.data) return;
    let cancelled = false;
    openRecord('Recipe', recipeQ.data).then((r) => { if (!cancelled) { populate(r); setSeeded(true); } }); // decrypt over plaintext
    return () => { cancelled = true; };
  }, [recipeQ.data]);

  // Pre-fill a brand-new recipe from an AI-generated suggestion (already plaintext,
  // not yet saved). Runs once; the user reviews/edits and saves via the header check.
  const initialLoaded = useRef(false);
  useEffect(() => {
    if (isEdit || !initial || initialLoaded.current) return;
    initialLoaded.current = true;
    populate(initial);
    setSeeded(true);
  }, [isEdit, initial]);

  const fromUrl = useMutation({
    mutationFn: () => recipesApi.fromUrl(urlInput.trim()),
    onSuccess: (res) => {
      populate(res.data);
      setImporter(null);
      setUrlInput('');
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not import from that URL.'),
  });

  const fromPhoto = useMutation({
    mutationFn: async (src: 'camera' | 'library') => {
      const file = src === 'camera' ? await takePhoto() : await pickImage();
      if (!file) return null;
      return uploadFile<Partial<Recipe>>('/recipes/from-photo', file, 'photo');
    },
    onSuccess: (data) => data && populate(data),
    onError: (e: any) => setError(e.response?.data?.error || 'Could not read that photo.'),
  });

  const save = useMutation({
    mutationFn: async () => {
      // Keep only named ingredients / non-empty steps, then remap the _lid links
      // to indices in the pruned ingredient list.
      const keptIngIdx = form.ingredients.map((ing, i) => ({ ing, lid: form.lids[i] })).filter((x) => x.ing.name.trim());
      const lidToIdx: Record<string, number> = {};
      keptIngIdx.forEach((x, idx) => { lidToIdx[x.lid] = idx; });
      const keptSteps = form.instructions
        .map((s, i) => ({ s, links: form.linkedIds[i] || [], timer: form.timers[i] || '' }))
        .filter((x) => x.s.trim());
      const instructionIngredients = keptSteps.map((x) =>
        x.links.map((lid) => lidToIdx[lid]).filter((n) => n != null)
      );
      const instructionTimers = keptSteps.map((x) => (x.timer.trim() ? Number(x.timer) : null));
      const hasTimers = instructionTimers.some((t) => t != null);
      const payload = {
        title: form.title,
        description: form.description,
        sourceUrl: form.sourceUrl,
        imageUrl: form.imageUrl,
        servings: form.servings ? Number(form.servings) : null,
        prepTimeMins: form.prepTimeMins ? Number(form.prepTimeMins) : null,
        cookTimeMins: form.cookTimeMins ? Number(form.cookTimeMins) : null,
        tags: form.tags.map((t) => t.trim()).filter(Boolean),
        ingredients: keptIngIdx.map((x) => x.ing),
        instructions: keptSteps.map((x) => x.s),
        instructionIngredients,
        // Persist the timers array when any step has one; null clears a
        // previously-saved set so removing every timer sticks on update.
        instructionTimers: hasTimers ? instructionTimers : null,
      };
      return isEdit
        ? recipesApi.update(id!, await sealUpdate('Recipe', id!, payload, RECIPE_ENC(payload)))
        : recipesApi.create(await sealNew('Recipe', payload, RECIPE_ENC(payload)));
    },
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      allowLeave();
      const newId = (res.data as Recipe)?._id;
      // Came from the planner's "Add recipe" for a date: schedule the new recipe
      // to that date, then return to the Meals/Planner view (not the detail page).
      if (!isEdit && newId && scheduleDate) {
        try {
          // Sealed create (Signal-parity D5): schedule notes are content.
          const payload = { recipeId: newId, scheduledDate: scheduleDate };
          await recipeScheduleApi.schedule(await sealNew('RecipeSchedule', payload, RECIPE_SCHEDULE_ENC(payload)));
          qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
          qc.invalidateQueries({ queryKey: ['grocery-list'] });
        } catch {
          // Recipe saved fine; if scheduling failed the user can add it from the planner.
        }
        // Pop the whole create flow (AddMeal → RecipeForm → assistant → …) off the
        // stack until we're back on the existing Meals view — so the user doesn't
        // have to back out manually — and tell it to scroll to the scheduled day.
        navigation.dispatch(
          StackActions.popTo('KitchenHome', { pane: 'planner', scrollToDate: scheduleDate }, { merge: true }),
        );
        return;
      }
      if (!isEdit && newId) navigation.replace('RecipeDetail', { id: newId });
      else navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const del = useMutation({
    mutationFn: () => recipesApi.delete(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      allowLeave();
      navigation.goBack();
    },
  });
  const confirmDelete = () =>
    Alert.alert('Delete Recipe', `Delete "${form.title || 'this recipe'}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);

  const addIngredient = () =>
    set({ ingredients: [...form.ingredients, { amount: '', unit: '', name: '' }], lids: [...form.lids, makeLid()] });
  const removeIngredient = (i: number) => {
    const lid = form.lids[i];
    set({
      ingredients: form.ingredients.filter((_, j) => j !== i),
      lids: form.lids.filter((_, j) => j !== i),
      linkedIds: form.linkedIds.map((ls) => ls.filter((x) => x !== lid)),
    });
  };
  const addStep = () =>
    set({ instructions: [...form.instructions, ''], linkedIds: [...form.linkedIds, []], timers: [...form.timers, ''] });
  const removeStep = (i: number) =>
    set({
      instructions: form.instructions.filter((_, j) => j !== i),
      linkedIds: form.linkedIds.filter((_, j) => j !== i),
      timers: form.timers.filter((_, j) => j !== i),
    });
  const setStepLinks = (i: number, lids: string[]) =>
    set({ linkedIds: form.linkedIds.map((ls, j) => (j === i ? lids : ls)) });
  const setStepTimer = (i: number, v: string) =>
    set({ timers: form.timers.map((t, j) => (j === i ? v.replace(/[^0-9]/g, '') : t)) });

  // AI edit: describe a change ("make it vegan", "double the servings") and let
  // the server rewrite the recipe, then repopulate the form from the result.
  const editWithAi = useMutation({
    mutationFn: () =>
      recipesApi.editWithAi(
        {
          title: form.title,
          description: form.description,
          servings: form.servings ? Number(form.servings) : null,
          prepTimeMins: form.prepTimeMins ? Number(form.prepTimeMins) : null,
          cookTimeMins: form.cookTimeMins ? Number(form.cookTimeMins) : null,
          tags: form.tags,
          ingredients: form.ingredients,
          instructions: form.instructions,
        },
        aiInput.trim()
      ),
    onSuccess: (res) => {
      populate(res.data);
      setAiInput('');
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Failed to apply changes.'),
  });

  // AI auto-link: ask the server which ingredients each step uses.
  const autoLink = useMutation({
    mutationFn: () => recipesApi.computeIngredientTags(form.ingredients.filter((i) => i.name.trim()), form.instructions.filter((s) => s.trim())),
    onSuccess: (res) => {
      const namedLids = form.ingredients.map((ing, i) => ({ named: !!ing.name.trim(), lid: form.lids[i] })).filter((x) => x.named).map((x) => x.lid);
      const incoming = res.data.instructionIngredients || [];
      let si = -1;
      const linkedIds = form.instructions.map((s) => {
        if (!s.trim()) return [];
        si += 1;
        return (incoming[si] || []).map((idx) => namedLids[idx]).filter(Boolean);
      });
      set({ linkedIds });
    },
  });

  const onSave = () => {
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    setError('');
    save.mutate();
  };

  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent });

  // Discard guard: prompt before leaving with unsaved edits to any recipe field
  // (title, ingredients, steps, tags, timers, links). Baseline is taken once the
  // form has seeded — imports/AI edits repopulate it and so read as changes.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify(form);
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  const onPhoto = () =>
    Alert.alert('Import from Photo', 'Scan a recipe card or cookbook page.', [
      { text: 'Take Photo', onPress: () => fromPhoto.mutate('camera') },
      { text: 'Choose Photo', onPress: () => fromPhoto.mutate('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  if (isEdit && recipeQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  const importing = fromUrl.isPending || fromPhoto.isPending;
  // The AI form assistant works on an existing recipe's fields — available both
  // when editing and when reviewing a pre-filled (AI-generated) recipe. The Quick
  // import card is only for building a blank recipe from scratch, so it's hidden
  // once the form is pre-filled.
  const isReview = !isEdit && !!initial;
  const showAssistant = (isEdit || isReview) && aiEnabled;
  const showQuickImport = !isEdit && !isReview && aiEnabled;

  return (
    <Screen>
      {/* AI Assistant — describe changes to apply, or tag ingredients to steps.
          The usage banner self-gates: it only appears near the weekly token limit. */}
      {showAssistant ? (
        <>
          <CreditsBanner />
          <View style={styles.aiCard}>
          <View style={styles.aiHeader}>
            <Ionicons name="sparkles" size={16} color={accent} />
            <Text style={styles.aiTitle}>AI Assistant</Text>
          </View>
          <Input
            value={aiInput}
            onChangeText={setAiInput}
            placeholder="Describe the changes you want, e.g. make it vegan, double the servings, add more spice"
            multiline
            editable={!editWithAi.isPending}
            style={styles.aiInput}
          />
          <View style={styles.aiActions}>
            <Button
              title="Apply changes"
              color={accent}
              loading={editWithAi.isPending}
              disabled={!aiInput.trim()}
              onPress={() => editWithAi.mutate()}
            />
            <TouchableOpacity
              style={[
                styles.tagBtn,
                { borderColor: accent },
                (autoLink.isPending || !form.ingredients.length || !form.instructions.length) && styles.tagBtnDisabled,
              ]}
              activeOpacity={0.8}
              disabled={autoLink.isPending || !form.ingredients.length || !form.instructions.length}
              onPress={() => autoLink.mutate()}
            >
              {autoLink.isPending ? (
                <ActivityIndicator size="small" color={accent} />
              ) : (
                <Text style={[styles.tagBtnText, { color: accent }]}>Tag ingredients to instructions</Text>
              )}
            </TouchableOpacity>
          </View>
          </View>
        </>
      ) : null}

      {/* Import bar — all three actions (URL, photo, assistant) call the AI provider */}
      {showQuickImport ? (
        <GroupCard style={styles.importCard}>
          <Text style={styles.importTitle}>Quick import</Text>
          <View style={styles.importBtns}>
            <TouchableOpacity
              style={[styles.iconBtn, { backgroundColor: accent }, importer === 'url' && styles.iconBtnActive]}
              onPress={() => setImporter((x) => (x === 'url' ? null : 'url'))}
              accessibilityLabel="Import from URL"
            >
              <Ionicons name="link-outline" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.iconBtn, { backgroundColor: accent }]} onPress={onPhoto} accessibilityLabel="Import from photo">
              <Ionicons name="camera-outline" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconBtn, { backgroundColor: accent }]}
              onPress={() => navigation.navigate('RecipeAssistant', { scheduleDate })}
              accessibilityLabel="AI Assistant"
            >
              <CalenChatIcon size={20} color="#fff" />
            </TouchableOpacity>
          </View>
          {importer === 'url' ? (
            <View style={styles.importPad}>
              <Input placeholder="https://…" value={urlInput} onChangeText={setUrlInput} autoCapitalize="none" />
              <Button title="Import" color={accent} loading={fromUrl.isPending} disabled={!urlInput.trim()} onPress={() => fromUrl.mutate()} />
            </View>
          ) : null}
          {importing && importer === null ? <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.sm }} /> : null}
        </GroupCard>
      ) : null}

      <GroupCard>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: v })}
          placeholder="Title"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
        <CardDivider />
        <Input
          value={form.description}
          onChangeText={(v) => set({ description: v })}
          placeholder="Description"
          multiline
          containerStyle={fs.headField}
          style={fs.headInput}
        />
      </GroupCard>

      <GroupCard>
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Servings</Text>
          <Input
            keyboardType="numeric"
            clearable={false}
            value={form.servings}
            onChangeText={(v) => set({ servings: v })}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput]}
          />
        </View>
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Prep (minutes)</Text>
          <Input
            keyboardType="numeric"
            clearable={false}
            value={form.prepTimeMins}
            onChangeText={(v) => set({ prepTimeMins: v })}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput]}
          />
        </View>
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Cook (minutes)</Text>
          <Input
            keyboardType="numeric"
            clearable={false}
            value={form.cookTimeMins}
            onChangeText={(v) => set({ cookTimeMins: v })}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput]}
          />
        </View>
      </GroupCard>

      <SectionTitle>Tags</SectionTitle>
      {form.tags.length ? (
        <View style={styles.chipsWrap}>
          {form.tags.map((t, i) => (
            <View key={i} style={styles.chip}>
              <Text style={styles.chipText}>{t}</Text>
              <TouchableOpacity onPress={() => removeTag(i)} accessibilityLabel={`Remove tag ${t}`}>
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      <GroupCard>
        <View style={styles.tagInputRow}>
          <Input
            placeholder="Add a tag"
            value={tagInput}
            onChangeText={setTagInput}
            onSubmitEditing={addTag}
            returnKeyType="done"
            blurOnSubmit={false}
            autoCapitalize="none"
            containerStyle={[fs.headField, styles.flex1]}
            style={fs.headInput}
          />
          <TouchableOpacity onPress={addTag} disabled={!tagInput.trim()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="add-circle" size={28} color={tagInput.trim() ? accent : colors.border} />
          </TouchableOpacity>
        </View>
      </GroupCard>

      <SectionTitle>Ingredients</SectionTitle>
      <GroupCard>
        {form.ingredients.map((ing, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <CardDivider /> : null}
            <View style={styles.ingRow}>
              {/* No clear ✕ in ingredient cells: the row's trailing remove
                  button is the same close-circle glyph, and two identical
                  adjacent icons with different meanings would misread. */}
              <Input
                placeholder="1"
                clearable={false}
                value={ing.amount ?? ''}
                onChangeText={(v) => set({ ingredients: form.ingredients.map((x, j) => (j === i ? { ...x, amount: v } : x)) })}
                containerStyle={[fs.headField, styles.ingAmount]}
                style={[fs.headInput, styles.ingInput]}
              />
              <Input
                placeholder="cup"
                clearable={false}
                value={ing.unit ?? ''}
                onChangeText={(v) => set({ ingredients: form.ingredients.map((x, j) => (j === i ? { ...x, unit: v } : x)) })}
                containerStyle={[fs.headField, styles.ingUnit]}
                style={[fs.headInput, styles.ingInput]}
              />
              <Input
                placeholder="flour"
                clearable={false}
                value={ing.name}
                onChangeText={(v) => set({ ingredients: form.ingredients.map((x, j) => (j === i ? { ...x, name: v } : x)) })}
                containerStyle={[fs.headField, styles.flex1]}
                style={[fs.headInput, styles.ingInput]}
              />
              <TouchableOpacity onPress={() => removeIngredient(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </React.Fragment>
        ))}
        {form.ingredients.length > 0 ? <CardDivider /> : null}
        <TouchableOpacity style={fs.dtRow} activeOpacity={0.7} onPress={addIngredient}>
          <Text style={[styles.addRowText, { color: accent }]}>+ Add Ingredient</Text>
        </TouchableOpacity>
      </GroupCard>

      <View style={styles.instrHead}>
        <SectionTitle>Instructions</SectionTitle>
      </View>
      {form.instructions.map((step, i) => (
        <GroupCard key={i}>
          <View style={styles.stepRow}>
            <Text style={styles.stepNum}>{i + 1}.</Text>
            <Input
              placeholder={`Step ${i + 1}`}
              value={step}
              onChangeText={(v) => set({ instructions: form.instructions.map((x, j) => (j === i ? v : x)) })}
              multiline
              containerStyle={[fs.headField, styles.flex1]}
              style={fs.headInput}
            />
            <TouchableOpacity onPress={() => removeStep(i)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <CardDivider />
          <View style={styles.timerRow}>
            <Ionicons name="timer-outline" size={16} color={accent} />
            <Input
              placeholder="Timer (minutes)"
              keyboardType="numeric"
              value={form.timers[i] || ''}
              onChangeText={(v) => setStepTimer(i, v)}
              containerStyle={[fs.headField, styles.flex1]}
              style={fs.headInput}
            />
          </View>
          {form.ingredients.length ? (
            <>
              <CardDivider />
              <View style={styles.linkerPad}>
                <StepIngredientLinker
                  value={form.linkedIds[i] || []}
                  ingredients={lidIngredients}
                  assignmentsById={assignmentsById}
                  stepNumber={i + 1}
                  stepText={step}
                  onChange={(lids) => setStepLinks(i, lids)}
                  accent={accent}
                />
              </View>
            </>
          ) : null}
        </GroupCard>
      ))}
      <GroupCard>
        <TouchableOpacity style={fs.dtRow} activeOpacity={0.7} onPress={addStep}>
          <Text style={[styles.addRowText, { color: accent }]}>+ Add Step</Text>
        </TouchableOpacity>
      </GroupCard>

      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={fs.footer}>
          <Button title="Delete recipe" variant="danger" loading={del.isPending} onPress={confirmDelete} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  aiCard: {
    backgroundColor: colors.primary + '14',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primary + '55',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  aiHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm },
  aiTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  aiInput: { minHeight: 68, textAlignVertical: 'top' },
  aiActions: { gap: spacing.sm, marginTop: spacing.sm },
  tagBtn: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagBtnDisabled: { opacity: 0.6 },
  tagBtnText: { fontSize: 16, fontWeight: '600' },
  importCard: { padding: 14 },
  importTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  importBtns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  iconBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  iconBtnActive: { opacity: 0.75 },
  importPad: { marginTop: spacing.sm, gap: spacing.sm },
  flex1: { flex: 1 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: 10 },
  chipText: { color: colors.text, fontSize: 14 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14 },
  ingRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14, gap: 4 },
  ingAmount: { width: 56 },
  ingUnit: { width: 64 },
  ingInput: { paddingHorizontal: 8 },
  addRowText: { fontSize: 16, fontWeight: '500' },
  instrHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 14, paddingRight: 14 },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: 14, paddingRight: 14 },
  linkerPad: { paddingHorizontal: 14, paddingVertical: spacing.sm },
  stepNum: { fontSize: 15, fontWeight: '700', color: colors.primary, paddingTop: 12 },
  removeBtn: { paddingTop: 12 },
});
