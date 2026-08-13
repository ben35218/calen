import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COUNTRIES } from '../../lib/holidays';
import { useHolidayCalendars } from '../../lib/calendarPrefs';
import { Screen, SectionTitle, Hint } from '../../components/ui';
import { GroupCard, CardDivider } from '../../components/formStyles';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

// Pick a country to add its holiday calendar (Calendars → Add Calendar → holiday
// calendar). Each country becomes its own calendar row; already-added countries
// are shown as "Added" and just open that calendar's settings.
export default function AddHolidayCalendarScreen() {
  const nav = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const { calendars } = useHolidayCalendars();
  const added = new Map(calendars.map((c) => [c.country, c.id]));

  const onPick = (code: (typeof COUNTRIES)[number]['code']) => {
    const existingId = added.get(code);
    // Already added → open its settings; new → the calendar form seeded as a
    // holiday calendar (name/colour/sharing), which creates it on save.
    if (existingId) nav.replace('Holidays', { calendarId: existingId });
    else nav.replace('AddCalendar', { holidayCountry: code });
  };

  return (
    <Screen>
      <Hint>
        Add a country's holidays as their own calendar — national and provincial/state days plus
        cultural and religious ones, each individually toggleable.
      </Hint>
      <SectionTitle>Country</SectionTitle>
      <GroupCard>
        {COUNTRIES.map((c, i) => {
          const isAdded = added.has(c.code);
          return (
            <React.Fragment key={c.code}>
              {i > 0 ? <CardDivider /> : null}
              <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onPick(c.code)}>
                <Ionicons name="flag-outline" size={20} color={colors.textMuted} />
                <Text style={styles.name}>{c.name}</Text>
                {isAdded ? <Text style={styles.added}>Added</Text> : null}
                <Ionicons
                  name={isAdded ? 'chevron-forward' : 'add-circle-outline'}
                  size={isAdded ? 18 : 24}
                  color={isAdded ? colors.textMuted : colors.primary}
                />
              </TouchableOpacity>
            </React.Fragment>
          );
        })}
      </GroupCard>
      <Text style={styles.hint}>Adds a calendar like "Canadian Holidays" you can colour, hide, or remove.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: 14 },
  name: { flex: 1, fontSize: 16, color: colors.text },
  added: { fontSize: 13, color: colors.textMuted },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm, paddingHorizontal: 2 },
});
