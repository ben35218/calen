import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Image,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native';
import { moderationApi } from '../../api';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, radius, spacing } from '../../theme';
import { navTargetForView } from './navDestinations';
import { flattenMarkdown } from '../../lib/markdown';
import { formatCompact } from '../../lib/format';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { takePhoto, pickImage, pickDocument } from '../../lib/media';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { BottomSheet } from '../../components/ui';
import QuotaBlockedNotice from '../../components/QuotaBlockedNotice';
import AssistantSwitcher from '../../components/AssistantSwitcher';
import { useDictation } from '../../hooks/useDictation';
import { ASSISTANT_TABS, AssistantId } from './assistantTabs';
import type { ChatController, ChatAttachment } from '../../hooks/useChat';

// The kinds of actionable follow-up, each with a leading glyph that signals what
// tapping does: commit now, review AI-drafted content, open another screen, or
// have Calen place a phone call.
export type FollowupKind = 'add' | 'review' | 'navigate' | 'call';
const FOLLOWUP_ICONS: Record<FollowupKind, keyof typeof Ionicons.glyphMap> = {
  add: 'checkmark-circle-outline',
  review: 'eye-outline',
  navigate: 'arrow-forward-outline',
  call: 'call-outline',
};

// Reusable assistant chat UI. Ports client/src/components/ChatPanel.vue. Each
// assistant (calendar / maintenance / trips) supplies a `chat` controller
// from useChat plus its empty-state copy; the nav header owns the title and the
// Clear action.
export default function ChatScreen({
  chat,
  activeAssistant,
  emptyHint,
  placeholder = 'Type a message…',
  disabled = false,
  banner,
  footer,
  onFollowupPress,
  followupKind,
  navContext,
  onSelectAssistant,
  surface = 'assistant',
}: {
  chat: ChatController;
  // When set, renders the assistant switcher row (icons for each assistant, this
  // one selected) above the context card. Omit on context-scoped surfaces (an
  // item's maintenance chat, a trip's assistant) to keep their focused UI.
  activeAssistant?: AssistantId;
  // Swap the active chat assistant in place (unified AssistantScreen container).
  // When provided, tapping a chat tab calls this instead of navigating to a
  // separate route, so Calendar/Chores/Task Plan share one view + "Calen" header.
  onSelectAssistant?: (id: AssistantId) => void;
  emptyHint?: string;
  placeholder?: string;
  disabled?: boolean;
  banner?: React.ReactNode;
  // Pinned content above the input bar (e.g. a "Review & add" action).
  footer?: React.ReactNode;
  // Which assistant this is, tagged on any content report (Apple 1.2).
  surface?: string;
  // Intercept a follow-up chip tap. Return true if handled (e.g. a client-side
  // action like saving an event); otherwise the chip text is sent to the chat.
  onFollowupPress?: (text: string) => boolean;
  // Tag an actionable follow-up chip with a leading icon so it reads as a button,
  // not just a suggested reply. 'add' commits without review (checkmark), 'review'
  // opens AI-drafted content to review (eye), 'navigate' opens a page (arrow).
  // Return undefined for plain suggested replies (no icon).
  followupKind?: (text: string) => FollowupKind | undefined;
  // Client-only context for resolving the assistant's navigation suggestions
  // (e.g. the current trip id, needed to open a specific trip / booking form).
  navContext?: { tripId?: string };
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const insets = useSafeAreaInsets();

  // Composer dictation (Level 1): live transcript flows straight into the input
  // so the user can review/edit before sending down the normal chat pipeline.
  const dictation = useDictation({
    onText: chat.setInput,
    onError: (m) => Alert.alert('Voice input', m),
  });
  const aiEnabled = usePrivacyPrefs().prefs.aiEnabled;
  const areaColors = useCalendarColors().colors;
  const navigation = useNavigation();
  const scrollToEnd = () => scrollRef.current?.scrollToEnd({ animated: true });

  // A tapped navigation suggestion opens the mapped screen (arrow chips). Unknown
  // or context-missing views (e.g. a trip view with no trip) are simply inert.
  const openNavSuggestion = (view: string) => {
    const target = navTargetForView(view, navContext ?? {});
    if (target) (navigation as unknown as { navigate: (r: string, p?: object) => void }).navigate(target.route, target.params);
  };

  // Auto-scroll only when the conversation itself grows (new message or streaming
  // chunk) — not on every content-size change, so expanding the "What I can see &
  // do" card to read it doesn't yank the view to the bottom.
  useEffect(() => {
    scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages.length, chat.streamingText]);

  // Tint the input-bar buttons with the selected assistant's default area colour
  // (Calendar has no per-calendar colour, so it falls back to the app accent).
  const activeTab = ASSISTANT_TABS.find((t) => t.id === activeAssistant);
  const activeAccent =
    activeTab && activeTab.accentKey !== 'primary' ? areaColors[activeTab.accentKey] : colors.primary;

  const empty = chat.messages.length === 0 && !chat.streamingText;

  // Report objectionable AI output (Apple 1.2). Long-press any assistant reply.
  function reportMessage(content: string) {
    Alert.alert(
      'Report this message?',
      'This sends the message to our team to review. Thanks for helping keep the assistant safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: () => {
            moderationApi
              .report({ content, surface })
              .then(() => Alert.alert('Reported', 'Thanks — we’ll review this message.'))
              .catch(() => Alert.alert('Couldn’t send report', 'Please try again.'));
          },
        },
      ],
    );
  }

  // Pick an attachment via the +-menu and stage it for the next message. The
  // picker (camera / photo library / files) returns null on cancel or a denied
  // permission, in which case nothing is staged.
  async function pickAttachment(source: 'camera' | 'photos' | 'files') {
    setPickerOpen(false);
    const file =
      source === 'camera' ? await takePhoto() : source === 'photos' ? await pickImage() : await pickDocument();
    if (file) chat.addAttachment(file);
  }

  const canSend = (!!chat.input.trim() || chat.attachments.length > 0) && !disabled && !chat.loading;

  // Master switch (Phase 5): with AI off in Privacy settings the assistant is
  // unusable and nothing is ever sent to the provider — same guarantee FormAssist
  // gives. Mirrors the "panel doesn't render" behavior for a full-screen surface.
  if (!aiEnabled) {
    return (
      <View style={styles.disabledWrap}>
        <MaterialCommunityIcons name="robot-off-outline" size={48} color={colors.textMuted} />
        <Text style={styles.disabledTitle}>AI features are turned off</Text>
        <Text style={styles.disabledText}>
          Turn on “AI features” in Profile → Privacy to use the assistant.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 92 : 0}
    >
      {/* Assistant switcher: one icon per assistant, this one selected. */}
      {activeAssistant ? (
        <AssistantSwitcher active={activeAssistant} onSelectAssistant={onSelectAssistant} />
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {banner}

        {/* "What I can see & do" disclosure */}
        {chat.context ? (
          <View style={[styles.contextCard, { backgroundColor: activeAccent + '0D' }]}>
            <TouchableOpacity style={styles.contextHeader} onPress={() => setContextOpen((o) => !o)}>
              <Ionicons name="information-circle-outline" size={18} color={activeAccent} />
              <Text style={styles.contextTitle}>What I can see &amp; do</Text>
              <Ionicons
                name={contextOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textMuted}
              />
            </TouchableOpacity>
            {contextOpen ? (
              <View style={styles.contextBody}>
                {chat.context.sees?.length ? (
                  <>
                    <Text style={styles.contextLabel}>I can see</Text>
                    {chat.context.sees.map((s, i) => (
                      <Text key={`s${i}`} style={styles.contextLine}>
                        • {s}
                      </Text>
                    ))}
                  </>
                ) : null}
                {chat.context.can?.length ? (
                  <>
                    <Text style={styles.contextLabel}>I can do</Text>
                    {chat.context.can.map((c, i) => (
                      <Text key={`c${i}`} style={styles.contextLine}>
                        • {c}
                      </Text>
                    ))}
                  </>
                ) : null}
                {chat.context.note ? <Text style={styles.contextNote}>{chat.context.note}</Text> : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Empty state + suggested prompts (no avatar/greeting — the switcher
            above identifies the assistant). */}
        {empty ? (
          <View style={styles.emptyWrap}>
            {chat.suggestedPrompts.length ? (
              <View style={styles.suggestions}>
                <Text style={styles.suggestLabel}>Try asking…</Text>
                {chat.suggestedPrompts.map((p, i) => (
                  <TouchableOpacity
                    key={i}
                    style={styles.suggestChip}
                    onPress={() => chat.send(p)}
                    disabled={disabled}
                  >
                    <Text style={styles.suggestChipText}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : emptyHint ? (
              <Text style={styles.emptyHint}>{emptyHint}</Text>
            ) : null}
          </View>
        ) : null}

        {/* Conversation */}
        {chat.messages.map((msg, i) => (
          <View key={i}>
            <View style={[styles.row, msg.role === 'user' ? styles.rowRight : styles.rowLeft]}>
              {msg.role === 'user' ? (
                <View style={[styles.bubble, styles.bubbleUser]}>
                  {msg.attachments?.length ? (
                    <View style={styles.sentAttachments}>
                      {msg.attachments.map((a, ai) => (
                        <SentAttachment key={ai} attachment={a} />
                      ))}
                    </View>
                  ) : null}
                  {msg.content ? <Text style={styles.bubbleUserText}>{msg.content}</Text> : null}
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.bubble, styles.bubbleAssistant]}
                  activeOpacity={0.8}
                  onLongPress={() => reportMessage(msg.content)}
                  delayLongPress={400}
                  accessibilityHint="Long-press to report this message"
                >
                  <Text style={styles.bubbleAssistantText}>{flattenMarkdown(msg.content)}</Text>
                </TouchableOpacity>
              )}
            </View>
            {msg.role === 'assistant' && msg.tokens ? (
              <Text style={styles.tokenMeta}>{formatCompact(msg.tokens)} tokens</Text>
            ) : null}
          </View>
        ))}

        {/* Streaming reply */}
        {chat.streamingText ? (
          <View style={[styles.row, styles.rowLeft]}>
            <View style={[styles.bubble, styles.bubbleAssistant]}>
              <Text style={styles.bubbleAssistantText}>{flattenMarkdown(chat.streamingText)}</Text>
            </View>
          </View>
        ) : null}

        {/* Thinking / tool activity */}
        {chat.loading && !chat.streamingText ? (
          <View style={[styles.row, styles.rowLeft]}>
            <View style={[styles.bubble, styles.bubbleAssistant, styles.thinking]}>
              <ActivityIndicator size="small" color={colors.primary} />
              {chat.toolActivity ? <Text style={styles.thinkingText}>{chat.toolActivity}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* Follow-up suggestions */}
        {chat.followups.length && !chat.loading ? (
          <View style={styles.followups}>
            {chat.followups.map((f, i) => {
              const kind = followupKind?.(f);
              return (
                <TouchableOpacity
                  key={i}
                  style={styles.followupChip}
                  onPress={() => {
                    if (!onFollowupPress?.(f)) chat.send(f);
                  }}
                  disabled={disabled}
                >
                  {kind ? (
                    <Ionicons name={FOLLOWUP_ICONS[kind]} size={15} color={colors.primary} style={styles.followupIcon} />
                  ) : null}
                  <Text style={styles.followupChipText}>{f}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        {/* Navigation suggestions — the assistant offered to open a relevant
            screen. Rendered as "navigate" chips (arrow) that open it on tap. */}
        {chat.navSuggestions.length && !chat.loading ? (
          <View style={styles.followups}>
            {chat.navSuggestions.map((n, i) => (
              <TouchableOpacity
                key={`nav${i}`}
                style={styles.followupChip}
                onPress={() => openNavSuggestion(n.view)}
                disabled={disabled}
              >
                <Ionicons name={FOLLOWUP_ICONS.navigate} size={15} color={colors.primary} style={styles.followupIcon} />
                <Text style={styles.followupChipText}>{n.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Error + retry. Out of credits, retrying is futile — offer the
            buy-credits path instead. */}
        {chat.error ? (
          chat.quotaExceeded ? (
            <QuotaBlockedNotice message={chat.error} />
          ) : (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{chat.error}</Text>
              <TouchableOpacity onPress={() => chat.retry()}>
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )
        ) : null}
      </ScrollView>

      {footer}

      {/* Staged attachments (removable before send) */}
      {chat.attachments.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.stagedStrip}
          contentContainerStyle={styles.stagedStripContent}
          keyboardShouldPersistTaps="handled"
        >
          {chat.attachments.map((file, i) => (
            <View key={i} style={styles.stagedItem}>
              {file.type.startsWith('image/') ? (
                <Image source={{ uri: file.uri }} style={styles.stagedThumb} />
              ) : (
                <View style={[styles.stagedThumb, styles.stagedFile]}>
                  <Ionicons name="document-text-outline" size={22} color={colors.textMuted} />
                  <Text style={styles.stagedFileName} numberOfLines={1}>
                    {file.name}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.stagedRemove}
                onPress={() => chat.removeAttachment(i)}
                accessibilityLabel={`Remove ${file.name}`}
                hitSlop={8}
              >
                <Ionicons name="close-circle" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Input */}
      <View style={[styles.inputBar, { paddingBottom: spacing.sm + insets.bottom }]}>
        <TouchableOpacity
          style={[styles.attachBtn, (disabled || chat.loading) && styles.sendBtnDisabled]}
          onPress={() => setPickerOpen(true)}
          disabled={disabled || chat.loading}
          accessibilityLabel="Add attachment"
        >
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
        <TextInput
          style={styles.textInput}
          value={chat.input}
          onChangeText={chat.setInput}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!disabled}
        />
        {/* Dictation mic: tap to talk, transcript lands in the field to edit. */}
        <TouchableOpacity
          style={[
            styles.micBtn,
            dictation.state === 'listening'
              ? { backgroundColor: activeAccent }
              : { backgroundColor: activeAccent + '1A' },
            (disabled || chat.loading) && styles.sendBtnDisabled,
          ]}
          onPress={() => (dictation.state === 'listening' ? dictation.stop() : dictation.start())}
          disabled={disabled || chat.loading}
          accessibilityLabel={dictation.state === 'listening' ? 'Stop dictation' : 'Dictate a message'}
        >
          <Ionicons
            name={dictation.state === 'listening' ? 'stop' : 'mic'}
            size={20}
            color={dictation.state === 'listening' ? '#fff' : activeAccent}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sendBtn, { backgroundColor: activeAccent }, !canSend && styles.sendBtnDisabled]}
          onPress={() => chat.send()}
          disabled={!canSend}
          accessibilityLabel="Send message"
        >
          {chat.loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="arrow-up" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      {/* Attachment source picker */}
      <BottomSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} title="Add attachment">
        <TouchableOpacity style={styles.pickerRow} onPress={() => pickAttachment('camera')}>
          <Ionicons name="camera-outline" size={22} color={colors.text} />
          <Text style={styles.pickerLabel}>Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.pickerRow} onPress={() => pickAttachment('photos')}>
          <Ionicons name="image-outline" size={22} color={colors.text} />
          <Text style={styles.pickerLabel}>Photos</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.pickerRow} onPress={() => pickAttachment('files')}>
          <Ionicons name="document-outline" size={22} color={colors.text} />
          <Text style={styles.pickerLabel}>Files</Text>
        </TouchableOpacity>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

// One attachment as shown inside a sent user bubble: an image thumbnail, or a
// labeled file chip for PDFs / other documents.
function SentAttachment({ attachment }: { attachment: ChatAttachment }) {
  if (attachment.type.startsWith('image/') && attachment.uri) {
    return <Image source={{ uri: attachment.uri }} style={styles.sentThumb} />;
  }
  return (
    <View style={styles.sentFile}>
      <Ionicons name="document-text-outline" size={18} color="#fff" />
      <Text style={styles.sentFileName} numberOfLines={1}>
        {attachment.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  disabledWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm, backgroundColor: colors.background },
  disabledTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: spacing.sm },
  disabledText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.lg },
  contextCard: {
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  contextHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  contextTitle: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '600' },
  contextBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  contextLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4 },
  contextLine: { fontSize: 13, color: colors.text, marginBottom: 3 },
  contextNote: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm },
  emptyWrap: { alignItems: 'center', paddingTop: spacing.lg, paddingHorizontal: spacing.md },
  emptyHint: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  suggestions: { alignItems: 'center', marginTop: spacing.lg, gap: spacing.sm, alignSelf: 'stretch' },
  suggestLabel: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  suggestChip: {
    backgroundColor: colors.primary + '1A',
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  suggestChipText: { color: colors.primary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  row: { flexDirection: 'row', marginBottom: spacing.sm },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '85%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleAssistant: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  bubbleUserText: { color: '#fff', fontSize: 14, lineHeight: 21 },
  bubbleAssistantText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  tokenMeta: { fontSize: 11, color: colors.textMuted, marginTop: -2, marginBottom: spacing.sm, marginLeft: 4 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  thinkingText: { fontSize: 13, color: colors.textMuted },
  followups: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  followupChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  followupIcon: { marginRight: 5 },
  followupChipText: { color: colors.primary, fontSize: 13, fontWeight: '500' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.error + '1A',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  errorText: { flex: 1, color: colors.error, fontSize: 13 },
  retryText: { color: colors.error, fontWeight: '700', fontSize: 13, paddingLeft: spacing.sm },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  textInput: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  attachBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.5 },
  // Staged (not-yet-sent) attachment strip above the input bar.
  stagedStrip: {
    maxHeight: 96,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  stagedStripContent: { padding: spacing.sm, gap: spacing.sm },
  stagedItem: { width: 72, height: 72 },
  stagedThumb: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  stagedFile: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stagedFileName: { fontSize: 9, color: colors.textMuted, marginTop: 2, textAlign: 'center' },
  stagedRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: colors.surface,
    borderRadius: 10,
  },
  // Attachments as rendered inside a sent user bubble.
  sentAttachments: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: 6 },
  sentThumb: { width: 120, height: 120, borderRadius: radius.sm, backgroundColor: colors.background },
  sentFile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 200,
    backgroundColor: '#ffffff22',
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  sentFileName: { color: '#fff', fontSize: 13, flexShrink: 1 },
  // +-menu rows.
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 14 },
  pickerLabel: { fontSize: 16, color: colors.text },
});
