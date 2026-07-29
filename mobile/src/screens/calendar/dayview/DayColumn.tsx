import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { colors, radius } from '../../../theme';
import { DayNav } from './dayNav';
import { LaidBlock, DAY_MIN, PX_PER_MIN, timeLabel } from './dayViewLayout';

// One date's absolutely-positioned event blocks inside the hour grid. Apple's
// block look: translucent calendar-colour fill, a solid colour bar on the
// left edge, and the title set in the calendar colour.
const DayColumn = React.memo(function DayColumn({
  date,
  blocks,
  width,
}: {
  date: string;
  blocks: LaidBlock[];
  width: number;
}) {
  const navigation = useNavigation<DayNav>();
  return (
    <View style={{ width, height: DAY_MIN * PX_PER_MIN }}>
      {blocks.map((b) => {
        const left = b.leftFrac * width + 1;
        const w = Math.max(24, b.widthFrac * width - 3);
        const showMeta = b.height >= 40;
        return (
          <TouchableOpacity
            key={b.key}
            activeOpacity={0.75}
            onPress={() => navigation.navigate('EventDetail', { eventId: b.eventId, date })}
            style={[
              styles.block,
              { top: b.top + 1, height: Math.max(26, b.height - 2), left, width: w, backgroundColor: b.color + '2E', borderLeftColor: b.color },
              b.faded && styles.faded,
            ]}
          >
            <Text style={[styles.title, { color: b.color }, b.strike && styles.strike]} numberOfLines={showMeta ? 2 : 1}>
              {b.title}
            </Text>
            {showMeta ? (
              <Text style={styles.meta} numberOfLines={1}>
                {[timeLabel(b.startMin), b.location].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
});

export default DayColumn;

const styles = StyleSheet.create({
  block: {
    position: 'absolute',
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    paddingHorizontal: 5,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  faded: { opacity: 0.5 },
  title: { fontSize: 12, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through' },
  meta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
});
