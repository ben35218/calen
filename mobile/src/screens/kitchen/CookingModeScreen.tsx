import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  View, StyleSheet, ScrollView, TouchableOpacity, Pressable, Vibration,
  ActionSheetIOS, Alert, Platform,
  LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent,
} from 'react-native';
import { Text } from '../../components/Text';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, RouteProp, useNavigation, usePreventRemove } from '@react-navigation/native';
import { recipesApi, Ingredient } from '../../api';
import { openRecipe } from '../../lib/recipeNames';
import { visibleStepIndices, ingredientInKit } from '../../lib/recipeVariations';
import {
  CookTimer, remainingSecs, subscribeCookTimers, getCookTimers,
  startCookTimer, dismissCookTimer, stopCookTimers, clearFinishedCookTimers,
  armCookTimerAlarms, disarmCookTimerAlarms,
} from '../../lib/cookTimers';
import { useVoiceCommands } from '../../hooks/useVoiceCommands';
import { pagedScrollTarget } from '../../lib/scrollPage';
import { BottomSheet, Button, CenteredLoader } from '../../components/ui';
import { KitchenStackParamList } from '../../navigation/KitchenNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, spacing, radius } from '../../theme';

// Keep the screen awake while cooking — a phone that sleeps mid-step defeats
// hands-free use. Optional require: a binary built before the module shipped
// (no EAS rebuild yet) just skips it instead of crashing.
let useKeepAwake: () => void;
try {
  useKeepAwake = require('expo-keep-awake').useKeepAwake;
} catch {
  useKeepAwake = () => {};
}

// Read-aloud TTS for the "read" voice command — on-device, free, and the same
// optional-require deal: expo-speech is a new native module, so a binary
// predating it degrades to a "needs an app update" flash instead of crashing.
type SpeechModule = {
  speak: (text: string, opts?: { rate?: number; onDone?: () => void; onStopped?: () => void; onError?: () => void }) => void;
  stop: () => Promise<void>;
};

// Ingredient lists are read slower than prose — the cook is measuring along,
// and amounts ("2", "cloves") carry all the information with none of a
// sentence's redundancy. Steps stay at the voice's normal rate (1.0).
const INGREDIENTS_SPEECH_RATE = 0.8;
let Speech: SpeechModule | null;
try {
  Speech = require('expo-speech');
} catch {
  Speech = null;
}

type Rt = RouteProp<KitchenStackParamList, 'CookingMode'>;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// The spoken grammar, cook-facing — rendered as the command chart in the
// "Voice commands" sheet. One row per action: the primary phrase(s) on the
// left, what it does on the right. Keep in step with the `commands` list in
// the screen body; the grammar grew past what a folded prose hint could hold.
const VOICE_GUIDE: { section: string; rows: [string, string][] }[] = [
  {
    section: 'Steps',
    rows: [
      ['“Next”', 'Go to the next step'],
      ['“Back”', 'Go to the previous step'],
      ['“Step 3”', 'Jump straight to a step'],
    ],
  },
  {
    section: 'Read aloud',
    rows: [
      ['“Read”', 'Read the current step'],
      ['“Read ingredients”', 'Read the ingredient list'],
    ],
  },
  {
    section: 'Scroll the step',
    rows: [
      ['“Up”', 'Scroll up a long step'],
      ['“Down”', 'Scroll down a long step'],
      ['“Top”', 'Jump to the step’s start'],
      ['“Bottom”', 'Jump to the step’s end'],
    ],
  },
  {
    section: 'Ingredients',
    rows: [
      ['“Ingredients”', 'Switch between this step’s and all ingredients'],
    ],
  },
  {
    section: 'Scroll the ingredients',
    rows: [
      ['“Ingredients up”', 'Scroll the list up'],
      ['“Ingredients down”', 'Scroll the list down'],
      ['“Ingredients top”', 'Jump to the list’s start'],
      ['“Ingredients bottom”', 'Jump to the list’s end'],
    ],
  },
  {
    section: 'Timer',
    rows: [['“Start timer”', 'Start this step’s timer']],
  },
];

// The way out when a timer is still counting. Leaving used to kill it silently;
// now the exit asks, in the same Apple-style action sheet the discard guard
// uses. "Keep" is the plain (non-destructive) choice because the timer running
// is the state the cook already asked for — stopping it is the loss.
function confirmLeaveWithTimers(count: number, decide: (keep: boolean) => void) {
  const many = count > 1;
  const title = many ? `${count} timers are still running.` : 'A timer is still running.';
  const message = many
    ? "They'll keep counting down and alert you when they're up."
    : "It'll keep counting down and alert you when it's up.";
  const keep = many ? 'Keep Timers Running' : 'Keep Timer Running';
  const stop = many ? 'Stop Timers and Leave' : 'Stop Timer and Leave';
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message, options: [keep, stop, 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2 },
      (i) => { if (i === 0) decide(true); else if (i === 1) decide(false); },
    );
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: stop, style: 'destructive', onPress: () => decide(false) },
      { text: keep, onPress: () => decide(true) },
    ]);
  }
}

// The timers for one recipe, straight from the module store — they outlive this
// screen, so the screen subscribes rather than owning them.
function useCookTimers(recipeId: string): CookTimer[] {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeCookTimers(bump), []);
  return getCookTimers(recipeId);
}

// One voice-paged scrollable pane (the step area, the ingredient panel): a
// "down"/"up" command moves it by a partial page (lib/scrollPage.
// pagedScrollTarget). Geometry lives in refs (no re-render per scroll tick);
// the target is written back optimistically so consecutive voice scrolls
// stack without waiting for the scroll events to land.
function usePagedScroll() {
  const ref = useRef<ScrollView>(null);
  const y = useRef(0);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const scrollByPage = useCallback((dir: 1 | -1) => {
    const target = pagedScrollTarget(y.current, dir, viewportH.current, contentH.current);
    if (target == null) return;
    ref.current?.scrollTo({ y: target, animated: true });
    y.current = target;
  }, []);
  // "Top"/"bottom" voice jumps — straight to an edge, unlike the partial-page
  // walk. The bottom target clamps at 0 for content shorter than the viewport.
  const scrollToEdge = useCallback((edge: 'top' | 'bottom') => {
    const target = edge === 'top' ? 0 : Math.max(0, contentH.current - viewportH.current);
    ref.current?.scrollTo({ y: target, animated: true });
    y.current = target;
  }, []);
  const resetTop = useCallback(() => {
    y.current = 0;
    ref.current?.scrollTo({ y: 0, animated: false });
  }, []);
  const onLayout = useCallback((e: LayoutChangeEvent) => { viewportH.current = e.nativeEvent.layout.height; }, []);
  const onContentSizeChange = useCallback((_w: number, h: number) => { contentH.current = h; }, []);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => { y.current = e.nativeEvent.contentOffset.y; }, []);
  // Stable identity, so effects can list the pane as a dep without re-firing.
  return useMemo(
    () => ({ ref, scrollByPage, scrollToEdge, resetTop, onLayout, onContentSizeChange, onScroll }),
    [scrollByPage, scrollToEdge, resetTop, onLayout, onContentSizeChange, onScroll],
  );
}

// Step-by-step cooking overlay (web CookingModeOverlay) rebuilt as a screen.
export default function CookingModeScreen() {
  const { id, variation } = useRoute<Rt>().params;
  const navigation = useNavigation();
  // Meals/recipes calendar colour (respects user overrides) — the section accent.
  const accent = useCalendarColors().colors.recipes;
  const [step, setStep] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const timers = useCookTimers(id);
  useKeepAwake();

  // Decrypt like every other recipe reader — the store row is sealed, so a raw
  // fetch renders only legacy plaintext fields (per-step ingredient tags and
  // timers live in the enc blob and silently vanish).
  const recipeQ = useQuery({ queryKey: ['recipes', id], queryFn: async () => openRecipe((await recipesApi.get(id)).data) });
  const recipe = recipeQ.data;

  // The kit being cooked lives in the header, where there's room for it — on
  // the progress line it crowded the voice pill.
  useLayoutEffect(() => {
    navigation.setOptions({ title: variation ? `Cooking — ${variation}` : 'Cooking' });
  }, [navigation, variation]);

  // On this screen the chip and the buzz are the alert, so any alarm armed on
  // the way out is stood down; finished timers go with the screen.
  useEffect(() => {
    void disarmCookTimerAlarms(id);
    return () => clearFinishedCookTimers(id);
  }, [id]);

  const steps = recipe?.instructions ?? [];
  // Cooking a chosen variation shows only the steps that apply to it (shared
  // steps + that kit's own). `step` is a POSITION in this visible list; the
  // real instruction index keeps the per-step ingredient tags and timers
  // aligned. A recipe whose tagging degenerates to zero visible steps falls
  // back to all of them rather than a dead screen.
  const chosen = variation ?? null;
  const applicable = recipe ? visibleStepIndices(recipe, chosen) : [];
  const visible = applicable.length ? applicable : steps.map((_, i) => i);
  const real = (p: number) => visible[p] ?? 0;
  const last = step >= visible.length - 1;
  // Other kits' ingredients are off-screen entirely while cooking a chosen kit.
  const allIngredients = (recipe?.ingredients ?? []).filter((ing) =>
    ingredientInKit(ing, recipe?.variations, chosen),
  );

  // Minutes configured for a given step position, if any.
  const timerMinsFor = (p: number) => {
    const m = recipe?.instructionTimers?.[real(p)];
    return m != null && m > 0 ? m : null;
  };
  const stepTimerMins = timerMinsFor(step);

  // Ingredients tagged to the current step (fall back to "view all").
  const stepIdx = recipe?.instructionIngredients?.[real(step)] ?? [];
  const stepIngredients = (showAll
    ? allIngredients
    : (stepIdx.map((idx) => recipe?.ingredients?.[idx]).filter(Boolean) as Ingredient[])
  ).filter((ing) => ingredientInKit(ing, recipe?.variations, chosen));

  const startTimer = (p: number) => {
    const mins = timerMinsFor(p);
    if (mins) startCookTimer(id, `Step ${p + 1}`, mins);
  };

  // Leaving with a live countdown asks first — see confirmLeaveWithTimers.
  //
  // `usePreventRemove`, NOT a hand-rolled `beforeRemove` + preventDefault: this
  // is a native stack, where preventing the JS event does not stop the native
  // pop. The screen came off natively while JS still believed it was mounted
  // ("removed natively, but didn't get removed from JS state"), so Cancel left
  // the cook staring at the recipe list. This hook is the supported path — it
  // holds the native screen too (`preventNativeDismiss`), and covers every exit:
  // back chevron, iOS swipe-back, Android back, and the Finish button.
  //
  // Re-dispatching the same action inside the callback is how the leave lands;
  // the action carries the route keys it has already asked, so it doesn't come
  // back around to this screen a second time.
  const running = timers.filter((t) => !t.done).length;
  usePreventRemove(running > 0, ({ data }) => {
    confirmLeaveWithTimers(running, (keep) => {
      // Keeping means the OS takes over the alerting, since the chip is about
      // to be off screen; stopping drops the timers and their alarms outright.
      if (keep) void armCookTimerAlarms(id);
      else stopCookTimers(id);
      navigation.dispatch(data.action);
    });
  });

  const goBackStep = () => {
    setStep((s) => Math.max(0, s - 1));
    setShowAll(false);
  };
  const advance = () => {
    // Kick off the leaving step's timer so it runs while later steps proceed.
    startTimer(step);
    setStep((s) => s + 1);
    setShowAll(false);
  };

  // A recognized command (or a mic problem) flashes briefly in the voice pill —
  // with a haptic — so the cook knows it landed without peering at the screen.
  const [heard, setHeard] = useState<string | null>(null);
  const heardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashHeard = (label: string, buzz = true) => {
    if (buzz) Vibration.vibrate(50);
    setHeard(label);
    if (heardTimer.current) clearTimeout(heardTimer.current);
    heardTimer.current = setTimeout(() => setHeard(null), 1400);
  };
  useEffect(() => () => { if (heardTimer.current) clearTimeout(heardTimer.current); }, []);

  // Voice scrolling: bare "down"/"up"/"top"/"bottom" move the step area,
  // "ingredients …" the ingredient panel — two independently paged panes.
  const stepScroll = usePagedScroll();
  const ingScroll = usePagedScroll();

  // The command chart (VOICE_GUIDE) pops up as a sheet — the grammar outgrew
  // an inline prose hint.
  const [showCommands, setShowCommands] = useState(false);

  // Hands-free navigation: on-device keyword spotting (no AI/telephony cost —
  // see useVoiceCommands). "Next" on the last step deliberately does nothing;
  // finishing (leaving the screen) stays a deliberate tap. "Step 3" (or "go to
  // step three") jumps straight to that step; out-of-range numbers are ignored.
  // "Read" speaks the current step aloud (readStep below).
  //
  // Destructive jumps are `anchored` (phrase at the utterance's start, or a
  // short command-shaped utterance): "step #" (whose number slot accepts the
  // to/for homophones, so "what is the next step to take" used to yank the
  // cook to step 2), "back" ("put the lid back on"), and the top/bottom edge
  // jumps. "previous" stays permissive — it doesn't occur in kitchen chatter
  // the way "back" does — as do next/repeat/ingredients per the bare-keyword
  // design ("OK, next!" must keep working).
  const goPrev = () => { if (step > 0) { flashHeard('Back'); goBackStep(); } };
  const voice = useVoiceCommands({
    commands: [
      { phrases: ['next', 'continue'], onMatch: () => { if (!last) { flashHeard('Next'); advance(); } } },
      { phrases: ['previous'], onMatch: goPrev },
      { phrases: ['back'], anchored: true, onMatch: goPrev },
      {
        phrases: ['go to step #', 'step #'],
        anchored: true,
        onMatch: (n) => {
          if (n && n >= 1 && n <= visible.length) {
            flashHeard(`Step ${n}`);
            setStep(n - 1);
            setShowAll(false);
          }
        },
      },
      { phrases: ['read', 'read step', 'read it', 'repeat'], onMatch: () => readStep() },
      { phrases: ['read ingredients'], onMatch: () => readIngredients() },
      { phrases: ['down', 'scroll down'], onMatch: () => { flashHeard('Down'); stepScroll.scrollByPage(1); } },
      { phrases: ['up', 'scroll up'], onMatch: () => { flashHeard('Up'); stepScroll.scrollByPage(-1); } },
      { phrases: ['top', 'scroll to top'], anchored: true, onMatch: () => { flashHeard('Top'); stepScroll.scrollToEdge('top'); } },
      { phrases: ['bottom', 'scroll to bottom'], anchored: true, onMatch: () => { flashHeard('Bottom'); stepScroll.scrollToEdge('bottom'); } },
      { phrases: ['ingredients down', 'scroll ingredients down'], onMatch: () => { flashHeard('Ingredients down'); ingScroll.scrollByPage(1); } },
      { phrases: ['ingredients up', 'scroll ingredients up'], onMatch: () => { flashHeard('Ingredients up'); ingScroll.scrollByPage(-1); } },
      { phrases: ['ingredients top'], anchored: true, onMatch: () => { flashHeard('Ingredients top'); ingScroll.scrollToEdge('top'); } },
      { phrases: ['ingredients bottom'], anchored: true, onMatch: () => { flashHeard('Ingredients bottom'); ingScroll.scrollToEdge('bottom'); } },
      { phrases: ['start timer', 'timer'], onMatch: () => { if (stepTimerMins) { flashHeard('Timer started'); startTimer(step); } } },
      { phrases: ['ingredients', 'show ingredients'], onMatch: () => { flashHeard('Ingredients'); setShowAll((v) => !v); } },
    ],
    onError: (msg) => flashHeard(msg, false),
  });

  // Speak the current step. The mic is parked for the duration — an open
  // recognizer would hear the phone's own voice, and a step text containing
  // "next" or "timer" would fire commands out of the recipe itself — and
  // resumes whichever way the speech ends.
  const readStep = () => {
    if (!Speech) {
      flashHeard('Reading needs an app update', false);
      return;
    }
    // No haptic on read commands: the narration starting IS the confirmation,
    // and a buzz right before the phone speaks reads as a glitch.
    flashHeard('Reading', false);
    voice.suspend();
    void Speech.stop();
    Speech.speak(`Step ${step + 1}. ${steps[real(step)] ?? ''}`, {
      onDone: voice.resume,
      onStopped: voice.resume,
      onError: voice.resume,
    });
  };
  // Speak the ingredient panel's current list — what the cook sees is what
  // they hear (this step's ingredients, or all of them while view-all is on).
  // Same mic parking as readStep: the phone must not command itself.
  const readIngredients = () => {
    if (!Speech) {
      flashHeard('Reading needs an app update', false);
      return;
    }
    if (!stepIngredients.length) {
      flashHeard('No ingredients to read', false);
      return;
    }
    // Same no-buzz rule as readStep — the voice is the feedback.
    flashHeard('Reading ingredients', false);
    voice.suspend();
    void Speech.stop();
    const lines = stepIngredients.map((ing) => [ing.amount, ing.unit, ing.name].filter(Boolean).join(' '));
    Speech.speak(`${showAll ? 'All ingredients' : `Ingredients for step ${step + 1}`}. ${lines.join('. ')}.`, {
      rate: INGREDIENTS_SPEECH_RATE,
      onDone: voice.resume,
      onStopped: voice.resume,
      onError: voice.resume,
    });
  };
  // Moving to another step (voice, tap zone, or button) cuts the old step's
  // narration short and rewinds the step area to its top; leaving the screen
  // never leaves the phone talking.
  useEffect(() => {
    void Speech?.stop();
    stepScroll.resetTop();
  }, [step, stepScroll]);
  // The ingredient panel's content changes with the step and with the
  // this-step ⇄ view-all flip — rewind it so the list starts at its top.
  useEffect(() => { ingScroll.resetTop(); }, [step, showAll, ingScroll]);
  useEffect(() => () => { void Speech?.stop(); }, []);

  if (recipeQ.isLoading || !recipe) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.progressRow}>
        <View style={styles.progressTop}>
          <Text style={styles.progress}>
            Step {step + 1} of {visible.length}
          </Text>
          <Pressable
            onPress={() => (voice.listening ? voice.stop() : voice.start())}
            accessibilityRole="button"
            accessibilityLabel={voice.listening ? 'Turn off voice commands' : 'Turn on voice commands'}
            style={[styles.voicePill, { borderColor: accent }, voice.listening && { backgroundColor: accent }]}
          >
            <Ionicons name={voice.listening ? 'mic' : 'mic-outline'} size={18} color={voice.listening ? '#fff' : accent} />
            <Text style={[styles.voicePillText, { color: voice.listening ? '#fff' : accent }]}>
              {heard ?? (voice.listening ? 'Listening…' : 'Voice')}
            </Text>
          </Pressable>
        </View>
        <View style={styles.bar}>
          <View style={[styles.barFill, { backgroundColor: accent, width: `${((step + 1) / Math.max(1, visible.length)) * 100}%` }]} />
        </View>
        {/* The ⓘ pair still marks "explain this", but the explanation became a
            chart: the grammar is too long for a folded prose hint to scan. */}
        <TouchableOpacity
          style={styles.voiceGuideRow}
          onPress={() => setShowCommands(true)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Show voice commands"
        >
          <Text style={styles.voiceGuideLabel}>Voice commands</Text>
          <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={stepScroll.ref}
        testID="step-scroll"
        contentContainerStyle={styles.body}
        onLayout={stepScroll.onLayout}
        onContentSizeChange={stepScroll.onContentSizeChange}
        onScroll={stepScroll.onScroll}
        scrollEventThrottle={16}
      >
        <View style={styles.stepZone}>
          <Text style={styles.stepText}>{steps[real(step)]}</Text>
          {stepTimerMins ? (
            <View style={styles.timerHint}>
              <Ionicons name="timer-outline" size={16} color={accent} />
              <Text style={[styles.timerHintText, { color: accent }]}>
                {stepTimerMins} min timer — starts when you continue
              </Text>
            </View>
          ) : null}
          {/* Knuckle-tap zones over the step area: the right side advances, the
              left ~third goes back — usable with messy hands, complementary to
              voice when the range hood drowns the mic. A drag still scrolls a
              long step (the ScrollView claims moves); a still tap navigates.
              Hidden from screen readers — the nav buttons below are the
              accessible path. "Next" stops at the last step: finishing stays a
              deliberate button tap. */}
          <View style={styles.zoneOverlay} accessible={false}>
            <Pressable testID="tap-back" accessible={false} style={styles.zoneBack} onPress={goBackStep} />
            <Pressable testID="tap-next" accessible={false} style={styles.zoneNext} onPress={() => { if (!last) advance(); }} />
          </View>
        </View>
      </ScrollView>

      {/* Running timers — several can count down at once */}
      {timers.length ? (
        <View style={styles.timersPanel}>
          {timers.map((t) => (
            <View key={t.id} style={[styles.timerChip, t.done && styles.timerChipDone]}>
              <Ionicons name={t.done ? 'alarm' : 'timer-outline'} size={16} color={t.done ? colors.error : accent} />
              <Text style={styles.timerChipLabel}>{t.label}</Text>
              <Text style={[styles.timerChipTime, t.done && styles.timerChipTimeDone]}>{t.done ? 'Done!' : fmt(remainingSecs(t))}</Text>
              <TouchableOpacity
                onPress={() => dismissCookTimer(t.id)}
                accessibilityLabel={`Stop ${t.label} timer`}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

      {/* Ingredient reference — this step by default, with a view-all toggle */}
      {allIngredients.length ? (
        <View style={styles.ingPanel}>
          <View style={styles.ingHead}>
            <Text style={styles.ingHeader}>{showAll ? 'All ingredients' : 'For this step'}</Text>
            <TouchableOpacity onPress={() => setShowAll((v) => !v)}>
              <Text style={[styles.ingToggle, { color: accent }]}>{showAll ? 'This step' : 'View all ingredients'}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            ref={ingScroll.ref}
            testID="ingredient-scroll"
            contentContainerStyle={{ paddingBottom: spacing.sm }}
            onLayout={ingScroll.onLayout}
            onContentSizeChange={ingScroll.onContentSizeChange}
            onScroll={ingScroll.onScroll}
            scrollEventThrottle={16}
          >
            {stepIngredients.length ? (
              stepIngredients.map((ing, i) => (
                <Text key={i} style={styles.ingLine}>
                  {/* With a kit chosen, other kits' ingredients are filtered
                      out; without one, flavor-kit ingredients name their
                      variation so the cook knows which pile is theirs. */}
                  • {[ing.amount, ing.unit, ing.name].filter(Boolean).join(' ')}
                  {!chosen && ing.group && recipe.variations?.includes(ing.group) ? ` (${ing.group})` : ''}
                </Text>
              ))
            ) : (
              <Text style={styles.ingEmpty}>No ingredients tagged to this step.</Text>
            )}
          </ScrollView>
        </View>
      ) : null}

      {/* The command chart. Grouped two-column rows: say this → get that. */}
      <BottomSheet visible={showCommands} onClose={() => setShowCommands(false)} title="Voice Commands">
        <ScrollView contentContainerStyle={{ paddingBottom: spacing.sm }}>
          <Text style={styles.guideIntro}>While the mic is listening, say any of these. The pill flashes what it heard.</Text>
          {VOICE_GUIDE.map((g) => (
            <View key={g.section}>
              <Text style={styles.guideSection}>{g.section}</Text>
              {g.rows.map(([say, does]) => (
                <View key={say} style={styles.guideRow}>
                  <Text style={styles.guideSay}>{say}</Text>
                  <Text style={styles.guideDoes}>{does}</Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </BottomSheet>

      <View style={styles.nav}>
        <TouchableOpacity
          style={[styles.backBtn, { borderColor: accent }, step === 0 && styles.backDisabled]}
          disabled={step === 0}
          onPress={goBackStep}
          accessibilityLabel="Previous step"
        >
          <Ionicons name="chevron-back" size={24} color={accent} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Button
            title={last ? 'Finish' : 'Next'}
            color={accent}
            onPress={() => (last ? navigation.goBack() : advance())}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  progressRow: { padding: spacing.md },
  progressTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  progress: { fontSize: 14, color: colors.textMuted },
  // Wide enough to read at arm's length across the kitchen — and a fixed
  // minWidth so the pill doesn't jump when its label flips between
  // Voice/Listening…/the flashed command.
  voicePill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 8, minWidth: 148 },
  voicePillText: { fontSize: 15, fontWeight: '600' },
  // The chart trigger under the progress bar — same shape as a HintDisclosure
  // label row, but the ⓘ opens the sheet instead of unfolding prose.
  voiceGuideRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingVertical: 6, marginTop: spacing.xs },
  voiceGuideLabel: { fontSize: 15, color: colors.text, fontWeight: '600' },
  // The command chart inside the sheet.
  guideIntro: { fontSize: 13, color: colors.textMuted, lineHeight: 18, marginBottom: spacing.xs },
  guideSection: {
    fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase',
    marginTop: spacing.md, marginBottom: spacing.xs,
    // Ruled off from its rows — the line is what makes the groups scan as a chart.
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: 6,
  },
  guideRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 5 },
  guideSay: { width: 168, fontSize: 15, fontWeight: '600', color: colors.text },
  guideDoes: { flex: 1, fontSize: 15, color: colors.textMuted },
  bar: { height: 4, backgroundColor: colors.border, borderRadius: 2 },
  barFill: { height: 4, backgroundColor: colors.primary, borderRadius: 2 },
  body: { padding: spacing.lg, flexGrow: 1 },
  stepZone: { flexGrow: 1, justifyContent: 'center' },
  zoneOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row' },
  zoneBack: { flex: 3 },
  zoneNext: { flex: 7 },
  stepText: { fontSize: 24, lineHeight: 34, color: colors.text, fontWeight: '500' },
  timerHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.lg },
  timerHintText: { fontSize: 14, fontWeight: '600' },
  timersPanel: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  timerChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
  timerChipDone: { borderColor: colors.error, backgroundColor: colors.error + '14' },
  timerChipLabel: { fontSize: 13, color: colors.text, fontWeight: '600' },
  timerChipTime: { fontSize: 14, color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  timerChipTimeDone: { color: colors.error },
  ingPanel: { maxHeight: 160, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md },
  ingHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  ingHeader: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  ingToggle: { fontSize: 13, fontWeight: '600' },
  ingLine: { fontSize: 15, color: colors.text, paddingVertical: 2 },
  ingEmpty: { fontSize: 14, color: colors.textMuted, fontStyle: 'italic' },
  nav: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  backBtn: { borderWidth: 1, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  backDisabled: { opacity: 0.4 },
});
