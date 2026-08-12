import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Image, TouchableOpacity, Alert, Keyboard } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp, StackActions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { recipesApi, recipeScheduleApi, Recipe, Ingredient } from '../../api';
import { sealNew, sealUpdate } from '../../lib/e2ee';
import { ingredientName, openRecipe, withIngredientNames } from '../../lib/recipeNames';
import { RECIPE_ENC, RECIPE_SCHEDULE_ENC } from '../../lib/encSubsets';
import { deleteRecipeWithSchedules, popCountAfterDelete } from '../../lib/recipeDelete';
import { Button, Chip, Input, Screen, SectionTitle, useHeaderCheckButton, FormError, CenteredLoader, Skeleton } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import StepIngredientLinker from '../../components/StepIngredientLinker';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import CalenChatIcon from '../../components/CalenChatIcon';
import FormAssist from '../../components/FormAssist';
import { ASSISTANT_NAME } from '../../config';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { takePhoto, pickImages, PickedFile } from '../../lib/media';
import { recipeImageUri, uploadRecipePhoto, claimRecipePhoto } from '../../lib/recipePhoto';
import { pickVariation } from '../../lib/recipeVariations';
import { capFirst } from '../../lib/strings';
import { uploadFiles } from '../../lib/upload';
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
  // Ingredient-group names that are mutually exclusive flavor variations
  // (groups ride inside each ingredient's `group`).
  variations: string[];
  instructions: string[];
  // Per-step timer in minutes (parallel to instructions); '' = no timer.
  timers: string[];
  // Per-step variation tags (parallel to instructions); [] = every variation.
  stepVariations: string[][];
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
  variations: [],
  instructions: [],
  timers: [],
  stepVariations: [],
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
  const [importer, setImporter] = useState<'url' | null>(null);
  // A quick import (URL/photo) has populated the form: swap the import card for
  // the AI assistant so the imported recipe can be refined before saving.
  const [imported, setImported] = useState(false);
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
    queryFn: async () => openRecipe((await recipesApi.get(id!)).data),
    enabled: isEdit,
  });

  // Everything that fills this form arrives here — an existing recipe, an AI
  // draft from an import/generate, an AI edit — so the ingredient-name casing is
  // applied once, on the way in, rather than at each of the callers.
  const populate = (incoming: Partial<Recipe>) =>
    setForm((f) => {
      const data = withIngredientNames(incoming);
      const ingredients = data.ingredients ?? f.ingredients;
      const instructions = data.instructions ?? f.instructions;
      // Regenerate stable lids whenever the ingredient list is replaced.
      const lids = data.ingredients ? data.ingredients.map(() => makeLid()) : f.lids;
      // Build per-step linkedIds from incoming instructionIngredients (indices).
      let linkedIds = f.linkedIds;
      let timers = f.timers;
      let stepVariations = f.stepVariations;
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
        const incomingSV = data.instructionVariations;
        stepVariations = instructions.map((_, si) => incomingSV?.[si] ?? []);
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
        variations: data.variations ?? f.variations,
        instructions,
        timers,
        stepVariations,
        lids,
        linkedIds,
      };
    });

  useEffect(() => {
    if (!recipeQ.data) return;
    let cancelled = false;
    openRecipe(recipeQ.data).then((r) => { if (!cancelled) { populate(r); setSeeded(true); } }); // decrypt over plaintext
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
      setImported(true);
      setImporter(null);
      setUrlInput('');
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not import from that URL.'),
  });

  // Tapping Import hands the screen over to the extraction: the keyboard drops
  // and the Quick import card gives way to the skeleton (below), so the only
  // thing on screen is the recipe being filled in. A failure brings the card
  // back with the URL still typed, ready to retry.
  const onImportUrl = () => {
    Keyboard.dismiss();
    setError('');
    fromUrl.mutate();
  };

  // Matches the server's upload.array cap on /recipes/from-photo.
  const MAX_PHOTOS = 5;
  const askAnotherPage = (count: number) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(`Page ${count} added`, 'Take another photo of this recipe?', [
        { text: 'Add Another Page', onPress: () => resolve(true) },
        { text: 'Done', style: 'cancel', onPress: () => resolve(false) },
      ]);
    });

  const fromPhoto = useMutation({
    mutationFn: async (src: 'camera' | 'library') => {
      // A long recipe can span pages: the library picker multi-selects, and the
      // camera loops "another page?" — every page uploads as ONE extraction.
      let files: PickedFile[] = [];
      if (src === 'camera') {
        while (files.length < MAX_PHOTOS) {
          const file = await takePhoto();
          if (!file) break; // cancelled — extract whatever pages are in hand
          files.push(file);
          if (files.length >= MAX_PHOTOS || !(await askAnotherPage(files.length))) break;
        }
      } else {
        files = await pickImages(MAX_PHOTOS);
      }
      if (!files.length) return null;
      return uploadFiles<Partial<Recipe>>('/recipes/from-photo', files, 'photo');
    },
    onSuccess: (data) => {
      if (!data) return;
      populate(data);
      setImported(true);
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not read those photos.'),
  });

  const save = useMutation({
    mutationFn: async () => {
      // Keep only named ingredients / non-empty steps, then remap the _lid links
      // to indices in the pruned ingredient list.
      const keptIngIdx = form.ingredients.map((ing, i) => ({ ing, lid: form.lids[i] })).filter((x) => x.ing.name.trim());
      const lidToIdx: Record<string, number> = {};
      keptIngIdx.forEach((x, idx) => { lidToIdx[x.lid] = idx; });
      const keptSteps = form.instructions
        .map((s, i) => ({ s, links: form.linkedIds[i] || [], timer: form.timers[i] || '', sv: form.stepVariations[i] || [] }))
        .filter((x) => x.s.trim());
      const instructionIngredients = keptSteps.map((x) =>
        x.links.map((lid) => lidToIdx[lid]).filter((n) => n != null)
      );
      const instructionTimers = keptSteps.map((x) => (x.timer.trim() ? Number(x.timer) : null));
      const hasTimers = instructionTimers.some((t) => t != null);
      // A variation whose every ingredient was deleted is no longer a choice —
      // and a step tag pointing at a dropped variation goes with it.
      const keptGroups = new Set(keptIngIdx.map((x) => x.ing.group).filter(Boolean));
      const keptVariations = form.variations.filter((v) => keptGroups.has(v));
      const instructionVariations = keptSteps.map((x) => {
        const sv = x.sv.filter((v) => keptVariations.includes(v));
        return sv.length ? sv : null;
      });
      const hasStepVariations = instructionVariations.some((v) => v != null);
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
        variations: keptVariations,
        instructions: keptSteps.map((x) => x.s),
        instructionIngredients,
        // Persist the timers array when any step has one; null clears a
        // previously-saved set so removing every timer sticks on update.
        instructionTimers: hasTimers ? instructionTimers : null,
        // Same contract for the per-step variation tags.
        instructionVariations: hasStepVariations ? instructionVariations : null,
      };
      return isEdit
        ? recipesApi.update(id!, await sealUpdate('Recipe', id!, payload, RECIPE_ENC(payload)))
        : recipesApi.create(await sealNew('Recipe', payload, RECIPE_ENC(payload)));
    },
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      allowLeave();
      const newId = (res.data as Recipe)?._id;
      // Bind the photo to the saved recipe. The server can't read the sealed
      // imageUrl, so until it is told, the file counts as an abandoned draft and
      // the nightly sweep takes it; this also drops the bytes of a photo that was
      // replaced. Best-effort — never at the cost of the save (lib/recipePhoto).
      void claimRecipePhoto(id ?? newId, form.imageUrl);
      // Came from the planner's "Add recipe" for a date: schedule the new recipe
      // to that date, then return to the Meals/Planner view (not the detail page).
      if (!isEdit && newId && scheduleDate) {
        try {
          // A recipe with flavor variations schedules as one of them; cancelling
          // the prompt still schedules (the recipe is already saved), just with
          // no choice recorded — the grocery list then buys every kit.
          const variation = (await pickVariation({ title: form.title, variations: form.variations })) ?? null;
          // Sealed create (Signal-parity D5): schedule notes are content.
          const payload = { recipeId: newId, scheduledDate: scheduleDate, ...(variation ? { variation } : {}) };
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
    mutationFn: () => deleteRecipeWithSchedules(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      qc.invalidateQueries({ queryKey: ['recipe-schedule'] });
      qc.invalidateQueries({ queryKey: ['grocery-list'] });
      allowLeave();
      // Pop past the deleted recipe's own detail screen when it's underneath
      // (the pencil's push), not back onto it — see popCountAfterDelete.
      const { routes, index } = navigation.getState();
      navigation.dispatch(StackActions.pop(popCountAfterDelete(routes, index, id!)));
    },
  });
  const confirmDelete = () =>
    Alert.alert('Delete Recipe', `Delete "${form.title || 'this recipe'}"? Any meals planned with it will be removed too. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);

  // A new row continues the section it's added under (the last row's group);
  // on an ungrouped recipe that's simply no group at all.
  const addIngredient = () =>
    set({
      ingredients: [...form.ingredients, { amount: '', unit: '', name: '', group: form.ingredients[form.ingredients.length - 1]?.group }],
      lids: [...form.lids, makeLid()],
    });
  const removeIngredient = (i: number) => {
    const lid = form.lids[i];
    set({
      ingredients: form.ingredients.filter((_, j) => j !== i),
      lids: form.lids.filter((_, j) => j !== i),
      linkedIds: form.linkedIds.map((ls) => ls.filter((x) => x !== lid)),
    });
  };
  const addStep = () =>
    set({ instructions: [...form.instructions, ''], linkedIds: [...form.linkedIds, []], timers: [...form.timers, ''], stepVariations: [...form.stepVariations, []] });
  const removeStep = (i: number) =>
    set({
      instructions: form.instructions.filter((_, j) => j !== i),
      linkedIds: form.linkedIds.filter((_, j) => j !== i),
      timers: form.timers.filter((_, j) => j !== i),
      stepVariations: form.stepVariations.filter((_, j) => j !== i),
    });
  const setStepLinks = (i: number, lids: string[]) =>
    set({ linkedIds: form.linkedIds.map((ls, j) => (j === i ? lids : ls)) });
  const setStepTimer = (i: number, v: string) =>
    set({ timers: form.timers.map((t, j) => (j === i ? v.replace(/[^0-9]/g, '') : t)) });
  // Toggle a step in/out of a variation; no selections = the step is shared.
  const toggleStepVariation = (i: number, v: string) =>
    set({
      stepVariations: form.stepVariations.map((sv, j) =>
        j === i ? (sv.includes(v) ? sv.filter((x) => x !== v) : [...sv, v]) : sv,
      ),
    });

  // AI edit: describe a change ("make it vegan", "double the servings") and let
  // the server rewrite the recipe, then repopulate the form from the result.
  // The response arrives with its ingredient-to-step tags already recomputed
  // (edit-with-ai runs the tagger before returning), so applying a change is
  // also what refreshes the step links. Runs through the FormAssist card, which
  // owns the loading/error presentation (throw = in-card error).
  const applyAiEdit = async (prompt: string) => {
    const res = await recipesApi.editWithAi(
      {
        title: form.title,
        description: form.description,
        servings: form.servings ? Number(form.servings) : null,
        prepTimeMins: form.prepTimeMins ? Number(form.prepTimeMins) : null,
        cookTimeMins: form.cookTimeMins ? Number(form.cookTimeMins) : null,
        tags: form.tags,
        ingredients: form.ingredients,
        variations: form.variations,
        instructions: form.instructions,
        instructionVariations: form.stepVariations.map((sv) => (sv.length ? sv : null)),
      },
      prompt
    );
    populate(res.data);
  };

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
    Alert.alert('Import from Photos', 'Scan a recipe card or cookbook page. A long recipe can span several photos.', [
      { text: 'Take Photos', onPress: () => fromPhoto.mutate('camera') },
      { text: 'Choose Photos', onPress: () => fromPhoto.mutate('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  // The recipe's own picture — what the library list and the detail hero show.
  // Distinct from the import above in every way that matters: that reads a
  // recipe OUT of a photo of a page, this attaches a photo OF the dish. It
  // uploads on pick (not on save) so the field holds a server path the record
  // can carry, and so the save stays a single small write.
  const dishPhoto = useMutation({
    mutationFn: async (src: 'camera' | 'library') => {
      const file = src === 'camera' ? await takePhoto() : (await pickImages(1))[0];
      return file ? uploadRecipePhoto(file) : null;
    },
    onSuccess: (imageUrl) => { if (imageUrl) set({ imageUrl }); },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not add that photo.'),
  });

  const onDishPhoto = () =>
    Alert.alert(
      form.imageUrl ? 'Recipe Photo' : 'Add a Photo',
      'A picture of the finished dish, shown on the recipe and in your library.',
      [
        { text: 'Take Photo', onPress: () => dishPhoto.mutate('camera') },
        { text: 'Choose Photo', onPress: () => dishPhoto.mutate('library') },
        // Only the field is cleared here. The file is dropped when the recipe is
        // saved (the claim reconciles what it kept), so a removal the user backs
        // out of costs nothing.
        ...(form.imageUrl
          ? [{ text: 'Remove Photo', style: 'destructive' as const, onPress: () => set({ imageUrl: '' }) }]
          : []),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );

  if (isEdit && recipeQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  const importing = fromUrl.isPending || fromPhoto.isPending;
  // The AI form assistant works on an existing recipe's fields — available when
  // editing, when reviewing a pre-filled (AI-generated) recipe, and once a quick
  // import has populated the form. The Quick import card is only for building a
  // blank recipe from scratch, so it's hidden once the form is pre-filled.
  const isReview = !isEdit && !!initial;
  const showAssistant = (isEdit || isReview || imported) && aiEnabled && !importing;
  // …and while an import runs the card steps aside too, so the shimmering
  // skeleton is the whole screen.
  const showQuickImport = !isEdit && !isReview && !imported && aiEnabled && !importing;

  return (
    <Screen>
      {/* Calen, the form assistant (shared card) — describe changes to apply;
          the result comes back with its ingredient-to-step tags already
          refreshed. A plain edit opens it collapsed; a just-imported/reviewed
          recipe opens it expanded, since refining the import is the expected
          next step. */}
      {showAssistant ? (
        <FormAssist
          onSubmit={applyAiEdit}
          accent={accent}
          actionLabel="Apply changes"
          defaultExpanded={isReview || imported}
          placeholder="Describe the changes you want, e.g. make it vegan, double the servings, add more spice"
          restingPlaceholder="Describe the changes you want"
        />
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
              accessibilityLabel={ASSISTANT_NAME}
            >
              <CalenChatIcon size={20} color="#fff" />
            </TouchableOpacity>
          </View>
          {importer === 'url' ? (
            <View style={styles.importPad}>
              <Input placeholder="https://…" value={urlInput} onChangeText={setUrlInput} autoCapitalize="none" />
              <Button title="Import" color={accent} loading={fromUrl.isPending} disabled={!urlInput.trim()} onPress={onImportUrl} />
            </View>
          ) : null}
        </GroupCard>
      ) : null}

      {importing ? (
        // Extraction takes several seconds — shimmer a skeleton in the shape of
        // the form being filled (like the calendar's loading cells), instead of
        // leaving the empty form under a spinner.
        <ImportSkeleton />
      ) : (<>

      <GroupCard>
        <Input
          value={form.title}
          onChangeText={(v) => set({ title: capFirst(v) })}
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
        <CardDivider />
        {/* The recipe's photo, sitting with the title it belongs to. The whole
            row is the target — a thumbnail this size is not a tap target, and
            the row reads as one control ("Photo · Add"). */}
        <TouchableOpacity
          style={styles.photoRow}
          onPress={onDishPhoto}
          disabled={dishPhoto.isPending}
          accessibilityRole="button"
          accessibilityLabel={form.imageUrl ? 'Change recipe photo' : 'Add a recipe photo'}
        >
          {dishPhoto.isPending ? (
            <View style={[styles.photoThumb, styles.photoEmpty]}><ActivityIndicator size="small" color={accent} /></View>
          ) : recipeImageUri(form.imageUrl) ? (
            <Image source={{ uri: recipeImageUri(form.imageUrl)! }} style={styles.photoThumb} />
          ) : (
            <View style={[styles.photoThumb, styles.photoEmpty]}>
              <Ionicons name="restaurant-outline" size={22} color={colors.textMuted} />
            </View>
          )}
          <Text style={styles.photoLabel}>Photo</Text>
          <Text style={[styles.photoAction, { color: accent }]}>
            {dishPhoto.isPending ? 'Uploading…' : form.imageUrl ? 'Change' : 'Add'}
          </Text>
        </TouchableOpacity>
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
            {/* Section header where a new group starts (import/AI supply the
                groups; "Variation" marks a flavor kit picked when planning). */}
            {ing.group && ing.group !== form.ingredients[i - 1]?.group ? (
              <View style={styles.groupHeaderRow}>
                <Text style={styles.groupHeaderText}>{ing.group}</Text>
                {form.variations.includes(ing.group) ? (
                  <Text style={[styles.groupVariationTag, { color: accent }]}>Variation</Text>
                ) : null}
              </View>
            ) : null}
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
              {/* Typed names are cased like the imported ones (lib/recipeNames)
                  — same length in as out, so the caret never jumps. */}
              <Input
                placeholder="Flour"
                clearable={false}
                value={ing.name}
                onChangeText={(v) => set({ ingredients: form.ingredients.map((x, j) => (j === i ? { ...x, name: ingredientName(v) } : x)) })}
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
          {/* Which variations this step belongs to — none selected = all of
              them. Cooking mode drops a tagged step for the other kits. */}
          {form.variations.length ? (
            <>
              <CardDivider />
              <View style={styles.stepVarRow}>
                <Text style={styles.stepVarLabel}>
                  {(form.stepVariations[i] || []).length ? 'Only for' : 'All variations'}
                </Text>
                {form.variations.map((v) => (
                  <Chip
                    key={v}
                    label={v}
                    color={accent}
                    selected={(form.stepVariations[i] || []).includes(v)}
                    onPress={() => toggleStepVariation(i, v)}
                  />
                ))}
              </View>
            </>
          ) : null}
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

      </>)}

      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={fs.footer}>
          <Button title="Delete recipe" variant="danger" loading={del.isPending} onPress={confirmDelete} />
        </View>
      ) : null}
    </Screen>
  );
}

// A shimmering placeholder in the shape of the recipe form an import is about
// to fill — title/description, the meta rows, ingredients, then steps. Built
// from the shared Skeleton pulse (the same one the calendar's loading cells use).
function ImportSkeleton() {
  return (
    <View testID="import-skeleton">
      <GroupCard style={styles.skelCard}>
        <Skeleton width={'55%'} height={18} />
        <Skeleton width={'92%'} height={13} style={styles.skelGapSm} />
        <Skeleton width={'70%'} height={13} style={styles.skelGapSm} />
      </GroupCard>
      <GroupCard style={styles.skelCard}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.skelRow, i > 0 ? styles.skelGap : null]}>
            <Skeleton width={'38%'} height={14} />
            <Skeleton width={48} height={14} />
          </View>
        ))}
      </GroupCard>
      <GroupCard style={styles.skelCard}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.skelRow, i > 0 ? styles.skelGap : null]}>
            <Skeleton width={64} height={14} />
            <Skeleton width={'58%'} height={14} />
          </View>
        ))}
      </GroupCard>
      {[0, 1].map((i) => (
        <GroupCard key={i} style={styles.skelCard}>
          <Skeleton width={'100%'} height={13} />
          <Skeleton width={'88%'} height={13} style={styles.skelGapSm} />
          <Skeleton width={'64%'} height={13} style={styles.skelGapSm} />
        </GroupCard>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  importCard: { padding: 14 },
  importTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  importBtns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  // The photo row inside the title card: thumbnail, label, and the action word
  // on the right, like a settings row that happens to show what it holds.
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: 14, paddingVertical: 10 },
  photoThumb: { width: 48, height: 48, borderRadius: 8 },
  photoEmpty: { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  photoLabel: { flex: 1, fontSize: 16, color: colors.text },
  photoAction: { fontSize: 16, fontWeight: '600' },
  iconBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  iconBtnActive: { opacity: 0.75 },
  importPad: { marginTop: spacing.sm, gap: spacing.sm },
  flex1: { flex: 1 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: 10 },
  chipText: { color: colors.text, fontSize: 14 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14 },
  groupHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 14, paddingTop: spacing.sm },
  groupHeaderText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  groupVariationTag: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  ingRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14, gap: 4 },
  ingAmount: { width: 56 },
  ingUnit: { width: 64 },
  ingInput: { paddingHorizontal: 8 },
  addRowText: { fontSize: 16, fontWeight: '500' },
  instrHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 14, paddingRight: 14 },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: 14, paddingRight: 14 },
  stepVarRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, paddingHorizontal: 14, paddingVertical: spacing.sm },
  stepVarLabel: { fontSize: 13, color: colors.textMuted, marginRight: spacing.xs },
  linkerPad: { paddingHorizontal: 14, paddingVertical: spacing.sm },
  stepNum: { fontSize: 15, fontWeight: '700', color: colors.primary, paddingTop: 12 },
  removeBtn: { paddingTop: 12 },
  skelCard: { padding: spacing.md },
  skelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skelGap: { marginTop: spacing.md },
  skelGapSm: { marginTop: spacing.sm },
});
