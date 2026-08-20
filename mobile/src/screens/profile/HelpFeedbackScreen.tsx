import React, { useMemo, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { Text } from '../../components/Text';
import { useNavigation } from '@react-navigation/native';
import {
  Screen, Input, Button, SegmentedControl, SectionHeader, FormError, Hint, Card,
} from '../../components/ui';
import { feedbackApi } from '../../api';
import { useAuth } from '../../store/auth';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { collectDiagnostics, summarizeDiagnostics } from '../../lib/diagnostics';
import { colors, spacing } from '../../theme';

type FeedbackType = 'question' | 'bug' | 'idea';

const TYPE_OPTIONS: { label: string; value: FeedbackType }[] = [
  { label: 'Question', value: 'question' },
  { label: 'Bug', value: 'bug' },
  { label: 'Idea', value: 'idea' },
];

const PLACEHOLDER: Record<FeedbackType, string> = {
  question: 'Ask us anything about using the app…',
  bug: 'What happened? What did you expect instead?',
  idea: "What would you like to see? We read every one.",
};

// Profile → "Help & Feedback": one simple form to ask a question, report a bug,
// or suggest an idea. Diagnostics (app/device context) are captured
// automatically and shown before sending, so a report is actionable without a
// back-and-forth. Deliberately plaintext support content — nothing is sealed
// (spec: features/feedback.md).
export default function HelpFeedbackScreen() {
  const navigation = useNavigation();
  const { user } = useAuth();

  const [type, setType] = useState<FeedbackType>('question');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState(user?.email ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Captured once on mount — includes the route the user came from (the profile
  // hub) plus static device/app context.
  const diagnostics = useMemo(() => collectDiagnostics('HelpFeedback'), []);
  const diagSummary = summarizeDiagnostics(diagnostics);

  // Prompt before losing a typed message/type change on the way out (the email
  // defaults to the account email, so a change there alone still counts as an
  // edit worth guarding). Covers ✕, back, swipe, and hardware back.
  const isDirty = message.trim() !== '' || type !== 'question' || email !== (user?.email ?? '');
  const allowLeave = useUnsavedChangesGuard(navigation, isDirty);

  async function submit() {
    const text = message.trim();
    if (!text) {
      setError('Please enter a message.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await feedbackApi.submit({
        type,
        message: text,
        contactEmail: email.trim() || undefined,
        diagnostics,
      });
      Alert.alert('Thanks!', "We got your message and will take a look.", [
        { text: 'Done', onPress: () => { allowLeave(); navigation.goBack(); } },
      ]);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not send your message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <Hint>
        Ask a question, report a problem, or share an idea. This goes straight to
        our team.
      </Hint>

      <SectionHeader>Type</SectionHeader>
      <SegmentedControl value={type} options={TYPE_OPTIONS} onChange={setType} />

      <SectionHeader style={styles.spacer}>Message</SectionHeader>
      <Input
        value={message}
        onChangeText={setMessage}
        placeholder={PLACEHOLDER[type]}
        multiline
        style={styles.messageInput}
        textAlignVertical="top"
      />

      <SectionHeader style={styles.spacer}>Reply-to email (optional)</SectionHeader>
      <Input
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Hint>Only used if we need to follow up. Leave it blank to stay anonymous.</Hint>

      {diagSummary ? (
        <Card style={styles.diagCard}>
          <Text style={styles.diagLabel}>Attached automatically</Text>
          <Text style={styles.diagValue}>{diagSummary}</Text>
          <Text style={styles.diagNote}>
            Helps us reproduce issues. No calendar, contact, or account data is included.
          </Text>
        </Card>
      ) : null}

      <FormError>{error}</FormError>

      <Button
        title="Send"
        variant="primary"
        onPress={submit}
        loading={submitting}
        disabled={!message.trim() || submitting}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  spacer: { marginTop: spacing.lg },
  messageInput: { minHeight: 120, paddingTop: spacing.sm },
  diagCard: { marginTop: spacing.lg },
  diagLabel: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  diagValue: { fontSize: 14, color: colors.text },
  diagNote: { fontSize: 12, color: colors.textMuted, marginTop: 6, lineHeight: 16 },
});
