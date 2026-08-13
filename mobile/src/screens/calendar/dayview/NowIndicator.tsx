import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '../../../components/Text';
import { colors } from '../../../theme';
import { GUTTER, PX_PER_MIN, nowBadgeLabel, nowMinutes } from './dayViewLayout';

// The current-time line (app primary colour), rendered inside the hour grid's
// scroll content when today is visible. Isolated so its minute tick
// re-renders only this leaf, never the grid. Apple's treatment, recoloured to
// the app accent: a time badge in the gutter, a dot + solid line across
// today's column, and a dimmer line across the rest of the row (visible in
// multi-day).
export default function NowIndicator({
  colLeft,
  colWidth,
  topPad,
}: {
  colLeft: number; // today's column x within the grid content (px, incl. gutter)
  colWidth: number;
  topPad: number; // the grid's vertical content padding
}) {
  const [minutes, setMinutes] = useState(() => nowMinutes(new Date()));

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    // First tick on the next minute boundary, then every minute — like Apple.
    const align = setTimeout(() => {
      setMinutes(nowMinutes(new Date()));
      interval = setInterval(() => setMinutes(nowMinutes(new Date())), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);

  const top = topPad + minutes * PX_PER_MIN;

  return (
    <View style={[styles.row, { top: top - 10 }]} pointerEvents="none">
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{nowBadgeLabel(minutes)}</Text>
      </View>
      {/* Dim line across the whole row; solid line + dot over today's column. */}
      <View style={styles.dimLine} />
      <View style={[styles.line, { left: colLeft, width: colWidth }]} />
      <View style={[styles.dot, { left: colLeft - 3 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0, height: 20, justifyContent: 'center' },
  badge: {
    position: 'absolute',
    left: 2,
    width: GUTTER - 8,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  dimLine: { position: 'absolute', left: GUTTER, right: 0, height: 1, backgroundColor: colors.primary, opacity: 0.35 },
  line: { position: 'absolute', height: 2, backgroundColor: colors.primary, borderRadius: 1 },
  dot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
});
