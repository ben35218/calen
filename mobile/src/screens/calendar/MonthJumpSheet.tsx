// The month/year quick-jump sheet behind the calendar's sticky header label:
// a year stepper over a 3×4 month grid. Fast travel for the unbounded month
// grid — scrolling covers the near range, this covers "March 2028". The year
// is unbounded in both directions (the window grows to cover any pick).

import React, { useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '../../components/ui';
import { colors, spacing, radius } from '../../theme';
import type { YearMonth } from '../../lib/calendarWindow';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function MonthJumpSheet({
  visible,
  onClose,
  current,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  // The month the grid is showing now — the sheet opens on its year.
  current: YearMonth;
  onSelect: (m: YearMonth) => void;
}) {
  const [year, setYear] = useState(current.year);
  // Re-anchor on every open: the sheet reflects where the grid is NOW, not
  // where the user last browsed the stepper to.
  useEffect(() => {
    if (visible) setYear(current.year);
  }, [visible, current.year]);

  const now = new Date();
  const isCurrent = (m: number) => year === current.year && m === current.month;
  const isThisMonth = (m: number) => year === now.getFullYear() && m === now.getMonth();

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.yearRow}>
        <TouchableOpacity
          style={styles.yearBtn}
          hitSlop={8}
          onPress={() => setYear((y) => y - 1)}
          accessibilityLabel="Previous year"
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.yearText}>{year}</Text>
        <TouchableOpacity
          style={styles.yearBtn}
          hitSlop={8}
          onPress={() => setYear((y) => y + 1)}
          accessibilityLabel="Next year"
        >
          <Ionicons name="chevron-forward" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.monthGrid}>
        {MONTHS.map((label, m) => (
          <TouchableOpacity
            key={label}
            style={[styles.monthCell, isCurrent(m) && styles.monthCellCurrent]}
            activeOpacity={0.7}
            onPress={() => onSelect({ year, month: m })}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${year}`}
          >
            <Text
              style={[
                styles.monthText,
                isThisMonth(m) && !isCurrent(m) && styles.monthTextToday,
                isCurrent(m) && styles.monthTextCurrent,
              ]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </BottomSheet>
  );
}

// The header's "Month Year ▾" label plus the jump sheet it opens, shared by the
// month-grid layer and the List layer. Owns the sheet's open/close state so
// tapping the label re-renders only this component — keeping that state in the
// heavy calendar layer behind it re-rendered the whole layer before the sheet's
// modal could mount, which made it visibly slow to open. Memoized so the host's
// scroll/swipe-driven re-renders skip it while its props hold still.
export const MonthJumpHeaderButton = React.memo(function MonthJumpHeaderButton({
  label,
  current,
  onSelect,
}: {
  label?: string;
  current: YearMonth;
  onSelect: (m: YearMonth) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity
        style={styles.monthLabelBtn}
        activeOpacity={0.7}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Jump to a month"
      >
        <Text style={styles.monthLabel}>{label}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} style={styles.monthChevron} />
      </TouchableOpacity>
      <MonthJumpSheet
        visible={open}
        onClose={() => setOpen(false)}
        current={current}
        onSelect={(m) => {
          setOpen(false);
          // Defer the jump a frame: batched with setOpen, the sheet's dismissal
          // couldn't commit until the host's (possibly heavy) jump render
          // finished, so the sheet visibly hung open. This way the close paints
          // first and the host catches up behind the fade.
          requestAnimationFrame(() => onSelect(m));
        }}
      />
    </>
  );
});

const styles = StyleSheet.create({
  monthLabelBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  monthLabel: { fontSize: 20, fontWeight: '700', color: colors.text },
  monthChevron: { marginLeft: 4, marginTop: 3 },
  yearRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, marginBottom: spacing.md,
  },
  yearBtn: { padding: spacing.xs },
  yearText: { fontSize: 20, fontWeight: '700', color: colors.text },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: spacing.md },
  monthCell: {
    width: '33.33%', paddingVertical: spacing.md, alignItems: 'center',
    borderRadius: radius.md,
  },
  monthCellCurrent: { backgroundColor: colors.primary },
  monthText: { fontSize: 16, fontWeight: '600', color: colors.text },
  monthTextToday: { color: colors.primary },
  monthTextCurrent: { color: '#fff', fontWeight: '700' },
});
