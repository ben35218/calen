import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, AppState, Linking, Switch, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { settingsApi } from '../../api';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { ensureNotificationPermission, rescheduleReminders } from '../../lib/notifications';
import { Screen, Card, TimeField } from '../../components/ui';
import { form as fs } from '../../components/formStyles';
import { colors, spacing } from '../../theme';

// The reminders hub (Profile → Reminders): the master on/off toggle and the
// personal day-based alert time. Self-contained — every control saves itself
// immediately (the toggle via privacy prefs, the time via /settings), so there
// is no header save button; the screen just uses the default back navigation.
export default function RemindersScreen() {
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await settingsApi.get()).data,
  });

  // Personal default time day-based alerts fire at ('' = the 9am default).
  const [dayAlertTime, setDayAlertTime] = useState('');
  useEffect(() => {
    if (settings) setDayAlertTime(settings.dayAlertTime ?? '');
  }, [settings]);

  const { prefs, set: setPref } = usePrivacyPrefs();
  const [perm, setPerm] = useState<Notifications.PermissionStatus | null>(null);

  const refreshPermission = useCallback(() => {
    Notifications.getPermissionsAsync()
      .then(({ status }) => setPerm(status))
      .catch(() => {});
  }, []);

  useFocusEffect(useCallback(() => { refreshPermission(); }, [refreshPermission]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshPermission();
    });
    return () => sub.remove();
  }, [refreshPermission]);

  async function onToggleReminders(v: boolean) {
    setPref('remindersEnabled', v);
    if (v) {
      await ensureNotificationPermission();
      refreshPermission();
    }
  }

  // Save the day-based alert time immediately (empty = reset to the 9am default),
  // then reschedule so pending on-device reminders pick up the new time.
  async function onChangeDayAlertTime(v: string) {
    setDayAlertTime(v);
    try {
      await settingsApi.update({ dayAlertTime: v || '' });
      qc.invalidateQueries({ queryKey: ['settings'] });
      rescheduleReminders().catch(() => {});
    } catch (e: any) {
      setDayAlertTime(settings?.dayAlertTime ?? ''); // revert the optimistic value
    }
  }

  const denied = perm === 'denied';

  return (
    <Screen>
      <Card style={styles.sectionCard}>
        <View style={styles.mainRow}>
          <View style={styles.iconBubble}>
            <Ionicons name="notifications" size={18} color="#fff" />
          </View>
          <View style={styles.mainText}>
            <Text style={styles.mainLabel}>Allow reminders</Text>
            <Text style={styles.mainSubtitle}>Events, tasks, chores & birthdays</Text>
          </View>
          <Switch value={prefs.remindersEnabled} onValueChange={onToggleReminders} trackColor={{ true: colors.primary }} />
        </View>

        {denied && (
          <View style={styles.deniedBanner}>
            <Ionicons name="notifications-off-outline" size={18} color={colors.warning} style={{ marginRight: spacing.sm }} />
            <Text style={styles.deniedText}>
              Notifications are turned off for this app in system Settings, so reminders can’t be delivered.
            </Text>
          </View>
        )}
        {denied && (
          <TouchableOpacity style={styles.settingsRow} onPress={() => Linking.openSettings()} activeOpacity={0.7}>
            <Ionicons name="settings-outline" size={20} color={colors.primary} />
            <Text style={styles.settingsLabel}>Open Settings</Text>
          </TouchableOpacity>
        )}

        <View style={styles.infoDivider} />
        {/* A set time renders in the same muted style as the 9:00 AM default
            (placeholder), so changing it doesn't restyle the row. */}
        <TimeField
          inlineLabel="Day-based alerts at"
          placeholder="9:00 AM"
          defaultValue="09:00"
          value={dayAlertTime}
          onChange={onChangeDayAlertTime}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={[fs.dtValue, styles.dayAlertValue]}
          hideIcon
        />
        <View style={styles.infoRow}>
          <Ionicons name="time-outline" size={16} color={colors.textMuted} style={styles.infoIcon} />
          <Text style={styles.infoText}>Tasks, chores & birthdays without their own alert time are delivered at this time. Set it back to 9:00 AM to use the default.</Text>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionCard: { marginBottom: spacing.md },
  mainRow: { flexDirection: 'row', alignItems: 'center' },
  iconBubble: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  mainText: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  mainLabel: { fontSize: 16, color: colors.text, fontWeight: '600' },
  mainSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  infoDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4 },
  infoIcon: { marginRight: spacing.sm, marginTop: 1 },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 16 },
  // Match the placeholder colour so a chosen time reads like the 9:00 AM default.
  dayAlertValue: { color: colors.textMuted },
  deniedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,167,38,0.12)',
    borderRadius: 10,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  deniedText: { flex: 1, color: colors.warning, fontSize: 12, lineHeight: 16 },
  settingsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  settingsLabel: { fontSize: 15, color: colors.primary, fontWeight: '600' },
});
