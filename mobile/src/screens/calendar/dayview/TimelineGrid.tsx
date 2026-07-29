import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { colors } from '../../../theme';
import { TodayHandle } from '../todayHandle';
import DayColumn from './DayColumn';
import NowIndicator from './NowIndicator';
import WeatherRail from './WeatherRail';
import { DAY_MIN, GUTTER, HOUR_H, LaidBlock, PX_PER_MIN, RailMark, hourLabel, initialScrollY, nowMinutes } from './dayViewLayout';

const TOP_PAD = 10;
const BOTTOM_PAD = 32;

// The scrollable 24h hour grid: gutter labels + hairline rules, one DayColumn
// per visible date, and the now-line when today is on screen. One ScrollView
// instance survives day swipes and the single↔multi switch, so the vertical
// offset carries across both. Auto-scrolls once on first layout — to the
// now-line for today, else just above the first event, else 8 AM.
const TimelineGrid = forwardRef<
  TodayHandle,
  {
    dates: string[];
    blocksByDate: LaidBlock[][];
    wxByDate: RailMark[][];
    todayCol: number | null;
    dataReady: boolean;
  }
>(function TimelineGrid({ dates, blocksByDate, wxByDate, todayCol, dataReady }, ref) {
  const scrollRef = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const autoScrolled = useRef(false);

  useImperativeHandle(ref, () => ({
    scrollToToday: (animated = true) => {
      scrollRef.current?.scrollTo({ y: initialScrollY(nowMinutes(new Date()), [], viewportH), animated });
    },
  }));

  // One-time initial position. Today keys off the clock so it never waits for
  // data; other days wait for the first load so the first event is known.
  useEffect(() => {
    if (autoScrolled.current || !viewportH) return;
    if (todayCol == null && !dataReady) return;
    autoScrolled.current = true;
    const y = initialScrollY(todayCol != null ? nowMinutes(new Date()) : null, blocksByDate[0] ?? [], viewportH);
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [viewportH, dataReady, todayCol, blocksByDate]);

  const colW = width > 0 ? (width - GUTTER) / dates.length : 0;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      onLayout={(e) => setViewportH(e.nativeEvent.layout.height)}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{ height: TOP_PAD + DAY_MIN * PX_PER_MIN + BOTTOM_PAD }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {Array.from({ length: 25 }, (_, h) => (
          <View key={h} style={[styles.hourLine, { top: TOP_PAD + h * HOUR_H - 7 }]}>
            <Text style={styles.hourLabel}>{h < 24 ? hourLabel(h) : ''}</Text>
            <View style={styles.hourRule} />
          </View>
        ))}

        {width > 0 ? (
          <View style={[styles.columns, { top: TOP_PAD }]}>
            {dates.map((d, i) => (
              <View key={d} style={[styles.col, i > 0 && styles.colDivider]}>
                {/* Rail first so event blocks render over the ambient weather. */}
                <WeatherRail marks={wxByDate[i] ?? []} />
                <DayColumn date={d} blocks={blocksByDate[i] ?? []} width={colW - (i > 0 ? StyleSheet.hairlineWidth : 0)} />
              </View>
            ))}
          </View>
        ) : null}

        {width > 0 && todayCol != null ? (
          <NowIndicator colLeft={GUTTER + todayCol * colW} colWidth={colW} topPad={TOP_PAD} />
        ) : null}
      </View>
    </ScrollView>
  );
});

export default TimelineGrid;

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  hourLine: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: GUTTER - 6, textAlign: 'right', fontSize: 11, color: colors.textMuted, marginRight: 6 },
  hourRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  columns: { position: 'absolute', left: GUTTER, right: 0, flexDirection: 'row' },
  col: { flex: 1 },
  colDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
});
