import React, { useEffect, useLayoutEffect, useState } from 'react';
import { TouchableOpacity, Text, View, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useChat } from '../../hooks/useChat';
import ChatScreen from '../chat/ChatScreen';
import CreditsBanner from '../../components/CreditsBanner';
import { ProposedTask } from '../../api';
import { Badge } from '../../components/ui';
import { diyBadge } from '../../lib/diy';
import { recurrenceLabelShort } from '../../lib/recurrence';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { colors, radius, spacing } from '../../theme';
import type { AssistantId } from '../chat/assistantTabs';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList>;

// AI maintenance-plan chat. Unlike MaintenanceChatScreen (scoped to one item,
// creates tasks immediately), this is item-agnostic: Calen stages tasks into a
// live list, then the user links items and creates them through the same review
// flow as templates (TaskTemplateReview). Nothing is saved until then.
export default function AiTaskPlanChatScreen({ onSelectAssistant }: { onSelectAssistant?: (id: AssistantId) => void } = {}) {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.maintenance;
  const [plan, setPlan] = useState<ProposedTask[]>([]);

  const chat = useChat({
    endpoint: '/maintenance/plan-chat',
    contextEndpoint: '/maintenance/plan-chat/context',
    buildBody: (messages) => ({ messages }),
    onResult: (data) => {
      if (data.proposedTasks?.length) {
        setPlan((prev) => prev.concat(data.proposedTasks as unknown as ProposedTask[]));
      }
    },
    toolLabels: {
      get_home_context: 'Reviewing your home…',
      propose_tasks: 'Adding to your plan…',
      suggest_navigation: 'Finding a shortcut…',
    },
  });

  useEffect(() => {
    chat.loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const removeTask = (index: number) => setPlan((prev) => prev.filter((_, i) => i !== index));

  const reviewAndAdd = () => navigation.navigate('TaskTemplateReview', { proposedTasks: plan });

  const footer =
    plan.length > 0 ? (
      <View style={styles.footer}>
        <Text style={styles.footerTitle}>Your plan · {plan.length} task{plan.length === 1 ? '' : 's'}</Text>
        <ScrollView style={styles.planList} keyboardShouldPersistTaps="handled">
          {plan.map((t, i) => {
            const badge = diyBadge(t.diy);
            return (
              <View key={`${t.title}-${i}`} style={styles.planRow}>
                <View style={{ flex: 1 }}>
                  <View style={styles.planTitleRow}>
                    <Text style={styles.planTaskTitle} numberOfLines={1}>{t.title}</Text>
                    {badge ? <Badge label={badge.label} color={badge.color} /> : null}
                  </View>
                  <Text style={styles.planTaskMeta} numberOfLines={1}>
                    {[t.defaultCategoryName, t.recurrence ? recurrenceLabelShort(t.recurrence) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => removeTask(i)} accessibilityLabel={`Remove ${t.title}`} hitSlop={8}>
                  <Ionicons name="close-circle" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
        <TouchableOpacity style={[styles.reviewBtn, { backgroundColor: accent }]} activeOpacity={0.85} onPress={reviewAndAdd}>
          <Ionicons name="eye-outline" size={17} color="#fff" style={styles.reviewBtnIcon} />
          <Text style={styles.reviewBtnText}>Review &amp; add {plan.length} task{plan.length === 1 ? '' : 's'}</Text>
        </TouchableOpacity>
      </View>
    ) : null;

  return (
    <ChatScreen
      chat={chat}
      surface="maintenance"
      banner={<CreditsBanner />}
      footer={footer}
      activeAssistant="maintenance"
      onSelectAssistant={onSelectAssistant}
      emptyHint='e.g. "Help me set up maintenance for my house"'
      placeholder="Tell Calen about your home…"
    />
  );
}

const styles = StyleSheet.create({
  clear: { color: '#fff', fontSize: 15, fontWeight: '500' },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  footerTitle: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 4 },
  planList: { maxHeight: 150 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8 },
  planTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planTaskTitle: { fontSize: 14, color: colors.text, fontWeight: '500', flexShrink: 1 },
  planTaskMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  reviewBtn: { flexDirection: 'row', borderRadius: radius.md, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm, marginBottom: spacing.sm },
  reviewBtnIcon: { marginRight: 6 },
  reviewBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
