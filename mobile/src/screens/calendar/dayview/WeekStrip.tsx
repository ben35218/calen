import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, useWindowDimensions, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { ymd } from '../../../lib/calendar';
import { colors, spacing } from '../../../theme';
import {
  addDays,
  selectionCols,
  weekEpoch,
  weekForIndex,
  weekIndexFor,
  WEEK_COUNT,
} from './dayViewLayout';

const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const WEEK_STRIP_H = 68;
const CIRCLE = 38;

// The Apple-style week strip above the day grid: weekday letters + a paging
// row of date numbers. Today's number is tinted the app primary (a filled
// primary circle when it's the anchor); a non-today anchor gets a white
// circle; in multi-day mode a grey pill spans the visible pair. Swiping pages
// week-by-week and re-anchors to the same weekday in the new week.
export default function WeekStrip({
  anchor,
  dayCount,
  onSelectDate,
}: {
  anchor: string;
  dayCount: 1 | 2;
  onSelectDate: (date: string) => void;
}) {
  const { width } = useWindowDimensions();
  const cellW = width / 7;
  const todayStr = ymd(new Date());
  // The paging window is fixed at mount so indices stay stable; crossing
  // midnight mid-session only shifts which number is tinted red.
  const epoch = useMemo(() => weekEpoch(ymd(new Date())), []);
  const anchorIndex = weekIndexFor(anchor, epoch);
  const anchorWeekday = new Date(anchor + 'T12:00:00').getDay();

  const listRef = useRef<FlatList<number>>(null);
  // The page the strip is actually sitting on, so an external anchor change
  // (day swipe crossing a week edge, Today) can page the strip to match
  // without re-triggering onSelectDate from the settle handler.
  const shownIndex = useRef(anchorIndex);

  useEffect(() => {
    if (shownIndex.current !== anchorIndex) {
      shownIndex.current = anchorIndex;
      listRef.current?.scrollToIndex({ index: anchorIndex, animated: true });
    }
  }, [anchorIndex]);

  const onSettle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / width);
      if (idx === shownIndex.current) return;
      shownIndex.current = idx;
      // Keep the weekday, move the week — Apple's strip-paging behavior.
      onSelectDate(addDays(weekForIndex(idx, epoch)[0], anchorWeekday));
    },
    [width, epoch, anchorWeekday, onSelectDate]
  );

  const renderWeek = useCallback(
    ({ item: index }: { item: number }) => {
      const days = weekForIndex(index, epoch);
      const sel = index === anchorIndex ? selectionCols(anchor, dayCount) : [];
      const pill = sel.length > 1;
      return (
        <View style={[styles.week, { width }]}>
          {pill ? (
            <View
              style={[
                styles.pairPill,
                { left: sel[0] * cellW + (cellW - CIRCLE) / 2, width: (sel[1] - sel[0]) * cellW + CIRCLE },
              ]}
            />
          ) : null}
          {days.map((d, col) => {
            const isToday = d === todayStr;
            const isAnchor = index === anchorIndex && d === anchor;
            const selected = sel.includes(col);
            return (
              <TouchableOpacity
                key={d}
                style={[styles.cell, { width: cellW }]}
                onPress={() => onSelectDate(d)}
                accessibilityLabel={`Show ${d}`}
              >
                <View
                  style={[
                    styles.circle,
                    isAnchor && (isToday ? styles.circleToday : styles.circleAnchor),
                    !isAnchor && selected && !pill && styles.circleAnchor,
                  ]}
                >
                  <Text
                    style={[
                      styles.num,
                      selected && styles.numSelected,
                      isToday && styles.numToday,
                      isAnchor && (isToday ? styles.numOnAccent : styles.numOnWhite),
                    ]}
                  >
                    {Number(d.slice(8))}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      );
    },
    [epoch, anchorIndex, anchor, dayCount, cellW, width, todayStr, onSelectDate]
  );

  const data = useMemo(() => Array.from({ length: WEEK_COUNT }, (_, i) => i), []);

  return (
    <View style={styles.strip}>
      <View style={styles.letters}>
        {LETTERS.map((l, i) => (
          <Text key={i} style={[styles.letter, { width: cellW }]}>{l}</Text>
        ))}
      </View>
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(i) => String(i)}
        renderItem={renderWeek}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={anchorIndex}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        onMomentumScrollEnd={onSettle}
        onScrollToIndexFailed={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: WEEK_STRIP_H, backgroundColor: colors.background },
  letters: { flexDirection: 'row' },
  letter: { textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.text },
  week: { flexDirection: 'row', paddingTop: spacing.xs },
  cell: { alignItems: 'center' },
  circle: { width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, alignItems: 'center', justifyContent: 'center' },
  circleAnchor: { backgroundColor: '#fff' },
  circleToday: { backgroundColor: colors.primary },
  // Grey capsule behind the visible multi-day pair.
  pairPill: {
    position: 'absolute',
    top: spacing.xs,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    backgroundColor: '#3A3A3C',
  },
  num: { fontSize: 20, fontWeight: '600', color: colors.textMuted },
  numSelected: { color: colors.text },
  numToday: { color: colors.primary },
  numOnWhite: { color: '#000', fontWeight: '700' },
  numOnAccent: { color: '#fff', fontWeight: '700' },
});
