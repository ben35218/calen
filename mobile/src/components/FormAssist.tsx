import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Input } from './ui';
import CreditsBanner from './CreditsBanner';
import CalenChatIcon from './CalenChatIcon';
import { formAssistApi, FormAssistField } from '../api';
import { usePrivacyPrefs } from '../lib/privacyPrefs';
import { ASSISTANT_NAME } from '../config';
import { colors, spacing, radius } from '../theme';

// A drop-in "describe it and let AI fill the form" panel for the top of an
// add/edit screen. The screen supplies its field schema + current values; on
// success we hand back the patch so the screen can apply it and highlight the
// changed fields. Starts as a compact one-row card; tapping it expands and
// focuses the prompt.
export default function FormAssist({
  formType,
  fields,
  current,
  onApply,
  disabled,
  includeContacts,
  title = `Ask ${ASSISTANT_NAME}`,
  placeholder = 'Describe what you want to add…',
}: {
  formType: string;
  fields: FormAssistField[];
  current: Record<string, unknown>;
  onApply: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
  includeContacts?: boolean;
  title?: string;
  placeholder?: string;
}) {
  const { prefs } = usePrivacyPrefs();
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const run = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError('');
    setNote('');
    try {
      // Enforce the privacy prefs (Phase 5): only attach personal/contact context
      // when the user has allowed it.
      const { data } = await formAssistApi.fill({
        formType, fields, current, prompt: prompt.trim(),
        includeContacts: includeContacts && prefs.aiUsePersonalInfo,
      });
      const patch = data.patch || {};
      if (Object.keys(patch).length === 0) {
        setError("Couldn't find anything to fill from that. Try being more specific.");
      } else {
        onApply(patch);
        if (data.note) setNote(data.note);
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
        onPress={!expanded ? () => setExpanded(true) : undefined}
      >
      <Pressable
        style={[styles.header, expanded && styles.headerOpen]}
        onPress={() => setExpanded((v) => !v)}
      >
        <CalenChatIcon size={18} color={colors.primary} cColor={colors.background} />
        <Text style={styles.title}>{title}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} style={styles.chevron} />
      </Pressable>
      {expanded ? (
        <>
          <Input
            value={prompt}
            onChangeText={setPrompt}
            placeholder={placeholder}
            multiline
            editable={!disabled && !loading}
            style={styles.input}
            autoFocus
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <Button
            title="Fill in the form"
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
  input: { minHeight: 68, textAlignVertical: 'top' },
  error: { color: colors.error, marginBottom: spacing.sm, fontSize: 13 },
  note: { color: colors.textMuted, marginBottom: spacing.sm, fontSize: 13 },
});
