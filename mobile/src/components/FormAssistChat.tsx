import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, TextInput } from './Text';
import { BottomSheet } from './ui';
import AssistantButton from './AssistantButton';
import CreditsBanner from './CreditsBanner';
import { formAssistApi, FormAssistField, FormAssistTurn } from '../api';
import { toApiMessages } from '../lib/formAssistTranscript';
import { usePrivacyPrefs } from '../lib/privacyPrefs';
import { ASSISTANT_NAME } from '../config';
import { colors, spacing, radius } from '../theme';

// "Ask Calen" on an add/edit form: a floating pill bottom-right, opening a
// half-screen chat sheet.
//
// This replaces the card that used to sit at the top of every form. The form is
// the screen's job; Calen is an accelerator, so it gets a corner rather than
// permanent vertical space. The trade is real — a corner affordance is less
// discoverable than a card — which is why the pill carries the words "Ask
// Calen" rather than being a bare glyph.
//
// THE CONVERSATION LIVES AND DIES WITH THE SCREEN. It is plain component state:
// nothing is written to disk (form values stay in memory, matching the E2EE
// posture) and nothing goes through lib/chatHistory, whose 7-day per-surface
// store and cross-surface resume are the opposite of what a form wants. React
// Navigation keeps a form mounted while a sub-screen (Location, Repeat, Alerts)
// is pushed on top, so the transcript survives a drill-in and return for free —
// and saving pops the form, which unmounts it and takes the transcript with it.
//
// A turn that fills something closes the sheet after a beat. A turn that can't
// (the model asked a clarifying question) leaves it open, so the answer can be
// typed straight back.

// Long enough to read the model's one-line confirmation before the form comes
// back with its fields highlighted. The highlights are the durable record; this
// beat just stops the sentence from flashing past unread.
const CLOSE_DELAY_MS = 900;

// The most of the window the sheet may take. It SIZES TO ITS CONTENT — this
// only stops a long conversation from swallowing the screen.
const RESTING_FRACTION = 0.58;

export interface FormAssistChatHandle {
  // Drop the conversation. Needed only where a form RE-SEEDS itself in place (a
  // trip confirmation import, a recipe import): the transcript that came before
  // is about a different record.
  reset: () => void;
}

function FormAssistChat(
  {
    formType,
    fields,
    current,
    onApply,
    onSubmit,
    disabled,
    includeContacts,
    accent,
    label = `Ask ${ASSISTANT_NAME}`,
    placeholder = 'Describe what you want to add…',
    attention,
  }: {
    formType?: string;
    fields?: FormAssistField[];
    current?: Record<string, unknown>;
    onApply?: (patch: Record<string, unknown>) => void;
    // Replaces the /form-assist call: the screen runs its own AI action on the
    // prompt (the recipe form's whole-recipe rewrite). Throw to surface an
    // error in the sheet. There is no patch, so the sheet stays open on success
    // and shows a confirmation instead.
    onSubmit?: (prompt: string) => Promise<void>;
    disabled?: boolean;
    includeContacts?: boolean;
    // Section accent for the send button in an accented feature area; the sheet
    // chrome itself stays app-primary — it is Calen's, not the section's.
    accent?: string;
    label?: string;
    placeholder?: string;
    // Pulse the pill once on mount — for arriving at a form whose expected next
    // step IS the assistant (a just-imported booking or recipe).
    attention?: boolean;
  },
  ref: React.Ref<FormAssistChatHandle>,
) {
  const { prefs } = usePrivacyPrefs();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<FormAssistTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [keyboardH, setKeyboardH] = useState(0);
  const pillOpacity = useRef(new Animated.Value(1)).current;
  const scrollRef = useRef<ScrollView>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      setTurns([]);
      setInput('');
      setError('');
    },
  }), []);

  // One listener drives both the sheet's height and the pill's visibility.
  // The pill is anchored to the WINDOW bottom, so with the keyboard up it would
  // render on top of the keys — and the user is mid-typing in the form anyway.
  // Fade rather than unmount: unmounting pops it back with a fresh mount, which
  // re-runs the intro pulse.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKeyboardH(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    Animated.timing(pillOpacity, {
      toValue: keyboardH > 0 ? 0 : 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [keyboardH, pillOpacity]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const close = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(false);
  };

  const addTurn = (turn: FormAssistTurn) => setTurns((prev) => [...prev, turn]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;

    // Drop the keyboard as the turn is sent: the sheet springs back to its full
    // resting height, so the reply is read at full width rather than in the
    // strip left above the keys.
    Keyboard.dismiss();
    setInput('');
    setError('');
    addTurn({ role: 'user', content: prompt });
    setLoading(true);

    try {
      if (onSubmit) {
        // The screen owns the action and the result (it repopulates itself), so
        // there is no patch to report and nothing to close for.
        await onSubmit(prompt);
        addTurn({ role: 'assistant', content: 'Done — the form has been updated.', applied: true });
      } else {
        // Enforce the privacy prefs (Phase 5): only attach personal/contact
        // context when the user has allowed it.
        const { data } = await formAssistApi.fill({
          formType: formType || '',
          fields: fields || [],
          current: current || {},
          messages: toApiMessages(turns, prompt),
          includeContacts: includeContacts && prefs.aiUsePersonalInfo,
        });

        const patch = data.patch || {};
        const filled = Object.keys(patch).length > 0;
        const reply = data.reply || data.note
          || (filled ? 'Updated the form.' : "I couldn't fill anything from that — can you be more specific?");

        addTurn({ role: 'assistant', content: reply, patch: filled ? patch : undefined, applied: filled });

        if (filled) {
          onApply?.(patch);
          // Only a turn that actually changed the form gets out of the way. A
          // clarifying question needs the sheet to stay put so it can be
          // answered.
          closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, CLOSE_DELAY_MS);
        }
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Master switch (Phase 5): with AI disabled in Privacy settings neither the
  // pill nor the sheet exists — nothing is ever sent to the AI provider.
  if (!prefs.aiEnabled) return null;

  // A CAP, not a height: the sheet sizes to its content — title + composer on a
  // fresh conversation, growing with the transcript — and only stops here. A
  // fixed height left a block of dead space between the title and the composer
  // before anything was said.
  // Explicit px, not a percentage: `sheetRoot` is `flex:1 / flex-end`, and a
  // percentage resolves against the PADDED box, so `58%` would shrink to 58% of
  // the strip above the keyboard, exactly when the sheet needs its room.
  const sheetCap = Math.min(
    winH * RESTING_FRACTION,
    winH - insets.top - keyboardH - spacing.lg,
  );

  const canSend = !!input.trim() && !loading && !disabled;

  return (
    <>
      <Animated.View
        style={[styles.pillWrap, { bottom: insets.bottom + spacing.lg, opacity: pillOpacity }]}
        pointerEvents={keyboardH > 0 ? 'none' : 'auto'}
      >
        <AssistantButton label={label} attention={attention} onPress={() => setOpen(true)} />
      </Animated.View>

      <BottomSheet
        visible={open}
        onClose={close}
        title={label}
        avoidKeyboard
        // The px cap replaces modalSheet's `maxHeight: '80%'`, which resolves
        // against the PADDED box and would re-clamp it with the keyboard up.
        style={{ maxHeight: sheetCap }}
      >
        <CreditsBanner />

        {/* Sizes to its content and shrinks under the cap (flexGrow 0 /
            flexShrink 1) — the composer's placeholder already says what to
            type, so an empty conversation renders no transcript at all and the
            sheet is just title + composer. */}
        <ScrollView
          ref={scrollRef}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {turns.map((turn, i) => (
            <View
              key={i}
              style={[styles.row, turn.role === 'user' ? styles.rowRight : styles.rowLeft]}
            >
              <View
                style={[
                  styles.bubble,
                  turn.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                ]}
              >
                <Text style={turn.role === 'user' ? styles.bubbleUserText : styles.bubbleAssistantText}>
                  {turn.content}
                </Text>
              </View>
            </View>
          ))}

          {loading ? (
            <View style={[styles.row, styles.rowLeft]}>
              <View style={[styles.bubble, styles.bubbleAssistant, styles.thinking]}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.thinkingText}>Working…</Text>
              </View>
            </View>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        {/* The composer is the LAST child, so avoidKeyboard docks it flush on
            the keyboard and everything the model says stays above it. That
            inversion is why this is not the "a search field never lives in a
            bottom sheet" case: there, results render BELOW the field and end up
            behind the keys. */}
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={input}
            onChangeText={setInput}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            multiline
            editable={!disabled && !loading}
            // Focus on a fresh conversation (the user tapped the pill to type);
            // stay quiet when they reopened to re-read what was said.
            autoFocus={turns.length === 0}
          />
          <Pressable
            style={[
              styles.sendBtn,
              { backgroundColor: accent || colors.primary },
              !canSend && styles.sendBtnDisabled,
            ]}
            onPress={send}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={`Send to ${ASSISTANT_NAME}`}
          >
            <Ionicons name="arrow-up" size={20} color="#fff" />
          </Pressable>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  pillWrap: { position: 'absolute', right: spacing.lg, zIndex: 10 },
  // flexGrow 0: never stretch the sheet past the conversation. flexShrink 1:
  // give way under the sheet's maxHeight cap once the conversation outgrows it
  // (the composer, which must never shrink, keeps its default flexShrink 0).
  transcript: { flexGrow: 0, flexShrink: 1 },
  transcriptContent: { paddingBottom: spacing.sm },
  row: { flexDirection: 'row', marginBottom: spacing.sm },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '85%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleUserText: { color: '#fff', fontSize: 14, lineHeight: 21 },
  bubbleAssistantText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  thinkingText: { fontSize: 13, color: colors.textMuted },
  error: { color: colors.error, fontSize: 13, marginTop: spacing.xs },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingTop: spacing.sm },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    color: colors.text,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
});

export default forwardRef(FormAssistChat);
