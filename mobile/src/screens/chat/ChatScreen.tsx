import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Image,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { moderationApi } from '../../api';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, radius, spacing } from '../../theme';
import { navTargetForView } from './navDestinations';
import { parseChatLinks, searchUrl, openPlaceInGoogleMaps } from '../../lib/chatLinks';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { takePhoto, pickImage, pickDocument } from '../../lib/media';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { BottomSheet } from '../../components/ui';
import QuotaBlockedNotice from '../../components/QuotaBlockedNotice';
import AssistantSwitcher from '../../components/AssistantSwitcher';
import { StoredChatWithSurface, filterChats, relativeChatTime, requestResume } from '../../lib/chatHistory';
import { spliceDictation, useDictation } from '../../hooks/useDictation';
import { useScrollAwareKeyboard } from '../../hooks/useScrollAwareKeyboard';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { ASSISTANT_TABS, AssistantId } from './assistantTabs';
import type { ChatController, ChatAttachment, ChatMessage } from '../../hooks/useChat';

// The kinds of actionable follow-up, each with a leading glyph that signals what
// tapping does: commit now, review AI-drafted content, open another screen, go
// set up a missing value, or have Calen place a phone call.
export type FollowupKind = 'add' | 'review' | 'navigate' | 'setup' | 'call';
const FOLLOWUP_ICONS: Record<FollowupKind, keyof typeof Ionicons.glyphMap> = {
  add: 'checkmark-circle-outline',
  review: 'eye-outline',
  navigate: 'arrow-forward-outline',
  setup: 'settings-outline',
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
  onResumeExternal,
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
  // Intercept a follow-up chip tap. Receives the chip text plus the assistant
  // message it belongs to and that message's index (so the handler can read the
  // turn's own drafted record and, for a one-shot create, mark the chip used via
  // `chat.markActionUsed(index, text)`). Return true if handled (a client-side
  // action); otherwise the chip text is sent to the chat as a new message.
  onFollowupPress?: (text: string, msg: ChatMessage, index: number) => boolean;
  // Tag an actionable follow-up chip with a leading icon so it reads as a button,
  // not just a suggested reply. 'add' commits without review (checkmark), 'review'
  // opens AI-drafted content to review (eye), 'navigate' opens a page (arrow).
  // Return undefined for plain suggested replies (no icon).
  followupKind?: (text: string) => FollowupKind | undefined;
  // Client-only context for resolving the assistant's navigation suggestions
  // (e.g. the current trip id, or the focused event id — needed to open a
  // specific trip / booking form, or deep-link "add business phone").
  navContext?: { tripId?: string; eventId?: string };
  // Resume a Recent-chats row that belongs to a DIFFERENT assistant than this
  // one. The unified AssistantScreen passes this to switch tab (and pick the
  // trip) then resume there. Omitted on standalone surfaces (a trip's own
  // assistant) — the sheet then hands off via navigation to the Assistant view.
  onResumeExternal?: (surfaceKey: string, chatId: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Recent-chats search keyword (filters the sheet by title + message text).
  const [historyQuery, setHistoryQuery] = useState('');
  // Reset the keyword each time the sheet closes so it opens fresh next time.
  useEffect(() => {
    if (!chat.historyOpen) setHistoryQuery('');
  }, [chat.historyOpen]);
  const insets = useSafeAreaInsets();

  // Composer dictation (Level 1): the live transcript is spliced in at the
  // cursor position captured when the mic was pressed — it augments what's
  // already typed rather than replacing it — and the user can review/edit
  // before sending down the normal chat pipeline.
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  // Whether the composer is actually focused. A programmatic setInput (e.g. the
  // last dictation's transcript) can leave the caret reported at 0 on an
  // unfocused field, so we only trust the caret snapshot when it's really
  // focused — otherwise new speech would splice in at the START of the message.
  const inputFocusedRef = useRef(false);
  const dictationBaseRef = useRef({ before: '', after: '' });
  const dictation = useDictation({
    onText: (t) => {
      const { before, after } = dictationBaseRef.current;
      chat.setInput(spliceDictation(before, after, t));
    },
    onError: (m) => Alert.alert('Voice input', m),
  });
  const startDictation = () => {
    // Insert at the caret only when the field is genuinely focused; otherwise
    // append at the end. The common flow — speak, pause, tap the mic again to
    // keep going without ever tapping into the field — leaves it unfocused, and
    // a stale/zeroed caret would otherwise prepend the new speech at the start.
    const len = chat.input.length;
    const sel = (inputFocusedRef.current ? selectionRef.current : null) ?? { start: len, end: len };
    // Clamp: the field may have been cleared by a send since the last selection.
    const start = Math.min(sel.start, len);
    const end = Math.min(Math.max(sel.end, start), len);
    dictationBaseRef.current = { before: chat.input.slice(0, start), after: chat.input.slice(end) };
    dictation.start();
  };
  const aiEnabled = usePrivacyPrefs().prefs.aiEnabled;
  const areaColors = useCalendarColors().colors;
  const navigation = useNavigation();
  const scrollToEnd = () => scrollRef.current?.scrollToEnd({ animated: true });

  // Scroll-aware keyboard: scrolling up to read history tucks the keyboard
  // away; a deliberate pull past the bottom (overscroll) summons it back.
  const scrollKeyboard = useScrollAwareKeyboard(inputRef, scrollToEnd);

  // Stick-to-bottom: a streaming reply follows the newest text only while you're
  // parked at the bottom. Scroll up to read and the view freezes (the jump-to-
  // latest button appears); return to the bottom to re-engage following.
  const stick = useStickToBottom(scrollToEnd);

  // Compose both scroll consumers onto the one ScrollView — the keyboard state
  // machine and the stick-to-bottom tracker each need the same gesture events.
  const scrollHandlers = {
    ...scrollKeyboard,
    onScrollBeginDrag: () => {
      scrollKeyboard.onScrollBeginDrag();
      stick.onScrollBeginDrag();
    },
    onScroll: (e: Parameters<typeof stick.onScroll>[0]) => {
      scrollKeyboard.onScroll(e);
      stick.onScroll(e);
    },
    onScrollEndDrag: (e: Parameters<typeof stick.onScrollEndDrag>[0]) => {
      scrollKeyboard.onScrollEndDrag(e);
      stick.onScrollEndDrag(e);
    },
    onMomentumScrollEnd: (e: Parameters<typeof stick.onMomentumScrollEnd>[0]) => {
      scrollKeyboard.onMomentumScrollEnd(e);
      stick.onMomentumScrollEnd(e);
    },
  };

  // A tapped navigation suggestion opens the mapped screen (arrow chips). Unknown
  // or context-missing views (e.g. a trip view with no trip) are simply inert.
  const openNavSuggestion = (view: string) => {
    const target = navTargetForView(view, navContext ?? {});
    if (!target) return;
    const nav = navigation as unknown as {
      navigate: (r: string, p?: object) => void;
      push: (r: string, p?: object) => void;
    };
    // CalendarHome is the app root and headerless, and it already sits below the
    // assistant on the stack — a plain navigate() would POP the assistant off
    // (stranding the live chat with no back button). Push a fresh instance on
    // top instead, flagged so it shows a "‹ Calen" return pill; swipe-back or
    // the pill drop straight back into the conversation. Other nav targets carry
    // their own header back button, so a normal navigate() is right for them.
    if (target.route === 'CalendarHome') {
      nav.push('CalendarHome', { fromAssistant: true });
      return;
    }
    nav.navigate(target.route, target.params);
  };

  // A tapped place link opens the native Google Maps app when it's installed;
  // otherwise it falls back to the full-screen in-app Google place preview
  // (modal WebView) — closing that drops back into the conversation. A tapped
  // search suggestion launches the query in the default browser.
  const openPlace = (text: string, query: string) => {
    void openPlaceInGoogleMaps(query).then((opened) => {
      if (!opened)
        (navigation as unknown as { navigate: (r: string, p?: object) => void }).navigate('PlacePreview', {
          query,
          title: text,
        });
    });
  };
  const openSearch = (_text: string, query: string) => Linking.openURL(searchUrl(query)).catch(() => {});

  // Resume a Recent-chats row. Its own tab loads in place; a chat from another
  // assistant hands off — to the unified AssistantScreen via onResumeExternal
  // when embedded, else by navigating into the Assistant view (which claims the
  // parked request on mount). Either way the target surface owns the reload.
  const resumeChatRow = (c: StoredChatWithSurface) => {
    if (c.surfaceKey === chat.historyKey) {
      chat.resumeChat(c.id);
      return;
    }
    chat.closeHistory();
    if (onResumeExternal) {
      onResumeExternal(c.surfaceKey, c.id);
      return;
    }
    requestResume(c.surfaceKey, c.id);
    (navigation as unknown as { navigate: (r: string, p?: object) => void }).navigate('Assistant', {
      initial: c.tab,
    });
  };

  // Auto-scroll only when the conversation itself grows (new message or streaming
  // chunk) — not on every content-size change, so expanding the "What I can see &
  // do" card to read it doesn't yank the view to the bottom.
  useEffect(() => {
    const last = chat.messages[chat.messages.length - 1];
    // A fresh user turn always snaps to the bottom and re-engages following —
    // you just sent it, you want to see it (and the reply landing under it).
    if (last?.role === 'user') {
      stick.pinToBottom();
      return;
    }
    // Streaming chunks and the assistant reply committing only pull the view down
    // while you're already parked at the bottom. Scrolled up to read? Stay put.
    if (stick.pinnedRef.current) scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages.length, chat.streamingText]);

  // Tint the input-bar buttons with the selected assistant's default area colour
  // (Calendar has no per-calendar colour, so it falls back to the app accent).
  const activeTab = ASSISTANT_TABS.find((t) => t.id === activeAssistant);
  const activeAccent =
    activeTab && activeTab.accentKey !== 'primary' ? areaColors[activeTab.accentKey] : colors.primary;

  const empty = chat.messages.length === 0 && !chat.streamingText;

  // Recent-chats sheet: the keyword-filtered rows (title + message text match).
  const filteredHistory = filterChats(chat.recentChats, historyQuery);
  // Size the scrollable chat list to the screen so the sheet shows a generous
  // number of rows (not full-screen — the sheet caps at 92%). The second term
  // leaves room for the title + search pill + padding so nothing clips on short
  // devices; the taller of a fixed floor and ~72% of the screen wins.
  const { height: windowHeight } = useWindowDimensions();
  const historyListHeight = Math.min(
    Math.max(480, Math.round(windowHeight * 0.72)),
    Math.round(windowHeight * 0.92) - 150
  );

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

      <View style={styles.listWrap}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        {...scrollHandlers}
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
        {chat.messages.map((msg, i) => {
          // Resend affordance: when the last turn was a user message that never
          // got a reply — the turn errored out, or the user stopped it before any
          // text streamed — offer a resend icon to the left of that bubble. A
          // delivered turn always appends an assistant message (so the user bubble
          // is no longer last), and an out-of-credits turn can't be retried, so
          // neither shows it. Tapping re-runs the same conversation (`chat.retry`).
          const canResend =
            msg.role === 'user' &&
            i === chat.messages.length - 1 &&
            !chat.loading &&
            !chat.streamingText &&
            !chat.quotaExceeded;
          return (
          <View key={i}>
            <View style={[styles.row, msg.role === 'user' ? styles.rowRight : styles.rowLeft]}>
              {msg.role === 'user' ? (
                <>
                {canResend ? (
                  <TouchableOpacity
                    style={styles.resendBtn}
                    onPress={() => chat.retry()}
                    accessibilityLabel="Resend message"
                    hitSlop={8}
                  >
                    <Ionicons name="refresh" size={18} color={colors.error} />
                  </TouchableOpacity>
                ) : null}
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
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.bubble, styles.bubbleAssistant]}
                  activeOpacity={0.8}
                  onLongPress={() => reportMessage(msg.content)}
                  delayLongPress={400}
                  accessibilityHint="Long-press to report this message"
                >
                  <AssistantText content={msg.content} onPlace={openPlace} onSearch={openSearch} />
                </TouchableOpacity>
              )}
            </View>
            {msg.role === 'assistant' && msg.credits ? (
              <Text style={styles.tokenMeta}>
                {msg.credits} {msg.credits === 1 ? 'credit' : 'credits'}
              </Text>
            ) : null}
            {/* This turn's chips, inline under its bubble and kept in scrollback:
                action/suggestion chips + nav suggestions. Every past turn keeps
                its own, all still tappable. A one-shot create chip already used
                (usedActions) stays visible but disabled so it can't duplicate. */}
            {msg.role === 'assistant' && (msg.followups?.length || msg.navSuggestions?.length) ? (
              <View style={styles.followups}>
                {msg.followups?.map((f, fi) => {
                  const kind = followupKind?.(f);
                  const used = msg.usedActions?.includes(f);
                  return (
                    <TouchableOpacity
                      key={`f${fi}`}
                      style={[styles.followupChip, used && styles.followupChipUsed]}
                      onPress={() => {
                        if (!onFollowupPress?.(f, msg, i)) chat.send(f);
                      }}
                      disabled={disabled || used}
                      accessibilityState={{ disabled: !!used }}
                    >
                      {used ? (
                        <Ionicons name="checkmark-circle" size={15} color={colors.textMuted} style={styles.followupIcon} />
                      ) : kind ? (
                        <Ionicons name={FOLLOWUP_ICONS[kind]} size={15} color={colors.primary} style={styles.followupIcon} />
                      ) : null}
                      <Text style={[styles.followupChipText, used && styles.followupChipTextUsed]}>{f}</Text>
                    </TouchableOpacity>
                  );
                })}
                {msg.navSuggestions?.map((n, ni) => (
                  <TouchableOpacity
                    key={`n${ni}`}
                    style={styles.followupChip}
                    onPress={() => openNavSuggestion(n.view)}
                    disabled={disabled}
                  >
                    <Ionicons
                      name={FOLLOWUP_ICONS[n.kind === 'setup' ? 'setup' : 'navigate']}
                      size={15}
                      color={colors.primary}
                      style={styles.followupIcon}
                    />
                    <Text style={styles.followupChipText}>{n.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
          );
        })}

        {/* Streaming reply */}
        {chat.streamingText ? (
          <View style={[styles.row, styles.rowLeft]}>
            <View style={[styles.bubble, styles.bubbleAssistant]}>
              <AssistantText content={chat.streamingText} streaming onPlace={openPlace} onSearch={openSearch} />
            </View>
          </View>
        ) : null}

        {/* Thinking / tool activity. Shown for the WHOLE turn while loading —
            below the last user message before any text arrives, then below the
            partial reply once it starts streaming (the turn is still working:
            more text, or a mid-stream tool like "Searching the web…" whose
            activity would otherwise be invisible). Clears when the turn resolves
            and the streamed text is committed as a real message. */}
        {chat.loading ? (
          <View style={[styles.row, styles.rowLeft]}>
            <View style={[styles.bubble, styles.bubbleAssistant, styles.thinking]}>
              <ActivityIndicator size="small" color={colors.primary} />
              {chat.toolActivity ? <Text style={styles.thinkingText}>{chat.toolActivity}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* Follow-up / action / nav chips now render inline under each assistant
            message (in the conversation map above), so they stay in scrollback
            and every past turn keeps its own — not just a single latest row. */}

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

        {/* Jump-to-latest: appears once you scroll up off the bottom (so a
            streaming reply no longer drags the view). Tapping snaps back down
            and re-engages following. Hidden on the empty state. */}
        {!stick.atBottom && !empty ? (
          <TouchableOpacity
            style={styles.jumpBtn}
            onPress={stick.pinToBottom}
            accessibilityLabel="Scroll to latest"
            activeOpacity={0.85}
          >
            <Ionicons name="chevron-down" size={22} color={colors.text} />
          </TouchableOpacity>
        ) : null}
      </View>

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
          ref={inputRef}
          style={styles.textInput}
          value={chat.input}
          onChangeText={chat.setInput}
          onSelectionChange={(e) => {
            selectionRef.current = e.nativeEvent.selection;
          }}
          onFocus={() => {
            inputFocusedRef.current = true;
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
          }}
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
            disabled && styles.sendBtnDisabled,
          ]}
          // Not gated on chat.loading: the user can dictate (or type) the next
          // message while the assistant is still working on the current turn —
          // the composed text just waits until the reply lands to be sent.
          onPress={() => (dictation.state === 'listening' ? dictation.stop() : startDictation())}
          disabled={disabled}
          accessibilityLabel={dictation.state === 'listening' ? 'Stop dictation' : 'Dictate a message'}
        >
          <Ionicons
            name={dictation.state === 'listening' ? 'stop' : 'mic'}
            size={20}
            color={dictation.state === 'listening' ? '#fff' : activeAccent}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.sendBtn,
            { backgroundColor: activeAccent },
            !(canSend || chat.loading) && styles.sendBtnDisabled,
          ]}
          onPress={() => {
            // While a turn is streaming the button is a Stop control — tapping
            // it interrupts the assistant (keeps whatever streamed so far) and
            // returns to idle, rather than doing nothing.
            if (chat.loading) {
              chat.stop();
              return;
            }
            // Drop the keyboard on submit so the reply is fully readable. The
            // hook's send() empties the input state (setInput('')), but a
            // controlled multiline TextInput on iOS doesn't reliably flush that
            // empty value to the native field when it lands on the same tick as
            // the tap — the sent text lingers in the composer. Clearing
            // imperatively on the NEXT frame (after React has committed value=''
            // and the field has blurred) reliably empties it; a synchronous
            // clear here races that commit and often loses. The button is only
            // enabled when canSend, so there's always real text to clear.
            // If the mic was still capturing, toggle it off as the turn is sent
            // — dictation shouldn't keep running after submit. cancel() discards
            // any trailing result so it can't re-populate the cleared field.
            if (dictation.state === 'listening') dictation.cancel();
            chat.send();
            Keyboard.dismiss();
            requestAnimationFrame(() => inputRef.current?.clear());
          }}
          disabled={!(canSend || chat.loading)}
          accessibilityLabel={chat.loading ? 'Stop generating' : 'Send message'}
        >
          {chat.loading ? (
            <Ionicons name="stop" size={20} color="#fff" />
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

      {/* Recent chats (device-local, last 7 days) — every assistant's chats in
          one list, each tagged with its tab icon. Tap to resume: same tab loads
          in place, another tab hands off (switch tab / pick trip, then resume).
          Opened from the header's history clock (ChatHeaderButtons). */}
      <BottomSheet
        visible={chat.historyOpen}
        onClose={chat.closeHistory}
        title="Recent chats"
        avoidKeyboard
        style={styles.historySheet}
      >
        {chat.recentChats.length === 0 ? (
          <Text style={styles.historyEmpty}>Chats from the last 7 days show up here.</Text>
        ) : (
          <>
            {/* Keyword search — filters the list by title + message text. */}
            <View style={styles.historySearchPill}>
              <Ionicons name="search" size={18} color={colors.textMuted} />
              <TextInput
                style={styles.historySearchInput}
                value={historyQuery}
                onChangeText={setHistoryQuery}
                placeholder="Search chats"
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="never"
              />
              {historyQuery.length > 0 ? (
                <TouchableOpacity
                  onPress={() => setHistoryQuery('')}
                  hitSlop={8}
                  accessibilityLabel="Clear search"
                >
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>

            {filteredHistory.length === 0 ? (
              <Text style={styles.historyEmpty}>No chats match “{historyQuery.trim()}”.</Text>
            ) : (
              <ScrollView
                style={[styles.historyList, { maxHeight: historyListHeight }]}
                keyboardShouldPersistTaps="handled"
              >
                {filteredHistory.map((c) => {
                  const tab = ASSISTANT_TABS.find((t) => t.id === c.tab);
                  const tabAccent =
                    !tab || tab.accentKey === 'primary' ? colors.primary : areaColors[tab.accentKey];
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.pickerRow}
                      onPress={() => resumeChatRow(c)}
                      accessibilityLabel={`Resume ${tab?.label ?? ''} chat: ${c.title}`}
                    >
                      <MaterialCommunityIcons
                        name={tab?.icon ?? 'chat-outline'}
                        size={22}
                        color={tabAccent}
                        style={styles.historyIcon}
                      />
                      <View style={styles.historyBody}>
                        <Text style={styles.historyTitle} numberOfLines={1}>
                          {c.title}
                        </Text>
                        <Text style={styles.historyMeta} numberOfLines={1}>
                          {tab?.label ? `${tab.label} · ` : ''}
                          {relativeChatTime(c.updatedAt)} · {c.messages.length} message
                          {c.messages.length === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </>
        )}
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

// An assistant reply's text, with the model's [.. ](place:..) / (search:..)
// markers rendered as tappable links (see lib/chatLinks): places open the
// in-app Google place preview, search suggestions launch in the browser.
// `streaming` holds back a half-received trailing marker so raw markup never
// flashes while the reply streams in.
function AssistantText({
  content,
  streaming = false,
  onPlace,
  onSearch,
}: {
  content: string;
  streaming?: boolean;
  onPlace: (text: string, query: string) => void;
  onSearch: (text: string, query: string) => void;
}) {
  const segments = parseChatLinks(content, { trimIncomplete: streaming });
  return (
    <Text style={styles.bubbleAssistantText}>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <Text key={i}>{s.text}</Text>
        ) : (
          <Text
            key={i}
            style={styles.bubbleLink}
            onPress={() => (s.kind === 'place' ? onPlace(s.text, s.query) : onSearch(s.text, s.query))}
            accessibilityRole="link"
          >
            {s.text}
          </Text>
        ),
      )}
    </Text>
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
  // Relative wrapper so the jump-to-latest button can float over the list's
  // bottom edge, anchored above the composer regardless of the keyboard.
  listWrap: { flex: 1, position: 'relative' },
  jumpBtn: {
    position: 'absolute',
    bottom: spacing.md,
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
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
  // Resend icon sitting to the left of an unanswered user bubble.
  resendBtn: { alignSelf: 'center', paddingHorizontal: spacing.xs, paddingVertical: 4, marginRight: spacing.xs },
  bubble: { maxWidth: '85%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleAssistant: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  bubbleUserText: { color: '#fff', fontSize: 14, lineHeight: 21 },
  bubbleAssistantText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  bubbleLink: { color: colors.primary, textDecorationLine: 'underline' },
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
  // A one-shot create chip that's already been used: still visible (so the
  // history reads truthfully) but muted + non-interactive, with a check glyph, so
  // it can't fire again and create a duplicate.
  followupChipUsed: { borderColor: colors.border, backgroundColor: colors.surface, opacity: 0.7 },
  followupChipTextUsed: { color: colors.textMuted },
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
  // Recent-chats sheet: search pill, scrollable list, rows.
  historySearchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  historySearchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
  // Taller than the shared 80% sheet cap so the chat list has real room; the
  // list height itself (set inline from the window) keeps it clear of full-screen.
  historySheet: { maxHeight: '92%' },
  historyList: {},
  historyIcon: { width: 24, textAlign: 'center' },
  historyBody: { flex: 1 },
  historyTitle: { fontSize: 15, color: colors.text, fontWeight: '500' },
  historyMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  historyEmpty: { fontSize: 13, color: colors.textMuted, paddingVertical: spacing.md },
});
