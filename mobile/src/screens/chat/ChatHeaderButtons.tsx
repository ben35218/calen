import React from 'react';
import { View, StyleSheet } from 'react-native';
import { HeaderIconButton } from '../../components/ui';
import { spacing } from '../../theme';
import type { ChatController } from '../../hooks/useChat';

// Shared header actions for every assistant chat, transparent white per the
// non-accented-header rule: a history clock that opens the Recent-chats sheet
// (device-local, last 7 days) and a compose glyph that starts a new chat. "New"
// is not destructive — the old conversation stays resumable from history.
export default function ChatHeaderButtons({ chat }: { chat: ChatController }) {
  const history = chat.recentChats.length > 0;
  const compose = chat.messages.length > 0;
  if (!history && !compose) return null;
  return (
    <View style={styles.row}>
      {history ? (
        <HeaderIconButton
          icon="time-outline"
          size={24}
          onPress={() => {
            if (!chat.loading) chat.openHistory();
          }}
          accessibilityLabel="Chat history"
        />
      ) : null}
      {compose ? (
        <HeaderIconButton
          icon="create-outline"
          size={24}
          onPress={() => {
            if (!chat.loading) chat.clear();
          }}
          accessibilityLabel="New chat"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
