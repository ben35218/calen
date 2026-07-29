import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { colors, spacing } from '../../../theme';
import { DayNav, openAllDayItem } from './dayNav';
import { AllDayItem, GUTTER } from './dayViewLayout';

const COLLAPSED_MAX = 3;

// The "all-day" lane above the hour grid: tinted chips per visible day.
// Date-only tasks/chores render muted with an empty-circle glyph (they're
// reminders, not scheduled blocks). Hidden entirely when every visible day is
// empty, like Apple.
export default function AllDayRow({ days }: { days: { date: string; items: AllDayItem[] }[] }) {
  const navigation = useNavigation<DayNav>();
  const [expanded, setExpanded] = useState(false);

  if (days.every((d) => !d.items.length)) return null;

  return (
    <View style={styles.row}>
      <Text style={styles.label}>all-day</Text>
      {days.map((d, i) => {
        const shown = expanded ? d.items : d.items.slice(0, COLLAPSED_MAX);
        const hidden = d.items.length - shown.length;
        return (
          <View key={d.date} style={[styles.col, i > 0 && styles.colDivider]}>
            {shown.map((item) => (
              <TouchableOpacity
                key={item.key}
                activeOpacity={0.75}
                onPress={() => openAllDayItem(navigation, item, d.date)}
                style={[
                  styles.chip,
                  item.muted ? styles.chipMuted : { backgroundColor: item.color + '2E' },
                  item.faded && styles.chipFaded,
                ]}
              >
                {item.muted ? (
                  <Ionicons name="ellipse-outline" size={12} color={colors.textMuted} style={styles.chipIcon} />
                ) : null}
                <Text
                  style={[
                    styles.chipText,
                    { color: item.muted ? colors.textMuted : item.color },
                    item.strike && styles.chipStrike,
                  ]}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
              </TouchableOpacity>
            ))}
            {hidden > 0 ? (
              <TouchableOpacity onPress={() => setExpanded(true)}>
                <Text style={styles.more}>+{hidden} more</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { width: GUTTER, textAlign: 'right', paddingRight: 6, fontSize: 11, color: colors.textMuted, marginTop: 4 },
  col: { flex: 1, paddingHorizontal: 3, gap: 3 },
  colDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  chipMuted: { backgroundColor: colors.surface },
  chipFaded: { opacity: 0.5 },
  chipIcon: { marginRight: 4 },
  chipText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  chipStrike: { textDecorationLine: 'line-through' },
  more: { fontSize: 11, fontWeight: '600', color: colors.textMuted, paddingLeft: 6, paddingTop: 1 },
});
