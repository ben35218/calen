import React, { useCallback, useEffect, useLayoutEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useChat } from '../../hooks/useChat';
import type { ChatMessage } from '../../hooks/useChat';
import ChatScreen from '../chat/ChatScreen';
import ChatHeaderButtons from '../chat/ChatHeaderButtons';
import CreditsBanner from '../../components/CreditsBanner';
import type { RootStackParamList } from '../../navigation/types';
import type { AssistantId } from '../chat/assistantTabs';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Map the assistant's coarse frequency to a chore interval recurrence, which the
// chore form re-hydrates into its Repeat rule (via recurrenceToRule).
const UNIT: Record<string, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };

// Chores Assistant — a standalone chat that helps plan recurring chores. Like the
// Calendar assistant, it drafts a chore (open_create_chore_form) that the user
// reviews and saves in the prefilled chore form; nothing is written until then.
export default function ChoresAssistantScreen({
  onSelectAssistant,
  onResumeChat,
}: {
  onSelectAssistant?: (id: AssistantId) => void;
  onResumeChat?: (surfaceKey: string, chatId: string) => void;
} = {}) {
  const navigation = useNavigation<Nav>();

  const chat = useChat({
    endpoint: '/chores/chat',
    historyKey: 'chores',
    contextEndpoint: '/chores/chat/context',
    buildBody: (messages) => ({ messages }),
    // The drafted chore is held (and persisted/restored) by useChat as
    // `pendingChore` — the same channel as the calendar assistant's pendingEvent
    // — so it survives a resume from history, exactly like the chip that uses it.
    toolLabels: {
      web_search: 'Searching the web…',
      verify_place: "Checking if it's still open…",
      list_chores: 'Checking your chores…',
      open_create_chore_form: 'Drafting the chore…',
      suggest_navigation: 'Finding a shortcut…',
    },
  });

  useEffect(() => {
    chat.loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Review & add chore" opens the chore form prefilled with the draft on THAT
  // turn's message (`msg.pendingChore`), so tapping the chip on an older turn uses
  // that turn's own draft. The chip stays in scrollback and tappable — it only
  // ever opens a form (the form owns the save + E2EE sealing), so there's no
  // direct-create to disable. Any other chip falls through to a send.
  const handleFollowup = useCallback(
    (text: string, msg: ChatMessage): boolean => {
      const c = (msg.pendingChore ?? null) as Record<string, any> | null;
      if (text !== 'Review & add chore' || !c) return false;
      // Everything the draft tool can set rides through; the form validates
      // each field (icon against its own list, assignedToName against the
      // member options once they load) and ignores what it can't use.
      const prefill: Record<string, unknown> = {
        title: c.title,
        instructions: c.instructions,
        icon: c.icon,
        firstDueDate: c.firstDueDate,
        assignedToName: c.assignedToName,
        reminderDaysBefore: c.reminderDaysBefore,
        alert2DaysBefore: c.alert2DaysBefore,
        reminderTime: c.reminderTime,
        alertAudience: c.alertAudience,
        recurrence: c.frequency
          ? { type: 'interval', intervalValue: c.interval || 1, intervalUnit: UNIT[c.frequency] || 'weeks' }
          : undefined,
      };
      navigation.navigate('ChoreForm', { prefill });
      return true;
    },
    [navigation]
  );

  // History clock (opens the Recent-chats sheet) + compose (new chat).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <ChatHeaderButtons chat={chat} />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, chat.messages.length, chat.recentChats.length, chat.loading, chat.clear, chat.openHistory]);

  return (
    <ChatScreen
      chat={chat}
      surface="chores"
      activeAssistant="chores"
      onSelectAssistant={onSelectAssistant}
      onResumeExternal={onResumeChat}
      banner={<CreditsBanner />}
      emptyHint='e.g. "Set up a weekly trash chore"'
      placeholder="Message…"
      onFollowupPress={handleFollowup}
      followupKind={(text) => (text === 'Review & add chore' ? 'review' : undefined)}
    />
  );
}
