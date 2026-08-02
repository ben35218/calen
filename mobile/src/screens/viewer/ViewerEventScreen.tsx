import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { useRoute, RouteProp } from '@react-navigation/native';
import { Screen, ScreenTitle, SectionTitle, CardRow } from '../../components/ui';
import type { RootStackParamList } from '../../navigation/types';
import { colors, spacing } from '../../theme';

// Free viewer mode's read-only event detail. The agenda hands the decrypted
// snapshot over as a route param (the viewer's replica already holds it), so
// there's no refetch and none of EventDetailScreen's owner machinery (edit,
// delete, invitees, AI calls) — a viewer can only look.

type Rt = RouteProp<RootStackParamList, 'ViewerEvent'>;

export default function ViewerEventScreen() {
  const { event, calendarName, accent } = useRoute<Rt>().params;

  const when = useMemo(() => {
    const fmtDay = (d: Date) =>
      d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const fmtTime = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    const start = new Date(event.startDate);
    const end = event.endDate ? new Date(event.endDate) : null;
    if (event.allDay !== false) {
      const endDay = end && end.toDateString() !== start.toDateString();
      return endDay ? `All-day from ${fmtDay(start)}\nto ${fmtDay(end!)}` : `All-day · ${fmtDay(start)}`;
    }
    return `${fmtDay(start)}, ${fmtTime(start)}${end ? ` – ${fmtTime(end)}` : ''}`;
  }, [event]);

  const openInMaps = () => {
    if (!event.location) return;
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`);
  };

  return (
    <Screen>
      <ScreenTitle>{event.title}</ScreenTitle>

      {event.location ? (
        <TouchableOpacity onPress={openInMaps} activeOpacity={0.7}>
          <Text style={[styles.location, { color: accent }]}>{event.location}</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.when}>{when}</Text>

      <View style={styles.rows}>
        <CardRow
          title="Calendar"
          right={
            <View style={styles.rightRow}>
              <View style={[styles.dot, { backgroundColor: accent }]} />
              <Text style={styles.rightValue}>{calendarName}</Text>
            </View>
          }
        />
      </View>

      {event.description ? (
        <>
          <SectionTitle>Notes</SectionTitle>
          <Text style={styles.notes}>{event.description}</Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  location: { fontSize: 16, marginTop: 6, lineHeight: 22 },
  when: { fontSize: 15, color: colors.text, lineHeight: 22, marginTop: spacing.md, marginBottom: spacing.lg },
  rows: { gap: spacing.md },
  rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rightValue: { fontSize: 16, color: colors.textMuted },
  dot: { width: 12, height: 12, borderRadius: 6 },
  notes: { fontSize: 15, color: colors.text, lineHeight: 22, marginTop: spacing.xs },
});
