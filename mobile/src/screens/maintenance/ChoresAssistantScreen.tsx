import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useChat } from '../../hooks/useChat';
import ChatScreen from '../chat/ChatScreen';
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
export default function ChoresAssistantScreen({ onSelectAssistant }: { onSelectAssistant?: (id: AssistantId) => void } = {}) {
  const navigation = useNavigation<Nav>();
  // The chore Calen drafted this turn (from the server's pendingChore side effect).
  const pendingChore = useRef<Record<string, any> | null>(null);

  const chat = useChat({
    endpoint: '/chores/chat',
    contextEndpoint: '/chores/chat/context',
    buildBody: (messages) => ({ messages }),
    onResult: (data) => {
      pendingChore.current =
        data.pendingChore && typeof data.pendingChore === 'object'
          ? (data.pendingChore as Record<string, any>)
          : pendingChore.current;
    },
    toolLabels: {
      list_chores: 'Checking your chores…',
      open_create_chore_form: 'Drafting the chore…',
      suggest_navigation: 'Finding a shortcut…',
    },
  });

  useEffect(() => {
    chat.loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Review & add chore" opens the chore form prefilled with the draft; the form
  // owns the save (and its E2EE sealing). Any other chip falls through to a send.
  const handleFollowup = useCallback(
    (text: string): boolean => {
      const c = pendingChore.current;
      if (text !== 'Review & add chore' || !c) return false;
      const prefill: Record<string, unknown> = {
        title: c.title,
        instructions: c.instructions,
        recurrence: c.frequency
          ? { type: 'interval', intervalValue: c.interval || 1, intervalUnit: UNIT[c.frequency] || 'weeks' }
          : undefined,
      };
      chat.resolvePending();
      navigation.navigate('ChoreForm', { prefill });
      return true;
    },
    [chat, navigation]
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        chat.messages.length > 0 ? (
          <TouchableOpacity onPress={chat.clear} disabled={chat.loading}>
            <Text style={styles.clear}>Clear</Text>
          </TouchableOpacity>
        ) : undefined,
    });
  }, [navigation, chat.messages.length, chat.loading, chat.clear]);

  return (
    <ChatScreen
      chat={chat}
      surface="chores"
      activeAssistant="chores"
      onSelectAssistant={onSelectAssistant}
      banner={<CreditsBanner />}
      emptyHint='e.g. "Set up a weekly trash chore"'
      placeholder="Message…"
      onFollowupPress={handleFollowup}
      followupKind={(text) => (text === 'Review & add chore' ? 'review' : undefined)}
    />
  );
}

const styles = StyleSheet.create({
  clear: { color: '#fff', fontSize: 15, fontWeight: '500' },
});
