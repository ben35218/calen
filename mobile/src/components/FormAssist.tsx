import React, { useRef, useState } from 'react';
import { StyleSheet, Pressable } from 'react-native';
import { Text } from './Text';
import { Ionicons } from '@expo/vector-icons';
import { Button, Input } from './ui';
import CreditsBanner from './CreditsBanner';
import CalenGlyph from './CalenGlyph';
import { formAssistApi, FormAssistField } from '../api';
import { usePrivacyPrefs } from '../lib/privacyPrefs';
import { ASSISTANT_NAME } from '../config';
import { colors, spacing, radius } from '../theme';

// The "Ask Calen" panel at the top of an add/edit screen — the ONE way an AI
// assistant appears inside a form. Two modes share the same card chrome:
//
//  - Fill (default): the screen supplies its field schema + current values; on
//    success we hand back the patch so the screen can apply it and highlight
//    the changed fields.
//  - Custom submit (`onSubmit`): the screen runs its own AI action on the
//    prompt (the recipe form's whole-recipe /edit-with-ai rewrite); the card
//    still owns the loading/error presentation.
//
// Collapsed by default — the form is the screen's primary job. Pass
// `defaultExpanded` only when the user arrives from a flow whose expected next
// step IS the assistant (a just-completed recipe import); a default-expanded
// card never pops the keyboard, while a tap-to-expand focuses the prompt.
export default function FormAssist({
  formType,
  fields,
  current,
  onApply,
  onSubmit,
  disabled,
  includeContacts,
  accent,
  title = `Ask ${ASSISTANT_NAME}`,
  placeholder = 'Describe what you want to add…',
  restingPlaceholder = 'Describe what you want to add…',
  actionLabel = 'Fill in the form',
  defaultExpanded = false,
}: {
  formType?: string;
  fields?: FormAssistField[];
  current?: Record<string, unknown>;
  onApply?: (patch: Record<string, unknown>) => void;
  // Replaces the /form-assist fill call: run the screen's own AI action on the
  // prompt (throw to surface the error in-card). The prompt clears on success.
  onSubmit?: (prompt: string) => Promise<void>;
  disabled?: boolean;
  includeContacts?: boolean;
  // Section accent for the action button in an accented feature area; the card
  // chrome itself stays app-primary — it is Calen's, not the section's.
  accent?: string;
  title?: string;
  placeholder?: string;
  // Shown while the input rests at one line (unfocused + empty); the full
  // example-rich `placeholder` would clip there.
  restingPlaceholder?: string;
  actionLabel?: string;
  defaultExpanded?: boolean;
}) {
  const { prefs } = usePrivacyPrefs();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const openedByTap = useRef(false);
  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const toggle = () => {
    openedByTap.current = !expanded;
    setExpanded((v) => !v);
  };

  const run = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError('');
    setNote('');
    try {
      if (onSubmit) {
        await onSubmit(prompt.trim());
        setPrompt('');
      } else {
        // Enforce the privacy prefs (Phase 5): only attach personal/contact
        // context when the user has allowed it.
        const { data } = await formAssistApi.fill({
          formType: formType || '', fields: fields || [], current: current || {},
          prompt: prompt.trim(),
          includeContacts: includeContacts && prefs.aiUsePersonalInfo,
        });
        const patch = data.patch || {};
        if (Object.keys(patch).length === 0) {
          setError("Couldn't find anything to fill from that. Try being more specific.");
        } else {
          onApply?.(patch);
          if (data.note) setNote(data.note);
        }
      }
    } catch (e: any) {
      setError(e.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Master switch (Phase 5): with AI disabled in Privacy settings, the panel
  // doesn't appear at all — nothing is ever sent to the AI provider.
  if (!prefs.aiEnabled) return null;

  return (
    <>
      <CreditsBanner />
      <Pressable
        style={styles.card}
        onPress={!expanded ? toggle : undefined}
      >
      <Pressable
        style={[styles.header, expanded && styles.headerOpen]}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
      >
        <CalenGlyph size={20} />
        <Text style={styles.title}>{title}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} style={styles.chevron} />
      </Pressable>
      {expanded ? (
        <>
          <Input
            value={prompt}
            onChangeText={setPrompt}
            placeholder={focused || prompt ? placeholder : restingPlaceholder}
            multiline
            editable={!disabled && !loading}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[styles.input, (focused || !!prompt) && styles.inputGrown]}
            autoFocus={openedByTap.current}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <Button
            title={actionLabel}
            color={accent}
            onPress={run}
            loading={loading}
            disabled={disabled || !prompt.trim()}
          />
        </>
      ) : null}
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.primary + '14',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primary + '55',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerOpen: { marginBottom: spacing.sm },
  chevron: { marginLeft: 'auto' },
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  input: { textAlignVertical: 'top' },
  // Grown while focused or holding text — a resting card shows a one-line field.
  inputGrown: { minHeight: 68 },
  error: { color: colors.error, marginBottom: spacing.sm, fontSize: 13 },
  note: { color: colors.textMuted, marginBottom: spacing.sm, fontSize: 13 },
});
