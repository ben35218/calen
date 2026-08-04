import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Select, TimeField, Screen, useHeaderCheckButton } from '../../components/ui';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { useHolidayAlertPrefs, useHolidayCalendars } from '../../lib/calendarPrefs';
import { colorOf } from '../../lib/calendar';
import { OCCASION_ALERT_OFFSET_OPTIONS, excludeUsedAlert } from '../../lib/recurrence';
import { rescheduleReminders } from '../../lib/notifications';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

type Nav = NativeStackNavigationProp<CalendarStackParamList>;

const OFFSET_OPTIONS = OCCASION_ALERT_OFFSET_OPTIONS.map((o) => ({ label: o.label, value: o.value ?? -1 }));

// Calendar-level alert settings for holiday calendars, reached from the
// notifications button on any country's holidays editor. One config covers
// EVERY holiday calendar the user has — no per-country and no per-holiday
// override. Defaults to off (holidays are numerous; opt in). Edits the
// device-local holiday-alert prefs (calendarPrefs) and reschedules the
// on-device reminder window on save.
export default function HolidayAlertsScreen() {
  const navigation = useNavigation<Nav>();
  const { calendarId } = useRoute<RouteProp<CalendarStackParamList, 'HolidayAlerts'>>().params ?? {};
  const { prefs, setHolidayAlertPrefs } = useHolidayAlertPrefs();
  const { calendars } = useHolidayCalendars();
  // The calendar we arrived from tints this screen; the settings themselves are
  // shared, so any of them lands on the same prefs.
  const cal = calendars.find((c) => c.id === calendarId);
  const accent = cal ? colorOf(cal.id) : colors.primary;
  const multiple = calendars.length > 1;

  // The stored `offsets` array maps onto two alert slots (primary + secondary).
  const [alert1, setAlert1] = useState<number | null>(prefs.offsets[0] ?? null);
  const [alert2, setAlert2] = useState<number | null>(prefs.offsets[1] ?? null);
  const [time, setTime] = useState<string>(prefs.time || '09:00');

  const onSave = () => {
    const offsets = [alert1, alert2].filter((v): v is number => v != null);
    setHolidayAlertPrefs({ offsets, time: time || '09:00' });
    rescheduleReminders().catch(() => {});
    allowLeave();
    navigation.goBack();
  };

  useHeaderCheckButton(navigation, { onPress: onSave, color: accent });

  // Discard guard: prompt before leaving with unsaved alert-offset/time changes.
  // The prefs seed synchronously, so the baseline is the form on first render.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ alert1, alert2, time });
  useEffect(() => {
    if (baselineRef.current === null) baselineRef.current = snapshot;
  }, [snapshot]);
  const dirty = baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  const anyAlert = alert1 != null || alert2 != null;

  return (
    <Screen>
      <Text style={styles.hint}>
        {multiple
          ? 'These alerts apply to the holidays showing on every one of your holiday calendars. Holidays have no alerts until you pick one.'
          : 'These alerts apply to every holiday showing on your holiday calendar. Holidays have no alerts until you pick one.'}
      </Text>

      <GroupCard>
        <Select
          inlineLabel="Alert"
          value={alert1 ?? -1}
          options={excludeUsedAlert(OFFSET_OPTIONS, alert2, alert1)}
          onChange={(v) => setAlert1(v === -1 ? null : (v as number))}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        <Select
          inlineLabel="Second alert"
          value={alert2 ?? -1}
          options={excludeUsedAlert(OFFSET_OPTIONS, alert1, alert2)}
          onChange={(v) => setAlert2(v === -1 ? null : (v as number))}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        {anyAlert ? (
          <>
            <CardDivider />
            <TimeField
              inlineLabel="Alert at"
              placeholder="9:00 AM"
              defaultValue="09:00"
              value={time}
              onChange={(v) => setTime(v || '09:00')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              hideIcon
            />
          </>
        ) : null}
      </GroupCard>

      {!anyAlert ? (
        <View style={styles.offNote}>
          <Text style={styles.offText}>Holiday alerts are off. Pick an alert above to be reminded.</Text>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 18 },
  offNote: { marginTop: spacing.md },
  offText: { fontSize: 13, color: colors.textMuted },
});
