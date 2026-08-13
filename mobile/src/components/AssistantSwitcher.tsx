import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Text } from './Text';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { colors, spacing } from '../theme';
import { useCalendarColors } from '../lib/calendarPrefs';
import { ASSISTANT_TABS, AssistantId } from '../screens/chat/assistantTabs';

// The assistant icon row shared by every top-level Calen surface: the chat
// (ChatScreen) and the trip picker. `chat` tabs swap the active body in place via
// onSelectAssistant; `nav` tabs (Recipes) open a separate surface.
export default function AssistantSwitcher({
  active,
  onSelectAssistant,
}: {
  active?: AssistantId;
  onSelectAssistant?: (id: AssistantId) => void;
}) {
  const areaColors = useCalendarColors().colors;
  const navigation = useNavigation();

  const select = (tab: (typeof ASSISTANT_TABS)[number]) => {
    if (tab.id === active) return;
    if (tab.action.kind === 'chat') onSelectAssistant?.(tab.id);
    else (navigation as unknown as { navigate: (r: string) => void }).navigate(tab.action.route);
  };

  return (
    <View style={styles.switcher}>
      {ASSISTANT_TABS.map((tab) => {
        const selected = tab.id === active;
        const accent = tab.accentKey === 'primary' ? colors.primary : areaColors[tab.accentKey];
        return (
          <TouchableOpacity
            key={tab.id}
            style={styles.switcherItem}
            onPress={() => select(tab)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${tab.label} assistant`}
          >
            <View style={[styles.switcherIcon, selected && { backgroundColor: accent + '26', borderColor: accent }]}>
              <MaterialCommunityIcons name={tab.icon} size={22} color={selected ? accent : colors.textMuted} />
            </View>
            <Text style={[styles.switcherLabel, selected && { color: accent, fontWeight: '700' }]} numberOfLines={1}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  switcher: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  switcherItem: { alignItems: 'center', gap: 4, flex: 1 },
  switcherIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switcherLabel: { fontSize: 11, color: colors.textMuted },
});
