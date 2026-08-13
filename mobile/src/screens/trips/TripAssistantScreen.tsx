import React, { useEffect, useLayoutEffect } from 'react';
import { TouchableOpacity, View, StyleSheet } from 'react-native';
import { Text } from '../../components/Text';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useChat } from '../../hooks/useChat';
import ChatScreen from '../chat/ChatScreen';
import ChatHeaderButtons from '../chat/ChatHeaderButtons';
import CreditsBanner from '../../components/CreditsBanner';
import { tripsApi, householdApi } from '../../api';
import { getHDK, openRecord } from '../../lib/e2ee';
import { createAliasContext } from '../../lib/aiPayload';
import { useCalendarColors } from '../../lib/calendarPrefs';
import type { AssistantId } from '../chat/assistantTabs';
import { colors, spacing } from '../../theme';

// Trip Assistant — ports client/src/views/VacationAssistantView.vue.
// Used two ways: as a standalone route from a trip's detail page, and embedded in
// the unified AssistantScreen (Trips tab) after the user picks a trip. When
// embedded, `onSelectAssistant`/`onChangeTrip` are passed so the switcher shows
// and the user can jump back to the trip picker; the trip comes in via props.
export default function TripAssistantScreen({
  tripId: tripIdProp,
  tripName: tripNameProp,
  onSelectAssistant,
  onResumeChat,
  onChangeTrip,
}: {
  tripId?: string;
  tripName?: string;
  onSelectAssistant?: (id: AssistantId) => void;
  onResumeChat?: (surfaceKey: string, chatId: string) => void;
  onChangeTrip?: () => void;
} = {}) {
  const navigation = useNavigation();
  const routeParams = (useRoute().params ?? {}) as { tripId?: string; tripName?: string };
  const tripId = tripIdProp ?? routeParams.tripId!;
  const tripName = tripNameProp ?? routeParams.tripName;
  const accent = useCalendarColors().colors.trips;
  const qc = useQueryClient();

  // Ephemeral-consent (§9.1 P4a): post-drop the server can't read trip content,
  // so send the decrypted trip + itinerary per request. Dormant pre-drop.
  const ephemeralRef = React.useRef<Record<string, unknown> | null>(null);

  // G1: prompt-bound records leave with ids aliased (tripId stays real — the
  // server's authz/metering routing field, never prompt content).
  const aliasCtx = React.useMemo(() => createAliasContext(), []);

  const chat = useChat({
    endpoint: '/trips/chat',
    // Trip chats are trip-scoped, so history is too — the sheet lists only this
    // trip's conversations.
    historyKey: `trips:${tripId}`,
    contextEndpoint: `/trips/chat/context?tripId=${tripId}`,
    // Post-drop the DB summary is sealed — POST the decrypted trip instead.
    contextBody: () => (ephemeralRef.current ? { tripId, ...ephemeralRef.current } : null),
    buildBody: (messages) => ({ tripId, messages, ...(ephemeralRef.current || {}) }),
    transformResult: aliasCtx.resolveAliases,
    onResult: () => qc.invalidateQueries({ queryKey: ['trips', tripId] }),
    toolLabels: {
      web_search: 'Searching the web…',
      verify_place: "Checking if it's still open…",
      suggest_navigation: 'Finding a shortcut…',
    },
  });

  useEffect(() => {
    chat.loadContext();
    (async () => {
      try {
        let e2eeActive = false;
        try { e2eeActive = !!(await householdApi.get()).data.e2eeActive; } catch { /* solo/offline */ }
        if (!e2eeActive || !getHDK()) return;
        const { data } = await tripsApi.get(tripId);
        const trip = await openRecord('Trip', (data as any).trip);
        const items = await Promise.all(((data as any).items || []).map((i: any) => openRecord('TripItem', i)));
        ephemeralRef.current = { trip: aliasCtx.sanitize(trip), items: aliasCtx.sanitize(items) };
        chat.loadContext(); // refresh the summary with the decrypted records
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History clock (opens the Recent-chats sheet) + compose (new chat).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <ChatHeaderButtons chat={chat} />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, chat.messages.length, chat.recentChats.length, chat.loading, chat.clear, chat.openHistory]);

  // When embedded, a slim bar names the trip being planned and lets the user pop
  // back to the trip picker to choose another (or start a new one).
  const tripBar = onChangeTrip ? (
    <View style={styles.tripBar}>
      <Ionicons name="briefcase-outline" size={16} color={accent} />
      <Text style={styles.tripBarText} numberOfLines={1}>
        Planning {tripName || 'your trip'}
      </Text>
      <TouchableOpacity onPress={onChangeTrip} hitSlop={8}>
        <Text style={[styles.tripBarChange, { color: accent }]}>Change trip</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <ChatScreen
      chat={chat}
      surface="trips"
      // Only render the switcher when embedded in the unified view; standalone
      // (from a trip's detail page) it stays a focused single-trip chat.
      activeAssistant={onSelectAssistant ? 'trips' : undefined}
      onSelectAssistant={onSelectAssistant}
      onResumeExternal={onResumeChat}
      banner={<CreditsBanner />}
      footer={tripBar}
      navContext={{ tripId }}
      emptyHint={'e.g. "What\'s my itinerary?"'}
      placeholder="Message…"
    />
  );
}

const styles = StyleSheet.create({
  tripBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tripBarText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text },
  tripBarChange: { fontSize: 13, fontWeight: '600' },
});
