import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  CALENDARS,
  useCalendarColors,
  useDeletedDefaultCalendars,
} from '../../lib/calendarPrefs';
import { useOwnedAddons } from '../../lib/addons';
import { Screen, SectionTitle } from '../../components/ui';
import { GroupCard, CardDivider } from '../../components/formStyles';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

// The "Add Calendar" chooser: pick WHAT KIND of calendar to add, each opening
// its own focused screen. Replaces the old overloaded form that mixed these
// entry points into the new-calendar form. Deleted household defaults are
// offered here for one-tap restore.
export default function AddCalendarMenuScreen() {
  const nav = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const { colors: calColors } = useCalendarColors();
  const { deletedIds, restoreDefault } = useDeletedDefaultCalendars();
  const { isUnlocked } = useOwnedAddons();
  // Restoring a LOCKED add-on calendar would restore it into nothing (locked
  // calendars don't render anywhere) — the storefront row is that calendar's
  // affordance until it's owned, so hide it here.
  const deletedDefaults = CALENDARS.filter((c) => deletedIds.includes(c.id) && isUnlocked(c.id));

  const CHOICES: { icon: keyof typeof Ionicons.glyphMap; title: string; hint: string; go: () => void }[] = [
    {
      icon: 'add-circle-outline',
      title: 'New calendar',
      hint: 'A calendar you fill in yourself (School, Soccer…)',
      go: () => nav.navigate('AddCalendar'),
    },
    {
      icon: 'link-outline',
      title: 'Subscribe to a calendar',
      hint: 'Paste an iCloud, Google, or webcal calendar link',
      go: () => nav.navigate('SubscribeCalendar'),
    },
    {
      icon: 'flag-outline',
      title: 'Add a holiday calendar',
      hint: 'Pick a country — national, provincial, and cultural holidays',
      go: () => nav.navigate('AddHolidayCalendar'),
    },
  ];

  return (
    <Screen>
      <GroupCard>
        {CHOICES.map((c, i) => (
          <React.Fragment key={c.title}>
            {i > 0 ? <CardDivider /> : null}
            <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={c.go}>
              <Ionicons name={c.icon} size={22} color={colors.primary} />
              <View style={styles.rowText}>
                <Text style={styles.title}>{c.title}</Text>
                <Text style={styles.hint}>{c.hint}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </React.Fragment>
        ))}
      </GroupCard>

      {deletedDefaults.length > 0 ? (
        <>
          <SectionTitle>Deleted Calendars</SectionTitle>
          <GroupCard>
            {deletedDefaults.map((cal, i) => (
              <React.Fragment key={cal.id}>
                {i > 0 ? <CardDivider /> : null}
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.7}
                  onPress={() => {
                    restoreDefault(cal.id);
                    nav.goBack();
                  }}
                >
                  <View style={[styles.restoreAccent, { backgroundColor: calColors[cal.id] ?? cal.color }]} />
                  <Text style={styles.restoreName}>{cal.name}</Text>
                  <Ionicons name="add-circle-outline" size={24} color={calColors[cal.id] ?? cal.color} />
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </GroupCard>
          <Text style={styles.sectionHint}>Restore a deleted household calendar and its events.</Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: 14 },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  restoreAccent: { width: 4, height: 24, borderRadius: 2 },
  restoreName: { flex: 1, fontSize: 16, color: colors.text },
  sectionHint: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm, paddingHorizontal: 2 },
});
